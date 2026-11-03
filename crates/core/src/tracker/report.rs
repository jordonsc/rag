//! The velocity report (`specs/velocity/master.md` D16–D18, D27): the last 7
//! days' burn-down and a window's time in each state and mean times to
//! completion and to resolution, as `GET /tracker/{project}/report` answers
//! them. Every block but the burn-down follows the chosen window (R10, amended
//! by the owner 2026-11-03).
//!
//! Like the velocity read (`velocity.rs`), nothing is kept: every figure is
//! computed on request (D25) from two range reads of `item_spans`, with the
//! window's velocity read beside them in the same transaction.
//!
//! * [`SPANS_SQL`]: the spans that overlap the last 7 days, once
//!   (`idx_item_spans_project_ended`, for the closed spans that end in or after
//!   them and the open ones), each with whether it began with its ticket and
//!   whether its ticket was a draft when it began (`idx_item_spans_item`).
//! * [`HISTORY_SQL`]: the `status` spans of the tickets done in the window,
//!   however old (`idx_item_spans_item`), for the time since a ticket's last
//!   reopen.
//!
//! The rest is arithmetic in memory. Order within a second is the events'
//! (ledger rag-l0083): which span came first, and whether a draft covered the
//! event that started a span, compare event ids, never timestamps.
//!
//! **A ticket that is a draft now is in no figure** (D2, amended by the owner
//! 2026-11-03), whatever it did before it was made one: its spans are not read.
//! Publishing it brings its history back. A published ticket's time as a draft
//! does not count either: it is in no bucket's `remaining` for that time, is
//! `added` when it is first published, and is not `done` by a completion made
//! while it was one (as `velocity.rs` has it). A span that began while its
//! ticket was a draft counts from the publication, and not at all if it ended
//! under that draft; a stretch as a draft in the middle of a span is taken out
//! of its length.

use std::collections::{HashMap, HashSet};
use std::str::FromStr;

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use sqlx::SqliteConnection;

use super::spans::{BLOCKED, DRAFT, STATUS};
use super::velocity::{self, iso, unix, VelocityWindow};
use super::{validate_project, TResult, TrackerError, TrackerStore};

const HOUR: i64 = 3_600;

/// The statuses a ticket is `remaining` in (D5): in progress or pending,
/// whatever its block (D4). Deferred is in neither.
const REMAINING: [&str; 4] = ["pending", "failed", "in_progress", "review"];

/// The statuses whose time the report measures (D17), beside the `blocked`
/// track.
const TIMED: [&str; 4] = ["pending", "in_progress", "review", "deferred"];

/// The report's window (D27): the last 24 hours or the last 7 days, ending now,
/// as the widget's are (D10). 7 days unless asked. The burn-down does not follow
/// it (D16).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub enum ReportWindow {
    #[serde(rename = "24h")]
    Day,
    #[default]
    #[serde(rename = "7d")]
    Week,
}

impl ReportWindow {
    pub fn as_str(self) -> &'static str {
        match self {
            ReportWindow::Day => "24h",
            ReportWindow::Week => "7d",
        }
    }

    fn length(self) -> Duration {
        match self {
            ReportWindow::Day => Duration::days(1),
            ReportWindow::Week => Duration::days(7),
        }
    }
}

impl FromStr for ReportWindow {
    type Err = TrackerError;

    fn from_str(s: &str) -> TResult<Self> {
        match s {
            "24h" => Ok(ReportWindow::Day),
            "7d" => Ok(ReportWindow::Week),
            other => Err(TrackerError::Refused(format!(
                "unknown window `{other}` (24h or 7d)"
            ))),
        }
    }
}

/// The report (D27).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Report {
    pub project: String,
    pub window: ReportWindow,
    /// The window's start, RFC 3339 UTC to the second: `end` less the window.
    pub start: String,
    /// The window's end: when the report was computed.
    pub end: String,
    /// The window's velocity figures, as the widget has them (D26).
    pub velocity: VelocityWindow,
    /// The burn-down (D16): the last 7 days whatever the window, hourly, in UTC,
    /// oldest first.
    pub buckets: Vec<Bucket>,
    /// The time in each state (D17).
    pub states: ReportStates,
    /// Mean time to completion (D18).
    pub mttc: Mttc,
    /// Mean time to resolution (D18).
    pub mttr: Mttr,
}

