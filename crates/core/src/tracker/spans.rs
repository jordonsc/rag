//! Item spans (`specs/velocity/master.md` D21–D23): a ticket's history as
//! intervals, one row a ticket a state, so every velocity and report figure is a
//! range read rather than a replay of the event log.
//!
//! Three tracks, each with at most one open span a ticket (the unique partial
//! index `idx_item_spans_open`):
//!
//! * `status`: always exactly one open span, its state the ticket's status
//!   (`done` and `cancelled` included), or [`FROZEN`] while the ticket is frozen
//!   in a phase (spec:roadmap D21): frozen is a span state, never an item status;
//! * `blocked`: open while the ticket is blocked and not frozen, its state
//!   `blocked`;
//! * `draft`: open while the ticket is a draft, its state `draft`.
//!
//! [`sync_item_spans`] keeps them in step: `append_event` calls it after every
//! item event, in the writing transaction, and it reconciles the open spans with
//! the item's row as it now is. No write path has to say what it changed, and a
//! write that changes none of the four (status, block, draft flag, frozen flag:
//! a note, a move, an edit, a link) touches nothing. [`backfill`] builds them once for a database written before
//! spans existed.

use std::collections::HashMap;

use serde_json::Value;
use sqlx::SqliteConnection;

use super::TResult;

/// The track a ticket's status runs on; its spans' state is the status.
pub(super) const STATUS: &str = "status";
/// The track a ticket's block runs on; its spans' state is `blocked`.
pub(super) const BLOCKED: &str = "blocked";
/// The track a ticket's draft flag runs on; its spans' state is `draft`.
pub(super) const DRAFT: &str = "draft";

/// The `status` track's state while a ticket is frozen in a phase (spec:roadmap
/// D21). So a freeze closes the `pending` span and a release opens a new one,
/// and every figure that names its statuses leaves frozen time out.
pub(super) const FROZEN: &str = "frozen";

/// The open span each track should hold for a ticket with this status, block,
/// draft flag and frozen flag: `None` where the track holds nothing.
fn wanted(
    status: &str,
    blocked: bool,
    draft: bool,
    frozen: bool,
) -> [(&'static str, Option<&str>); 3] {
    [
        (STATUS, Some(if frozen { FROZEN } else { status })),
        (BLOCKED, (blocked && !frozen).then_some(BLOCKED)),
        (DRAFT, draft.then_some(DRAFT)),
    ]
}

/// Reconcile `item_id`'s open spans with its row (D22), in the caller's
/// transaction: each track whose open span disagrees with the row is closed at
/// `ts` by `event_id`, and the span the row calls for is opened from them. A
/// track that agrees is left alone, so a write that changed none of status,
/// block, draft and frozen writes nothing. A ticket that is gone has nothing to
/// sync.
pub(super) async fn sync_item_spans(
    conn: &mut SqliteConnection,
    project: &str,
    item_id: &str,
    event_id: i64,
    ts: &str,
) -> TResult<()> {
    let row: Option<(String, i64, i64, i64)> =
        sqlx::query_as("SELECT status, blocked, draft, frozen FROM items WHERE id = ?")
            .bind(item_id)
            .fetch_optional(&mut *conn)
            .await?;
    let Some((status, blocked, draft, frozen)) = row else {
        return Ok(());
    };
    let open: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT span_id, track, state FROM item_spans WHERE item_id = ? AND ended_at IS NULL",
    )
    .bind(item_id)
    .fetch_all(&mut *conn)
    .await?;
    for (track, want) in wanted(&status, blocked != 0, draft != 0, frozen != 0) {
        let have = open.iter().find(|(_, t, _)| t == track);
        if have.map(|(_, _, s)| s.as_str()) == want {
            continue;
        }
        if let Some((span_id, _, _)) = have {
            sqlx::query("UPDATE item_spans SET ended_at = ?, ended_event = ? WHERE span_id = ?")
                .bind(ts)
                .bind(event_id)
                .bind(span_id)
                .execute(&mut *conn)
                .await?;
        }
        if let Some(state) = want {
            insert_span(
                conn,
                &Span {
                    project: project.to_string(),
                    item_id: item_id.to_string(),
                    track,
                    state: state.to_string(),
                    started_at: ts.to_string(),
                    started_event: event_id,
                    ended_at: None,
                    ended_event: None,
                },
            )
            .await?;
        }
    }
    Ok(())
}

