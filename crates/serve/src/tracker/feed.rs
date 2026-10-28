//! The tracker's event feed (rag-t0036): `GET /tracker/{project}/events/ws`, a
//! WebSocket that sends one text frame per event as it is committed, and
//! `GET /tracker/{project}/events`, the same events read once.
//!
//! It exists so an idle manager agent is woken by the owner's actions on the
//! web without polling: Claude Code's `Monitor` tool opens the socket and turns
//! each text frame into a notification. A monitor lives at most 30 minutes and
//! is then re-armed with the last event id it saw (`since`), so a reconnect
//! loses and repeats nothing. The contract is `specs/tracker/api.md` §
//! *The event feed*; the store's half (the broadcast channel, publishing after
//! commit, the replay) is `rag_core::tracker::feed`.
//!
//! Text frames coalesce a burst (rag-t0039): the events of one project and
//! surface committed within `coalesce` seconds (default
//! [`BURST_WINDOW_SECS`]) of the first share one frame, so a drag reorder of
//! five items wakes a monitoring agent once, not five times. The frame starts
//! with the burst's last event id, so resuming by id stays exact. JSON frames
//! are never coalesced: a program pays nothing per frame.

use std::time::Duration;

use axum::{
    extract::{
        ws::{rejection::WebSocketUpgradeRejection, CloseFrame, Message, WebSocket},
        Path, State, WebSocketUpgrade,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use tokio::sync::broadcast::error::RecvError;

use rag_core::tracker::{
    burst_line, joins_burst, EventKind, FeedEvent, FeedFilter, Surface, TrackerStore,
    BURST_WINDOW_SECS, DEFAULT_FEED_KINDS,
};

use super::{ok, ApiError, ApiResult, St, Q};

/// A heartbeat ping this often, so an idle socket is not reaped by anything
/// between the two ends and a dead peer is found by the failed send.
pub(super) const PING_EVERY: Duration = Duration::from_secs(30);

/// A frame that cannot be written in this long means the client stopped
/// reading; it is dropped rather than waited on.
const SEND_TIMEOUT: Duration = Duration::from_secs(10);

/// The most events a feed replays from `since` before it goes live. More is a
/// firehose to a notification-per-frame client: it is refused, and the caller
/// pages through them with the one-shot read and resumes from the last.
pub(super) const MAX_REPLAY: i64 = 500;

/// The replay reads the table in pages this size.
const REPLAY_PAGE: i64 = 200;

/// The longest burst window a feed may ask for, in seconds.
const MAX_COALESCE_SECS: u64 = 60;

/// The one-shot read's default and largest `limit`.
const READ_LIMIT_DEFAULT: i64 = 100;
const READ_LIMIT_MAX: i64 = 1000;

/// WebSocket close codes the feed ends with (RFC 6455 § 7.4.1). Each close
/// carries the last event id the client was sent, so it can resume.
const CLOSE_LAGGED: u16 = 1013; // Try Again Later
const CLOSE_RESTART: u16 = 1012; // Service Restart
const CLOSE_ERROR: u16 = 1011; // Internal Error

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct FeedQuery {
    since: Option<i64>,
    surface: Option<String>,
    kinds: Option<String>,
    format: Option<String>,
    limit: Option<i64>,
    coalesce: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Format {
    Text,
    Json,
}

/// The filter a query names: the project from the path (`*` for every
/// project), the surface (default `web`, the owner's actions; `any` for both)
/// and the kinds (default [`DEFAULT_FEED_KINDS`]; `all` for every kind).
fn filter_of(project: &str, q: &FeedQuery) -> Result<FeedFilter, ApiError> {
    let project = if project == "*" {
        None
    } else {
        rag_core::tracker::validate_project(project)?;
        Some(project.to_string())
    };
    let surfaces = match q.surface.as_deref().map(str::trim) {
        None | Some("") | Some("web") => Some(vec![Surface::Web]),
        Some("mcp") => Some(vec![Surface::Mcp]),
        Some("any") => None,
        Some(other) => {
            return Err(ApiError::BadRequest(format!(
                "invalid surface {other:?} (expected web|mcp|any)"
            )))
        }
    };
    let kinds = match q.kinds.as_deref().map(str::trim) {
        None | Some("") => Some(DEFAULT_FEED_KINDS.to_vec()),
        Some("all") => None,
        Some(list) => {
            let mut kinds = Vec::new();
            for k in list.split(',').map(str::trim).filter(|k| !k.is_empty()) {
                let kind: EventKind = k.parse()?;
                if !kinds.contains(&kind) {
                    kinds.push(kind);
                }
            }
            if kinds.is_empty() {
                return Err(ApiError::BadRequest(
                    "kinds names no event kind (omit it for the default, or give all)".into(),
                ));
            }
            Some(kinds)
        }
    };
    Ok(FeedFilter {
        project,
        surfaces,
        kinds,
    })
}

fn format_of(q: &FeedQuery) -> Result<Format, ApiError> {
    match q.format.as_deref().map(str::trim) {
        None | Some("") | Some("text") => Ok(Format::Text),
        Some("json") => Ok(Format::Json),
        Some(other) => Err(ApiError::BadRequest(format!(
            "invalid format {other:?} (expected text|json)"
        ))),
    }
}

/// The burst window, in seconds (rag-t0039): `coalesce`, default
/// [`BURST_WINDOW_SECS`] for text frames and 0 (one frame per event) for JSON,
/// which never coalesces.
fn coalesce_of(q: &FeedQuery, format: Format) -> Result<u64, ApiError> {
    match (q.coalesce, format) {
        (None, Format::Text) => Ok(BURST_WINDOW_SECS),
        (None | Some(0), Format::Json) => Ok(0),
        (Some(_), Format::Json) => Err(ApiError::BadRequest(
            "coalesce is for text frames; JSON frames are one per event".into(),
        )),
        (Some(c), Format::Text) if c <= MAX_COALESCE_SECS => Ok(c),
        (Some(_), Format::Text) => Err(ApiError::BadRequest(format!(
            "coalesce is 0 to {MAX_COALESCE_SECS} seconds"
        ))),
    }
}

fn since_of(q: &FeedQuery) -> Result<Option<i64>, ApiError> {
    match q.since {
        Some(s) if s < 0 => Err(ApiError::BadRequest(
            "since is an event id, 0 or more".into(),
        )),
        s => Ok(s),
    }
}

/// `GET /tracker/{project}/events`: the events after `since` that pass the
/// filter, oldest first, at most `limit`. Without `since` the list is empty and
/// `latest_event_id` is where a feed that wants only what comes next starts.
pub(super) async fn events_read(
    State(api): St,
    Path(project): Path<String>,
    Q(q): Q<FeedQuery>,
) -> ApiResult {
    let store = api.store()?;
    let filter = filter_of(&project, &q)?;
    if q.format.is_some() {
        return Err(ApiError::BadRequest(
            "format is for the feed (/events/ws); this read is always JSON".into(),
        ));
    }
    if q.coalesce.is_some() {
        return Err(ApiError::BadRequest(
            "coalesce is for the feed (/events/ws); this read lists every event".into(),
        ));
    }
    let since = since_of(&q)?;
    let limit = match q.limit {
        None => READ_LIMIT_DEFAULT,
        Some(l) if (1..=READ_LIMIT_MAX).contains(&l) => l,
        Some(_) => {
            return Err(ApiError::BadRequest(format!(
                "limit is 1 to {READ_LIMIT_MAX}"
            )))
        }
    };
    // The latest id is read first: an event committed after it is after
    // `next_since` too, so paging on never skips one.
    let latest = store.latest_event_id().await?;
    let (events, more) = match since {
        None => (Vec::new(), false),
        Some(since) => {
            let mut events = store.events_after(&filter, since, Some(limit + 1)).await?;
            let more = events.len() as i64 > limit;
            events.truncate(limit as usize);
            (events, more)
        }
    };
    // Where to read (or start a feed) from next. With more to come, after the
    // last event returned; otherwise past everything scanned too: every id up
    // to `latest` was committed before the read, so none of those not returned
    // matches.
    let last_returned = events.last().map(|e| e.event_id);
    let next_since = if more {
        last_returned.unwrap_or(latest)
    } else {
        latest
            .max(since.unwrap_or(0))
            .max(last_returned.unwrap_or(0))
    };
    ok(&serde_json::json!({
        "events": events,
        "latest_event_id": latest,
        "next_since": next_since,
        "more": more,
    }))
}

/// `GET /tracker/{project}/events/ws`: replay the events after `since`, then
/// send each new one as it is committed, until the client goes, falls behind or
/// the server stops.
pub(super) async fn events_ws(
    State(api): St,
    Path(project): Path<String>,
    Q(q): Q<FeedQuery>,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Result<Response, ApiError> {
    let store = api.store()?.clone();
    let filter = filter_of(&project, &q)?;
    let format = format_of(&q)?;
    let window = coalesce_of(&q, format)?;
    let since = since_of(&q)?;
    if q.limit.is_some() {
        return Err(ApiError::BadRequest(
            "limit is for the one-shot read (/events), not the feed".into(),
        ));
    }
    if let Some(since) = since {
        let backlog = store.count_events_after(&filter, since).await?;
        if backlog > MAX_REPLAY {
            return Err(ApiError::BadRequest(format!(
                "{backlog} events match after {since}, more than the feed replays ({MAX_REPLAY}); \
                 read them with GET /tracker/{project}/events?since={since} and resume from its next_since"
            )));
        }
    }
    let ws = ws.map_err(|e| {
        ApiError::Status(
            StatusCode::UPGRADE_REQUIRED,
            format!(
                "this route is a WebSocket ({}); read the events once with GET /tracker/{project}/events",
                e.body_text()
            ),
        )
    })?;
    Ok(ws
        .on_upgrade(move |socket| run_feed(socket, store, filter, since, format, window))
        .into_response())
}

fn frame(e: &FeedEvent, format: Format) -> String {
    match format {
        Format::Text => e.line(),
        // An event always serialises; the fallback keeps the frame one line.
        Format::Json => serde_json::to_string(e).unwrap_or_else(|_| e.line()),
    }
}

/// Send the burst held in `pending` as one frame (a burst of one is that
/// event's own frame) and empty it. `sent` moves to its last id. False when
/// the client is gone.
async fn flush(
    socket: &mut WebSocket,
    pending: &mut Vec<FeedEvent>,
    format: Format,
    sent: &mut i64,
) -> bool {
    let Some(last) = pending.last().map(|e| e.event_id) else {
        return true;
    };
    let text = match (format, pending.as_slice()) {
        (_, [one]) => frame(one, format),
        (Format::Text, many) => burst_line(many),
        // JSON never coalesces (its window is 0), so this is not reached; one
        // line per event keeps it correct if it were.
        (Format::Json, many) => many
            .iter()
            .map(|e| frame(e, format))
            .collect::<Vec<_>>()
            .join("\n"),
    };
    pending.clear();
    if !send(socket, Message::Text(text.into())).await {
        return false;
    }
    *sent = last;
    true
}

/// Send one frame, giving up on a client that does not take it in time.
async fn send(socket: &mut WebSocket, msg: Message) -> bool {
    matches!(
        tokio::time::timeout(SEND_TIMEOUT, socket.send(msg)).await,
        Ok(Ok(()))
    )
}

async fn close(socket: &mut WebSocket, code: u16, reason: String) {
    // A close reason is at most 123 bytes; every reason here is far shorter.
    let frame = CloseFrame {
        code,
        reason: reason.into(),
    };
    let _ = send(socket, Message::Close(Some(frame))).await;
}

async fn run_feed(
    mut socket: WebSocket,
    store: TrackerStore,
    filter: FeedFilter,
    since: Option<i64>,
    format: Format,
    window: u64,
) {
    // Subscribe before reading the table: an event committed from here on is
    // on the channel, one committed before is in the replay, and one in both
    // is dropped below by its id.
    let mut rx = store.subscribe();
    let mut closing = store.feed_closing();

    // `cursor`: the last event id this client has taken in, sent or held in
    // the open burst (or skipped as already known). Every live event at or
    // below it is a duplicate. `sent`: the last id it has been sent, where a
    // close tells it to resume.
    let mut cursor = match since {
        Some(s) => s,
        None => match store.latest_event_id().await {
            Ok(latest) => latest,
            Err(e) => {
                tracing::warn!(error = %e, "tracker feed: could not read the latest event id");
                close(
                    &mut socket,
                    CLOSE_ERROR,
                    "could not read the event log".into(),
                )
                .await;
                return;
            }
        },
    };
    let mut sent = cursor;
    // The open burst: events taken in but not yet sent, all joining the first.
    let mut pending: Vec<FeedEvent> = Vec::new();
    loop {
        let page = match store.events_after(&filter, cursor, Some(REPLAY_PAGE)).await {
            Ok(page) => page,
            Err(e) => {
                tracing::warn!(error = %e, "tracker feed: replay failed");
                if !flush(&mut socket, &mut pending, format, &mut sent).await {
                    return;
                }
                close(
                    &mut socket,
                    CLOSE_ERROR,
                    format!("replay failed; resume with since={sent}"),
                )
                .await;
                return;
            }
        };
        let full = page.len() as i64 == REPLAY_PAGE;
        // The replay coalesces by the events' own timestamps, as the live side
        // does by their arrival.
        for e in page {
            cursor = e.event_id;
            let joins = pending
                .first()
                .is_some_and(|first| joins_burst(first, &e, window));
            if !joins && !flush(&mut socket, &mut pending, format, &mut sent).await {
                return;
            }
            pending.push(e);
        }
        if !full {
            break;
        }
    }
    if !flush(&mut socket, &mut pending, format, &mut sent).await {
        return;
    }

    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + PING_EVERY, PING_EVERY);
    let window = Duration::from_secs(window);
    // When the open burst is sent: its window after its first event arrived.
    let mut deadline: Option<tokio::time::Instant> = None;
    loop {
        let flush_at = deadline.unwrap_or_else(|| tokio::time::Instant::now() + PING_EVERY);
        tokio::select! {
            got = rx.recv() => match got {
                Ok(e) => {
                    if e.event_id <= cursor || !filter.matches(&e) {
                        continue;
                    }
                    cursor = e.event_id;
                    let e = FeedEvent::clone(&e);
                    let joins = pending
                        .first()
                        .is_some_and(|first| joins_burst(first, &e, window.as_secs()));
                    if !joins && !flush(&mut socket, &mut pending, format, &mut sent).await {
                        return;
                    }
                    if window.is_zero() {
                        pending.push(e);
                        if !flush(&mut socket, &mut pending, format, &mut sent).await {
                            return;
                        }
                        deadline = None;
                        continue;
                    }
                    if pending.is_empty() {
                        deadline = Some(tokio::time::Instant::now() + window);
                    }
                    pending.push(e);
                }
                Err(RecvError::Lagged(missed)) => {
                    tracing::info!(missed, cursor, "tracker feed: client lagged, disconnecting");
                    if !flush(&mut socket, &mut pending, format, &mut sent).await {
                        return;
                    }
                    close(
                        &mut socket,
                        CLOSE_LAGGED,
                        format!("lagged {missed} events behind; resume with since={sent}"),
                    )
                    .await;
                    return;
                }
                Err(RecvError::Closed) => {
                    if !flush(&mut socket, &mut pending, format, &mut sent).await {
                        return;
                    }
                    close(&mut socket, CLOSE_RESTART, format!("feed closed; resume with since={sent}")).await;
                    return;
                }
            },
            _ = tokio::time::sleep_until(flush_at), if deadline.is_some() => {
                deadline = None;
                if !flush(&mut socket, &mut pending, format, &mut sent).await {
                    return;
                }
            }
            msg = socket.recv() => match msg {
                // The client closed or the connection failed; anything it sends
                // (a pong, text) is ignored.
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return,
                Some(Ok(_)) => {}
            },
            _ = ping.tick() => {
                if !send(&mut socket, Message::Ping(Default::default())).await {
                    return;
                }
            }
            _ = closing.changed() => {
                if !flush(&mut socket, &mut pending, format, &mut sent).await {
                    return;
                }
                close(
                    &mut socket,
                    CLOSE_RESTART,
                    format!("server restarting; resume with since={sent}"),
                )
                .await;
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests;