/// One hour of the burn-down (D16). Buckets fall on UTC hours: the first runs
/// from 7 days before `end` to the next hour, the last from the hour before
/// `end` to `end` (each partial unless the window starts on the hour), and the
/// rest are whole hours. Each holds what happened at or after its `start` and
/// before the next bucket's (the last one up to and including `end`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Bucket {
    pub start: String,
    /// Tickets remaining (D5) at the bucket's end: after everything in it.
    pub remaining: i64,
    /// Tickets created in it, or first published from a draft in it.
    pub added: i64,
    /// Tickets that reached `done` in it, each once (D3).
    pub done: i64,
}

/// The time in each state (D17): `pending`, `in_progress`, `review` and
/// `deferred` on the `status` track, and `blocked` on its own track.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReportStates {
    pub pending: StateTime,
    pub in_progress: StateTime,
    pub review: StateTime,
    pub deferred: StateTime,
    pub blocked: StateTime,
}

/// One state's figures (D17, D27): over the spans that ended in the window,
/// with `null`s where there were none, and the spans still open now.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StateTime {
    pub count: i64,
    pub mean_seconds: Option<f64>,
    /// The middle length; for an even count, the mean of the middle two.
    pub median_seconds: Option<f64>,
    /// The 90th percentile, by nearest rank: one of the lengths.
    pub p90_seconds: Option<i64>,
    /// Spans in this state now, of tickets that are not drafts.
    pub open: i64,
    /// How long the oldest of those has been open.
    pub oldest_open_seconds: Option<i64>,
}

/// Mean time to completion (D18): over the tickets done in the window, each
/// one's time in progress since it was last reopened.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Mttc {
    /// The tickets measured: done in the window, and in progress at some point
    /// since their last reopen.
    pub count: i64,
    pub mean_seconds: Option<f64>,
    pub median_seconds: Option<f64>,
    /// Tickets done in the window without being in progress since their last
    /// reopen (or ever): left out of the mean.
    pub never_in_progress: i64,
}

/// Mean time to resolution (D18): over the `review` spans that ended in the
/// window.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Mttr {
    pub count: i64,
    pub mean_seconds: Option<f64>,
    pub median_seconds: Option<f64>,
    /// Reviews that ended with the ticket done.
    pub confirmed: i64,
    /// Reviews that ended any other way: sent back to work, mostly.
    pub sent_back: i64,
}

// ---- The reads ----------------------------------------------------------------

/// Whether a ticket was a draft when the span `s` began, and until when: the
/// `ended_at` of the `draft` span open over the event that started it (`''`
/// while that draft is still open), or `NULL` when there was none. By event
/// id, as `velocity.rs`'s `DONE_SQL` asks it.
macro_rules! draft_until {
    () => {
        "(SELECT COALESCE(d.ended_at, '') FROM item_spans d \
         WHERE d.item_id = s.item_id AND d.track = 'draft' AND d.started_event <= s.started_event \
         AND (d.ended_event IS NULL OR d.ended_event > s.started_event) LIMIT 1)"
    };
}

/// Whether the span `s` began with its ticket: no `status` span of the ticket
/// started before it. `added` reads it of the spans started in the window and
/// of every `draft` span (a ticket created a draft before the window may be
/// published in it); the rest get `NULL` and cost nothing. Binds the window's
/// start.
macro_rules! first {
    () => {
        "CASE WHEN s.track = 'draft' OR s.started_at >= ? THEN NOT EXISTS (SELECT 1 \
         FROM item_spans p WHERE p.item_id = s.item_id AND p.track = 'status' \
         AND p.started_event < s.started_event) END"
    };
}

/// One part of [`SPANS_SQL`]: the columns, from the project's spans by
/// `idx_item_spans_project_ended`, of tickets that are not requests (D1) and
/// are not drafts now (D2).
/// `INDEXED BY` and `CROSS JOIN` keep the plan to that index with the spans on
/// the outside: either of the project's other two would read its whole
/// history, and items on the outside would scan every project's tickets.
macro_rules! spans_part {
    () => {
        concat!(
            "SELECT s.item_id, s.track, s.state, s.started_at, s.ended_at, s.started_event, \
             s.ended_event, ",
            first!(),
            ", ",
            draft_until!(),
            " FROM item_spans s INDEXED BY idx_item_spans_project_ended \
             CROSS JOIN items i ON i.id = s.item_id WHERE s.project = ? AND i.type <> 'request' \
             AND i.draft = 0 AND s.started_at <= ? AND "
        )
    };
}