/// One span row, as the backfill builds it.
#[derive(Debug, Clone)]
struct Span {
    project: String,
    item_id: String,
    track: &'static str,
    state: String,
    started_at: String,
    started_event: i64,
    ended_at: Option<String>,
    ended_event: Option<i64>,
}

async fn insert_span(conn: &mut SqliteConnection, s: &Span) -> TResult<()> {
    sqlx::query(
        "INSERT INTO item_spans (project, item_id, track, state, started_at, ended_at, \
         started_event, ended_event) VALUES (?,?,?,?,?,?,?,?)",
    )
    .bind(&s.project)
    .bind(&s.item_id)
    .bind(s.track)
    .bind(&s.state)
    .bind(&s.started_at)
    .bind(&s.ended_at)
    .bind(s.started_event)
    .bind(s.ended_event)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// What [`backfill`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Backfill {
    /// The tickets it built spans for: every one in the database.
    pub tickets: usize,
    /// The span rows it wrote, open and closed.
    pub spans: usize,
    /// The tickets whose replayed state disagreed with their row (or that had
    /// no events at all), whose open spans were set from the row.
    pub corrected: usize,
}

/// A ticket's state as the replay has it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct State {
    status: String,
    blocked: bool,
    draft: bool,
    frozen: bool,
}

/// One ticket's replay: the state so far, its open spans and the spans it has
/// closed.
struct Replay {
    project: String,
    item_id: String,
    state: Option<State>,
    open: Vec<Span>,
    closed: Vec<Span>,
}

impl Replay {
    /// Close each open span that disagrees with `state` and open what it calls
    /// for, at `ts` by `event_id`: [`sync_item_spans`] in memory.
    fn reconcile(&mut self, state: &State, event_id: i64, ts: &str) {
        for (track, want) in wanted(&state.status, state.blocked, state.draft, state.frozen) {
            let at = self.open.iter().position(|s| s.track == track);
            if at.map(|i| self.open[i].state.as_str()) == want {
                continue;
            }
            if let Some(i) = at {
                let mut span = self.open.remove(i);
                span.ended_at = Some(ts.to_string());
                span.ended_event = Some(event_id);
                self.closed.push(span);
            }
            if let Some(state) = want {
                self.open.push(Span {
                    project: self.project.clone(),
                    item_id: self.item_id.clone(),
                    track,
                    state: state.to_string(),
                    started_at: ts.to_string(),
                    started_event: event_id,
                    ended_at: None,
                    ended_event: None,
                });
            }
        }
        self.state = Some(state.clone());
    }
}

/// The JSON object an event column holds, or an empty one when it is absent or
/// unreadable.
fn object(raw: Option<&str>) -> Value {
    raw.and_then(|r| serde_json::from_str(r).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Default::default()))
}

/// The state after one event, from the state before it (D23). A `create` gives
/// the first status (`pending` unless it says otherwise), the draft flag and the
/// frozen flag; any other event changes what its `fields` set of `status`,
/// `blocked`, `draft` and `frozen`.
/// A ticket whose first event is not its create starts from that event's prior
/// values (`fields_before`), or as a new ticket would, and the check against its
/// row puts right whatever that guessed wrong.
fn step(prev: Option<&State>, kind: &str, fields: &Value, before: &Value) -> State {
    let text = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let flag = |v: &Value, k: &str| v.get(k).and_then(Value::as_bool);
    let mut s = match (kind, prev) {
        ("create", _) => State {
            status: text(fields, "status").unwrap_or_else(|| "pending".into()),
            blocked: false,
            draft: flag(fields, "draft").unwrap_or(false),
            frozen: flag(fields, "frozen").unwrap_or(false),
        },
        (_, Some(p)) => p.clone(),
        (_, None) => State {
            status: text(before, "status").unwrap_or_else(|| "pending".into()),
            blocked: flag(before, "blocked").unwrap_or(false),
            draft: flag(before, "draft").unwrap_or(false),
            frozen: flag(before, "frozen").unwrap_or(false),
        },
    };
    if kind != "create" {
        if let Some(status) = text(fields, "status") {
            s.status = status;
        }
        if let Some(blocked) = flag(fields, "blocked") {
            s.blocked = blocked;
        }
        if let Some(draft) = flag(fields, "draft") {
            s.draft = draft;
        }
        if let Some(frozen) = flag(fields, "frozen") {
            s.frozen = frozen;
        }
    }
    s
}