/// The spans that overlap `[start, end]`, every track: those that ended in or
/// after it, then those still open, leaving out an open `done` or `cancelled`
/// span from before the window (a ticket finished before it, which no block
/// reads). Binds `start, project, end, start` for each part, then the open
/// part's `start` again.
pub(super) const SPANS_SQL: &str = concat!(
    spans_part!(),
    "s.ended_at >= ? UNION ALL ",
    spans_part!(),
    "s.ended_at IS NULL AND (s.state NOT IN ('done', 'cancelled') OR s.started_at >= ?)"
);

/// The `in_progress`, `done` and `cancelled` spans, however old, of each
/// ticket with a `done` span started in `[?, ?]` (D18: its in-progress time
/// since its last reopen may predate the window). Binds `project, start, end`.
pub(super) const HISTORY_SQL: &str = concat!(
    "SELECT s.item_id, s.track, s.state, s.started_at, s.ended_at, s.started_event, \
     s.ended_event, NULL, ",
    draft_until!(),
    " FROM item_spans s WHERE s.track = 'status' \
     AND s.state IN ('in_progress', 'done', 'cancelled') AND s.item_id IN (\
     SELECT c.item_id FROM item_spans c WHERE c.project = ? AND c.started_at >= ? \
     AND c.started_at <= ? AND c.track = 'status' AND c.state = 'done')"
);

/// Every statement [`TrackerStore::report`] runs of its own, for the plan test.
#[cfg(test)]
pub(super) const READS: &[&str] = &[SPANS_SQL, HISTORY_SQL];

type SpanRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    i64,
    Option<i64>,
    Option<bool>,
    Option<String>,
);

/// Whether a span's ticket was a draft when it began (D2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DraftAtStart {
    No,
    /// It was, and was published at this time.
    Until(i64),
    /// It was, and still is.
    Still,
}

/// One span, its times as Unix seconds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Span {
    pub item: String,
    pub track: String,
    pub state: String,
    pub start: i64,
    pub end: Option<i64>,
    pub started_event: i64,
    pub ended_event: Option<i64>,
    /// It began with its ticket (only asked where `added` reads it).
    pub first: bool,
    pub draft: DraftAtStart,
}

impl Span {
    fn from_row(r: SpanRow) -> Option<Self> {
        let (item, track, state, started_at, ended_at, started_event, ended_event, first, until) =
            r;
        let end = match ended_at {
            Some(t) => Some(unix(&t)?),
            None => None,
        };
        let draft = match until.as_deref() {
            None => DraftAtStart::No,
            Some("") => DraftAtStart::Still,
            Some(t) => unix(t).map_or(DraftAtStart::Still, DraftAtStart::Until),
        };
        Some(Span {
            item,
            track,
            state,
            start: unix(&started_at)?,
            end,
            started_event,
            ended_event,
            first: first.unwrap_or(false),
            draft,
        })
    }

    /// When the span starts to count (D2): its start, or its ticket's
    /// publication if it began as a draft; `None` when none of it counts.
    fn counted_start(&self) -> Option<i64> {
        match self.draft {
            DraftAtStart::No => Some(self.start),
            DraftAtStart::Still => None,
            DraftAtStart::Until(t) => match self.end {
                Some(end) if end <= t => None,
                _ => Some(self.start.max(t)),
            },
        }
    }

    /// The counted length of a closed span.
    fn counted_seconds(&self, drafts: &Stretches) -> Option<i64> {
        let end = self.end?;
        Some(self.counted(self.counted_start()?, end, drafts))
    }

    /// The seconds from `from` to `to`, less this span's ticket's stretches as
    /// a draft within them (D2).
    fn counted(&self, from: i64, to: i64, drafts: &Stretches) -> i64 {
        let drafted: i64 = drafts
            .get(self.item.as_str())
            .into_iter()
            .flatten()
            .map(|&(start, end)| (end.unwrap_or(to).min(to) - start.max(from)).max(0))
            .sum();
        to - from - drafted
    }

    fn on_status(&self) -> bool {
        self.track == STATUS
    }
}

// ---- The arithmetic -------------------------------------------------------------

/// The count, mean, median and nearest-rank 90th percentile of some lengths.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Summary {
    pub count: i64,
    pub mean: Option<f64>,
    pub median: Option<f64>,
    pub p90: Option<i64>,
}

pub(super) fn summarise(mut lengths: Vec<i64>) -> Summary {
    lengths.sort_unstable();
    let n = lengths.len();
    if n == 0 {
        return Summary {
            count: 0,
            mean: None,
            median: None,
            p90: None,
        };
    }
    let mean = lengths.iter().map(|&l| l as f64).sum::<f64>() / n as f64;
    let median = if n % 2 == 1 {
        lengths[n / 2] as f64
    } else {
        (lengths[n / 2 - 1] as f64 + lengths[n / 2] as f64) / 2.0
    };
    // Nearest rank: the ⌈0.9 n⌉-th smallest.
    let rank = (9 * n).div_ceil(10);
    Summary {
        count: n as i64,
        mean: Some(mean),
        median: Some(median),
        p90: Some(lengths[rank - 1]),
    }
}

/// The burn-down's hours (D16): each bucket's start, and the instant its
/// `remaining` is read at. Bucket `k` holds the instants `t` with
/// `ends[k - 1] <= t < ends[k]`; the last one's end is `end + 1`, so `end`
/// itself is in it.
pub(super) struct Hours {
    pub starts: Vec<i64>,
    pub ends: Vec<i64>,
}

impl Hours {
    pub(super) fn new(start: i64, end: i64) -> Self {
        let mut starts = vec![start];
        let mut next = start - start.rem_euclid(HOUR) + HOUR;
        while next < end {
            starts.push(next);
            next += HOUR;
        }
        let mut ends: Vec<i64> = starts[1..].to_vec();
        ends.push(end + 1);
        Hours { starts, ends }
    }

    /// The first bucket whose end is after `t`: for an instant in the window,
    /// the bucket it falls in.
    fn after(&self, t: i64) -> usize {
        self.ends.partition_point(|&e| e <= t)
    }
}

/// Each ticket's stretches as a draft among the spans read: start and end.
type Stretches<'a> = HashMap<&'a str, Vec<(i64, Option<i64>)>>;

fn draft_stretches(spans: &[Span]) -> Stretches<'_> {
    let mut drafts: Stretches = HashMap::new();
    for s in spans.iter().filter(|s| s.track == DRAFT) {
        drafts
            .entry(s.item.as_str())
            .or_default()
            .push((s.start, s.end));
    }
    drafts
}

/// The burn-down's series (D16), one figure an hour of [`Hours`].
pub(super) struct BurnDown {
    pub remaining: Vec<i64>,
    pub added: Vec<i64>,
    pub done: Vec<i64>,
}

/// What the spans say of the window (D17, D18), with its velocity to come.
pub(super) struct Figures {
    pub states: ReportStates,
    pub mttc: Mttc,
    pub mttr: Mttr,
}

fn state_time(lengths: Vec<i64>, open: i64, oldest: Option<i64>) -> StateTime {
    let s = summarise(lengths);
    StateTime {
        count: s.count,
        mean_seconds: s.mean,
        median_seconds: s.median,
        p90_seconds: s.p90,
        open,
        oldest_open_seconds: oldest,
    }
}

/// The burn-down over `[start, end]` from the spans that overlap it
/// ([`SPANS_SQL`]).
pub(super) fn burn_down(spans: &[Span], hours: &Hours, start: i64, end: i64) -> BurnDown {
    let n = hours.starts.len();
    let within = |t: i64| t >= start && t <= end;
    let drafts = draft_stretches(spans);

    // Remaining at each bucket's end (D5, D16): a span counts at an instant
    // `T` when `start < T <= end` (it began before `T` and had not ended by
    // the moment before), so the state is the one after everything in the
    // bucket. Each span adds 1 to the buckets whose ends it covers, and each
    // stretch of it under a draft takes 1 away: a difference array over the
    // bucket ends.
    let mut diff = vec![0i64; n + 1];
    let mut cover = |from: i64, to: Option<i64>, by: i64| {
        let (a, b) = (hours.after(from), to.map_or(n, |t| hours.after(t)));
        if a < b {
            diff[a] += by;
            diff[b] -= by;
        }
    };
    for s in spans
        .iter()
        .filter(|s| s.on_status() && REMAINING.contains(&s.state.as_str()))
    {
        cover(s.start, s.end, 1);
        for &(d_start, d_end) in drafts.get(s.item.as_str()).into_iter().flatten() {
            let lo = s.start.max(d_start);
            let hi = match (s.end, d_end) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            };
            if hi.is_none_or(|h| lo < h) {
                cover(lo, hi, -1);
            }
        }
    }
    let mut remaining = Vec::with_capacity(n);
    let mut running = 0;
    for d in &diff[..n] {
        running += d;
        remaining.push(running);
    }

    // Added (D16): when a ticket was created or, created a draft, first
    // published.
    let mut creation_draft: HashMap<&str, &Span> = HashMap::new();
    let mut first_status: HashMap<&str, &Span> = HashMap::new();
    for s in spans.iter().filter(|s| s.first) {
        if s.track == DRAFT {
            creation_draft.insert(s.item.as_str(), s);
        } else if s.on_status() {
            first_status.insert(s.item.as_str(), s);
        }
    }
    let mut added = vec![0i64; n];
    let tickets: HashSet<&str> = creation_draft
        .keys()
        .chain(first_status.keys())
        .copied()
        .collect();
    for item in tickets {
        let at = match creation_draft.get(item) {
            Some(d) => d.end,
            None => first_status.get(item).map(|s| s.start),
        };
        if let Some(at) = at.filter(|&t| within(t)) {
            added[hours.after(at)] += 1;
        }
    }

    // Done (D3), each ticket once a bucket.
    let mut done = vec![0i64; n];
    let mut done_in: HashSet<(usize, &str)> = HashSet::new();
    for s in spans.iter().filter(|s| {
        s.on_status() && s.state == "done" && within(s.start) && s.draft == DraftAtStart::No
    }) {
        let bucket = hours.after(s.start);
        if done_in.insert((bucket, s.item.as_str())) {
            done[bucket] += 1;
        }
    }

    BurnDown {
        remaining,
        added,
        done,
    }
}