/// The one-time backfill (D23), in the caller's transaction: when `item_spans`
/// is empty and `items` is not, replay each ticket's events in `event_id` order
/// into closed spans and its final open ones, then check each ticket's replayed
/// state against its row. A ticket that disagrees (a status set without an
/// event, a history from before `fields` recorded it) has its open spans set
/// from the row, at its last event's `ts` (by that event), and is counted; its
/// closed spans before that point stay as replayed. A ticket with no events at
/// all gets its open spans from the row at its `updated_at`, with
/// `started_event` 0 (there is no event to name), and is counted too.
///
/// `None` when there was nothing to do: spans already exist (a database is
/// backfilled once), or there are no tickets.
pub(super) async fn backfill(conn: &mut SqliteConnection) -> TResult<Option<Backfill>> {
    let have_spans: Option<i64> = sqlx::query_scalar("SELECT 1 FROM item_spans LIMIT 1")
        .fetch_optional(&mut *conn)
        .await?;
    if have_spans.is_some() {
        return Ok(None);
    }
    type ItemRow = (String, String, String, i64, i64, i64, String);
    let items: Vec<ItemRow> = sqlx::query_as(
        "SELECT id, project, status, blocked, draft, frozen, updated_at FROM items \
         ORDER BY project, seq",
    )
    .fetch_all(&mut *conn)
    .await?;
    if items.is_empty() {
        return Ok(None);
    }
    type EventRow = (i64, String, String, String, String, Option<String>);
    let events: Vec<EventRow> = sqlx::query_as(
        "SELECT event_id, target_id, ts, kind, fields, fields_before FROM events \
         WHERE target_kind = 'item' ORDER BY event_id",
    )
    .fetch_all(&mut *conn)
    .await?;
    let mut by_item: HashMap<String, Vec<EventRow>> = HashMap::new();
    for e in events {
        by_item.entry(e.1.clone()).or_default().push(e);
    }

    let mut done = Backfill {
        tickets: 0,
        spans: 0,
        corrected: 0,
    };
    for (id, project, status, blocked, draft, frozen, updated_at) in items {
        let mut replay = Replay {
            project,
            item_id: id.clone(),
            state: None,
            open: Vec::new(),
            closed: Vec::new(),
        };
        let mut last: Option<(i64, String)> = None;
        for (event_id, _, ts, kind, fields, before) in by_item.remove(&id).unwrap_or_default() {
            let next = step(
                replay.state.as_ref(),
                &kind,
                &object(Some(&fields)),
                &object(before.as_deref()),
            );
            replay.reconcile(&next, event_id, &ts);
            last = Some((event_id, ts));
        }
        let row = State {
            status,
            blocked: blocked != 0,
            draft: draft != 0,
            frozen: frozen != 0,
        };
        if replay.state.as_ref() != Some(&row) {
            let (event_id, ts) = last.unwrap_or((0, updated_at));
            replay.reconcile(&row, event_id, &ts);
            done.corrected += 1;
        }
        done.tickets += 1;
        for span in replay.closed.iter().chain(replay.open.iter()) {
            insert_span(conn, span).await?;
            done.spans += 1;
        }
    }
    Ok(Some(done))
}