/// The window's figures over `[start, end]` from spans that overlap at least
/// that ([`SPANS_SQL`]) and the history of the tickets done in it
/// ([`HISTORY_SQL`]).
pub(super) fn figures(spans: &[Span], history: &[Span], start: i64, end: i64) -> Figures {
    let within = |t: i64| t >= start && t <= end;
    let drafts = draft_stretches(spans);

    let mut by_start: HashMap<(&str, i64), &Span> = HashMap::new();
    for s in spans.iter().filter(|s| s.on_status()) {
        by_start.insert((s.item.as_str(), s.started_event), s);
    }

    // The window's completion of each ticket (its latest), for MTTC.
    let mut completion: HashMap<&str, &Span> = HashMap::new();
    for s in spans.iter().filter(|s| {
        s.on_status() && s.state == "done" && within(s.start) && s.draft == DraftAtStart::No
    }) {
        let latest = completion.entry(s.item.as_str()).or_insert(s);
        if s.started_event > latest.started_event {
            *latest = s;
        }
    }

    // Time in each state (D17).
    let mut lengths: HashMap<&str, Vec<i64>> = HashMap::new();
    let mut open: HashMap<&str, (i64, i64)> = HashMap::new();
    for s in spans {
        let key = if s.track == BLOCKED {
            BLOCKED
        } else if s.on_status() && TIMED.contains(&s.state.as_str()) {
            s.state.as_str()
        } else {
            continue;
        };
        match s.end {
            Some(e) if within(e) => {
                if let Some(len) = s.counted_seconds(&drafts) {
                    lengths.entry(key).or_default().push(len);
                }
            }
            None => {
                if let Some(from) = s.counted_start() {
                    let o = open.entry(key).or_insert((0, 0));
                    o.0 += 1;
                    o.1 = o.1.max(s.counted(from, end, &drafts));
                }
            }
            _ => {}
        }
    }
    let mut state = |key: &str| {
        let (count, oldest) = open.get(key).copied().unwrap_or((0, 0));
        state_time(
            lengths.remove(key).unwrap_or_default(),
            count,
            (count > 0).then_some(oldest),
        )
    };
    let states = ReportStates {
        pending: state("pending"),
        in_progress: state("in_progress"),
        review: state("review"),
        deferred: state("deferred"),
        blocked: state(BLOCKED),
    };

    // MTTC (D18): each done ticket's in-progress time between its last
    // reopen (the end of its latest `done` or `cancelled` span before this
    // completion) and the completion.
    let mut past: HashMap<&str, Vec<&Span>> = HashMap::new();
    for s in history {
        past.entry(s.item.as_str()).or_default().push(s);
    }
    let mut to_complete: Vec<i64> = Vec::new();
    let mut never_in_progress = 0;
    for (item, c) in &completion {
        let spans = past.get(item).map(Vec::as_slice).unwrap_or_default();
        let reopened = spans
            .iter()
            .filter(|s| {
                (s.state == "done" || s.state == "cancelled") && s.started_event < c.started_event
            })
            .filter_map(|s| s.ended_event)
            .max()
            .unwrap_or(i64::MIN);
        let worked: Vec<i64> = spans
            .iter()
            .filter(|s| {
                s.state == "in_progress"
                    && s.started_event >= reopened
                    && s.ended_event.is_some_and(|e| e <= c.started_event)
            })
            .filter_map(|s| s.counted_seconds(&drafts))
            .collect();
        if worked.is_empty() {
            never_in_progress += 1;
        } else {
            to_complete.push(worked.iter().sum::<i64>());
        }
    }
    let completed = summarise(to_complete);
    let mttc = Mttc {
        count: completed.count,
        mean_seconds: completed.mean,
        median_seconds: completed.median,
        never_in_progress,
    };

    // MTTR (D18): each review that ended in the window, confirmed when the
    // span after it is `done`.
    let mut reviews = Vec::new();
    let (mut confirmed, mut sent_back) = (0, 0);
    for s in spans
        .iter()
        .filter(|s| s.on_status() && s.state == "review" && s.end.is_some_and(within))
    {
        let Some(len) = s.counted_seconds(&drafts) else {
            continue;
        };
        reviews.push(len);
        let next = s
            .ended_event
            .and_then(|e| by_start.get(&(s.item.as_str(), e)));
        if next.is_some_and(|n| n.state == "done") {
            confirmed += 1;
        } else {
            sent_back += 1;
        }
    }
    let resolved = summarise(reviews);
    let mttr = Mttr {
        count: resolved.count,
        mean_seconds: resolved.mean,
        median_seconds: resolved.median,
        confirmed,
        sent_back,
    };

    Figures { states, mttc, mttr }
}

/// The spans overlapping `[burn_start, end]` and the history of the tickets
/// done in `[start, end]`.
async fn read_spans(
    conn: &mut SqliteConnection,
    project: &str,
    burn_start: &str,
    start: &str,
    end: &str,
) -> TResult<(Vec<Span>, Vec<Span>)> {
    let spans: Vec<SpanRow> = sqlx::query_as(SPANS_SQL)
        // The closed part: first!'s start, then project, end, start.
        .bind(burn_start)
        .bind(project)
        .bind(end)
        .bind(burn_start)
        // The open part: the same, then its start for the finished ones.
        .bind(burn_start)
        .bind(project)
        .bind(end)
        .bind(burn_start)
        .fetch_all(&mut *conn)
        .await?;
    let history: Vec<SpanRow> = sqlx::query_as(HISTORY_SQL)
        .bind(project)
        .bind(start)
        .bind(end)
        .fetch_all(&mut *conn)
        .await?;
    Ok((
        spans.into_iter().filter_map(Span::from_row).collect(),
        history.into_iter().filter_map(Span::from_row).collect(),
    ))
}

impl TrackerStore {
    /// The report for `project` over `window`, ending at `now` (D27), with the
    /// burn-down over the last 7 days whatever the window (D16). An unknown
    /// project answers an empty report (its buckets zeros, its states
    /// `null`s), not an error; an invalid project name is refused. Read-only,
    /// in one read transaction so the velocity and the spans agree; `now` is a
    /// parameter so a test can pin time, and the route passes the clock.
    pub async fn report(
        &self,
        project: &str,
        window: ReportWindow,
        now: DateTime<Utc>,
    ) -> TResult<Report> {
        validate_project(project)?;
        let start = now - window.length();
        let burn_start = now - ReportWindow::Week.length();
        let (start_s, end_s) = (iso(start), iso(now));
        let mut tx = self.pool.begin().await?;
        let v = velocity::read(&mut tx, project, now).await?;
        let (spans, history) =
            read_spans(&mut tx, project, &iso(burn_start), &start_s, &end_s).await?;
        tx.commit().await?;

        let (from, burn_from, to) = (start.timestamp(), burn_start.timestamp(), now.timestamp());
        let f = figures(&spans, &history, from, to);
        let hours = Hours::new(burn_from, to);
        let burn = burn_down(&spans, &hours, burn_from, to);
        let buckets = hours
            .starts
            .iter()
            .enumerate()
            .map(|(k, &at)| Bucket {
                start: DateTime::from_timestamp(at, 0).map(iso).unwrap_or_default(),
                remaining: burn.remaining[k],
                added: burn.added[k],
                done: burn.done[k],
            })
            .collect();
        Ok(Report {
            project: project.to_string(),
            window,
            start: start_s,
            end: end_s,
            velocity: match window {
                ReportWindow::Day => v.windows.day,
                ReportWindow::Week => v.windows.week,
            },
            buckets,
            states: f.states,
            mttc: f.mttc,
            mttr: f.mttr,
        })
    }
}
