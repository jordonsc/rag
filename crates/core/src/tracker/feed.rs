//! The live event feed (rag-t0036): every committed event, pushed to whoever
//! is listening, so a manager agent is woken by the owner's actions without
//! polling.
//!
//! The store owns one [`tokio::sync::broadcast`] channel. Each write path
//! commits through [`TrackerStore::commit`], which then calls
//! [`TrackerStore::publish`]: under one mutex, it reads every event committed
//! after the last one it sent (`event_id > last`) and broadcasts them in id
//! order. Reading after the commit, rather than handing over the rows a
//! transaction wrote, is what keeps the order total and the stream gap-free:
//!
//! * Writes take SQLite's write lock up front (`BEGIN IMMEDIATE`), so event ids
//!   are assigned **and committed** in increasing order: once id `n` is
//!   visible, every id below it is too.
//! * Two writers publishing at once serialise on the mutex; whichever goes
//!   first sends both writes' events, the second finds nothing new.
//! * A failed read only logs: `last` stays put and the next write's publish
//!   sends what was missed.
//!
//! A subscriber **subscribes first, then replays** from the table (the
//! events after its `since`), then reads the channel, dropping any id it has
//! already scanned. An event committed before the subscription is in the
//! replay; one committed after it is on the channel; one in between is in both
//! and de-duplicated by id. See `specs/tracker/api.md` § *The event feed*.

use std::sync::Arc;

use serde::Serialize;
use sqlx::{QueryBuilder, Sqlite};
use tokio::sync::{broadcast, watch, Mutex};

use super::{EventKind, EventRow, ItemType, Surface, TResult, TargetKind, TrackerStore};

/// How many events the channel holds for a subscriber that has not read them
/// yet. A subscriber that falls this far behind is told it lagged and is
/// disconnected (it resumes by id), so nothing is buffered without bound.
pub const FEED_CAPACITY: usize = 1024;

/// The event kinds a feed sends when the caller names none: the owner's
/// decisions and the queue's movements. `link` and `rename` are housekeeping
/// and left out; `edit` is in, as label changes and the owner's corrections to
/// an item or a document are edits.
pub const DEFAULT_FEED_KINDS: &[EventKind] = &[
    EventKind::Create,
    EventKind::Status,
    EventKind::Block,
    EventKind::Unblock,
    EventKind::Approve,
    EventKind::Move,
    EventKind::Note,
    EventKind::Acknowledge,
    EventKind::Assign,
    EventKind::Edit,
];

/// One event as the feed carries it: the event itself, the record it belongs
/// to, and that record's title as it is now.
#[derive(Debug, Clone, Serialize)]
pub struct FeedEvent {
    pub event_id: i64,
    pub ts: String,
    pub project: String,
    pub target_kind: TargetKind,
    pub target_id: String,
    /// The record's current title; `None` when the record is gone.
    pub title: Option<String>,
    pub author_email: String,
    pub agent: String,
    pub surface: Surface,
    pub kind: EventKind,
    pub body: String,
    /// The fields the event set, with their new values: the "to".
    pub fields: serde_json::Value,
    /// What those fields held before the write: the "from" (rag-t0038). `null`
    /// on a create and on an event written before it was recorded.
    pub before: Option<serde_json::Value>,
}

/// The longest title and body a text line carries before it is cut with `…`.
const LINE_TITLE_CHARS: usize = 100;
const LINE_BODY_CHARS: usize = 200;

impl FeedEvent {
    /// The record as a frame names it: an item by its id (`rag-t0040`), the
    /// others by kind and key (`spec:tracker`, `milestone:tracker/m01`,
    /// `concept:feed`, `doc:rag-d0003`).
    pub fn target_label(&self) -> String {
        match self.target_kind {
            TargetKind::Item => self.target_id.clone(),
            TargetKind::Document => format!("doc:{}", self.target_id),
            other => format!("{}:{}", other.as_str(), self.target_id),
        }
    }

    /// Who wrote it, as a frame shows it: the agent's name. A web write with no
    /// agent is recorded as `Owner` (rag-t0038), so the owner's writes read
    /// `[Owner]`; an agent's email is the workstation's git identity, the same
    /// for every agent, so it is not shown.
    pub fn who(&self) -> &str {
        &self.agent
    }

    /// What the event changed, from → to, as
    /// ` {status: in_progress → done; blocked: dependency → no}`: each change
    /// [`FeedEvent::changes`] names, separated by `; `. Empty when it named
    /// none, so a note given in place of the generated body still says what
    /// changed.
    pub fn changed(&self) -> String {
        let said = self.changes();
        if said.is_empty() {
            String::new()
        } else {
            format!(" {{{}}}", said.join("; "))
        }
    }

    /// Each change a frame names, in a fixed order: `moved: after rag-t0010 →
    /// top`, `status: in_progress → done`, `state: draft → ready`,
    /// `approval: agent → ratified`, `blocked: dependency → no`, `depends_on:
    /// rag-t0003 → rag-t0003, rag-t0004`, `assignee: none → dev-3`, `labels:
    /// +Physics −Biomes`, `links: +item:rag-t0002 −ledger:rag-0033`, `title:
    /// Old → New`, `body: edited`, `intensity`, `release`, `parallel`,
    /// `order`, `path`, and a document's `revision`. A field whose prior value
    /// the event did not record (every event written before rag-t0038) shows
    /// its new value alone (`status: done`). Never for a create, whose fields
    /// are the whole record, but a request's, which names its type (`type:
    /// request`, rag-t0044); bookkeeping (`done_at`, `acknowledged_at`,
    /// `unblocked_by`) is left out.
    pub fn changes(&self) -> Vec<String> {
        describe_changes(
            self.kind,
            self.target_kind,
            &self.fields,
            self.before.as_ref(),
        )
    }

    /// The text frame: one line, the event id first so a client can resume.
    ///
    /// `#13901 rag web approve rag-t0040 "Event feed" {approval: agent → ratified}: Ship it. [Owner]`
    pub fn line(&self) -> String {
        let title = match &self.title {
            Some(t) => format!(" \"{}\"", clip(t, LINE_TITLE_CHARS)),
            None => String::new(),
        };
        format!(
            "#{} {} {} {} {}{}{}: {} [{}]",
            self.event_id,
            self.project,
            self.surface,
            self.kind,
            self.target_label(),
            title,
            self.changed(),
            note_said(&self.body, self.event_id),
            clip(self.who(), LINE_TITLE_CHARS),
        )
    }
}

/// How long a burst stays open (rag-t0039): events of one project and surface
/// committed within this many seconds of the first share one text frame.
pub const BURST_WINDOW_SECS: u64 = 3;

/// Whether `next` joins the burst `first` opened (rag-t0039): the same project
/// and surface, committed no earlier than `first` and at most `window_secs`
/// after it, by the events' own timestamps (to the second). A window of 0
/// coalesces nothing.
pub fn joins_burst(first: &FeedEvent, next: &FeedEvent, window_secs: u64) -> bool {
    let at = |e: &FeedEvent| chrono::DateTime::parse_from_rfc3339(&e.ts).ok();
    window_secs > 0
        && first.project == next.project
        && first.surface == next.surface
        && match (at(first), at(next)) {
            (Some(a), Some(b)) => {
                let gap = (b - a).num_seconds();
                (0..=window_secs as i64).contains(&gap)
            }
            _ => false,
        }
}

/// The most records a burst frame names one by one before it counts the rest.
const BURST_RECORDS: usize = 5;
/// The longest a burst frame's per-record changes run before they are cut.
const BURST_CHANGES_CHARS: usize = 160;
/// The longest a note quoted in a burst frame runs before it is cut.
const BURST_NOTE_CHARS: usize = 80;

/// One text frame for a burst of events (rag-t0039), in id order: the last
/// event's id first, since that is where a client resumes, then the range and
/// a summary. A burst of one is that event's own [`FeedEvent::line`].
///
/// `#13950 ubu web burst #13946–#13950, 5 events: queue reordered: 5 moves (ubu-t0042, ubu-t0040, ubu-t0051, ubu-t0049, ubu-t0050) [Owner]`
///
/// Moves read as `queue reordered: N moves (ids)` and acknowledgements as
/// `acknowledged N done items (ids)`; every other record is named with what
/// happened to it: one event as its kind and changes (a note quoted, cut at
/// 80 characters), several as counts and their changes together
/// (`ubu-t0042 "Title": 3 edits {title: A → B; labels: +Physics; body: edited}`).
/// At most five records are named; the rest are counted. The events themselves
/// are one read away: `GET /tracker/{project}/events?since=<first − 1>`.
pub fn burst_line(events: &[FeedEvent]) -> String {
    let (Some(first), Some(last)) = (events.first(), events.last()) else {
        return String::new();
    };
    if events.len() == 1 {
        return first.line();
    }
    let ids = |es: &[&FeedEvent]| {
        let mut seen: Vec<String> = Vec::new();
        for e in es {
            let l = e.target_label();
            if !seen.contains(&l) {
                seen.push(l);
            }
        }
        listed(&seen)
    };
    let moves: Vec<&FeedEvent> = events
        .iter()
        .filter(|e| e.kind == EventKind::Move)
        .collect();
    let acks: Vec<&FeedEvent> = events
        .iter()
        .filter(|e| e.kind == EventKind::Acknowledge)
        .collect();
    let mut parts = Vec::new();
    if !moves.is_empty() {
        parts.push(format!(
            "queue reordered: {} ({})",
            counted(moves.len(), "move", "moves"),
            ids(&moves)
        ));
    }
    if !acks.is_empty() {
        parts.push(format!(
            "acknowledged {} ({})",
            counted(acks.len(), "done ticket", "done tickets"),
            ids(&acks)
        ));
    }
    // Everything else, grouped by record in the order each first appears.
    let mut records: Vec<(String, Vec<&FeedEvent>)> = Vec::new();
    for e in events
        .iter()
        .filter(|e| !matches!(e.kind, EventKind::Move | EventKind::Acknowledge))
    {
        let label = e.target_label();
        match records.iter_mut().find(|(l, _)| *l == label) {
            Some((_, es)) => es.push(e),
            None => records.push((label, vec![e])),
        }
    }
    let more = records.len().saturating_sub(BURST_RECORDS);
    for (label, es) in records.iter().take(BURST_RECORDS) {
        let latest = es[es.len() - 1];
        let title = match &latest.title {
            Some(t) => format!(" \"{}\"", clip(t, LINE_VALUE_CHARS)),
            None => String::new(),
        };
        let what = if let [one] = es.as_slice() {
            let mut w = format!("{}{}", one.kind, one.changed());
            if one.kind == EventKind::Note {
                w.push_str(&format!(": {}", clip(&one.body, BURST_NOTE_CHARS)));
            }
            w
        } else {
            let mut kinds: Vec<(EventKind, usize)> = Vec::new();
            for e in es {
                match kinds.iter_mut().find(|(k, _)| *k == e.kind) {
                    Some((_, n)) => *n += 1,
                    None => kinds.push((e.kind, 1)),
                }
            }
            let counts = kinds
                .iter()
                .map(|(k, n)| kind_counted(*k, *n))
                .collect::<Vec<_>>()
                .join(", ");
            let changes: Vec<String> = es.iter().flat_map(|e| e.changes()).collect();
            if changes.is_empty() {
                counts
            } else {
                format!(
                    "{counts} {{{}}}",
                    clip(&changes.join("; "), BURST_CHANGES_CHARS)
                )
            }
        };
        parts.push(format!("{label}{title}: {what}"));
    }
    if more > 0 {
        parts.push(format!(
            "+{more} more {}",
            if more == 1 { "record" } else { "records" }
        ));
    }
    let mut who: Vec<&str> = Vec::new();
    for e in events {
        if !who.contains(&e.who()) {
            who.push(e.who());
        }
    }
    format!(
        "#{} {} {} burst #{}–#{}, {} events: {} [{}]",
        last.event_id,
        last.project,
        last.surface,
        first.event_id,
        last.event_id,
        events.len(),
        parts.join("; "),
        clip(&who.join(", "), LINE_TITLE_CHARS),
    )
}

/// `a, b, c, d, e +3 more`: at most [`BURST_RECORDS`] names, the rest counted.
fn listed(names: &[String]) -> String {
    let shown = names
        .iter()
        .take(BURST_RECORDS)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    match names.len().saturating_sub(BURST_RECORDS) {
        0 => shown,
        more => format!("{shown} +{more} more"),
    }
}

fn counted(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// `3 edits`, `2 status changes`, `1 note`: how many events of a kind.
fn kind_counted(kind: EventKind, n: usize) -> String {
    let (one, many) = match kind {
        EventKind::Note => ("note", "notes"),
        EventKind::Create => ("create", "creates"),
        EventKind::Status => ("status change", "status changes"),
        EventKind::Block => ("block", "blocks"),
        EventKind::Unblock => ("unblock", "unblocks"),
        EventKind::Approve => ("approval", "approvals"),
        EventKind::Move => ("move", "moves"),
        EventKind::Edit => ("edit", "edits"),
        EventKind::Link => ("link change", "link changes"),
        EventKind::Assign => ("assignment", "assignments"),
        EventKind::Acknowledge => ("acknowledgement", "acknowledgements"),
        EventKind::Rename => ("rename", "renames"),
    };
    counted(n, one, many)
}

/// A note as a frame carries it (rag-t0039): on one line, and past
/// [`LINE_BODY_CHARS`] cut with how much more there is and the event that
/// holds it, `… (+812 chars in #13950)`, so a reader knows to fetch the rest.
fn note_said(body: &str, event_id: i64) -> String {
    let one: String = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let n = one.chars().count();
    if n <= LINE_BODY_CHARS {
        return one;
    }
    let keep = LINE_BODY_CHARS - 1;
    let mut cut: String = one.chars().take(keep).collect();
    cut.push_str(&format!("… (+{} chars in #{event_id})", n - keep));
    cut
}

/// What an event changed, from → to, in a fixed order: the feed's
/// [`FeedEvent::changes`] and the MCP server's one-line write replies
/// (rag-t0039) both say it this way. See [`FeedEvent::changes`].
pub fn describe_changes(
    kind: EventKind,
    target_kind: TargetKind,
    fields: &serde_json::Value,
    before: Option<&serde_json::Value>,
) -> Vec<String> {
    if kind == EventKind::Create {
        // A request is the one create a manager acts on (rag-t0044): its
        // frame says so, `{type: request}`. Any other create names nothing.
        let ty = fields.get("type").and_then(|t| t.as_str());
        return match (target_kind, ty) {
            (TargetKind::Item, Some(t)) if t == ItemType::Request.as_str() => {
                vec![format!("type: {t}")]
            }
            _ => Vec::new(),
        };
    }
    let Some(after) = fields.as_object() else {
        return Vec::new();
    };
    let before = before.and_then(|b| b.as_object());
    let prior = |k: &str| before.and_then(|b| b.get(k));
    let mut said = Vec::new();

    // A move: where the item now sits, by its new neighbour.
    if kind == EventKind::Move {
        let to = match after.get("prev_id") {
            Some(prev) => Some(position(prev)),
            // Recorded before rag-t0038: the place asked for.
            None => after.get("place").map(place_said),
        };
        if let Some(to) = to {
            said.push(match prior("prev_id") {
                Some(from) => format!("moved: {} → {to}", position(from)),
                None => format!("moved: {to}"),
            });
        }
    }
    for key in ["status", "state", "approval"] {
        if let Some(to) = after.get(key) {
            said.push(from_to(key, prior(key), to));
        }
    }
    // `blocked` and `block_reason` read as one: the reason while blocked,
    // `no` while not.
    if after.contains_key("blocked") || after.contains_key("block_reason") {
        let to = block_said(after.get("blocked"), after.get("block_reason"), before);
        let from = before
            .filter(|b| b.contains_key("blocked") || b.contains_key("block_reason"))
            .map(|b| block_said(b.get("blocked"), b.get("block_reason"), None));
        said.push(match from {
            Some(from) if from != to => format!("blocked: {from} → {to}"),
            _ => format!("blocked: {to}"),
        });
    }
    for key in ["depends_on", "assignee"] {
        if let Some(to) = after.get(key) {
            said.push(from_to(key, prior(key), to));
        }
    }
    if let Some(to) = after.get("labels") {
        said.push(match prior("labels") {
            Some(from) => format!("labels: {}", list_delta(from, to)),
            None => format!("labels: {}", value_said(to)),
        });
    }
    if after.contains_key("links_added") || after.contains_key("links_removed") {
        let links = |k: &str, sign: char| -> Vec<String> {
            after
                .get(k)
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .map(|l| format!("{sign}{}", link_said(l)))
                        .collect()
                })
                .unwrap_or_default()
        };
        let mut parts = links("links_added", '+');
        parts.extend(links("links_removed", '−'));
        said.push(format!("links: {}", parts.join(" ")));
    }
    if let Some(to) = after.get("title") {
        said.push(from_to("title", prior("title"), to));
    }
    if after.contains_key("body") {
        said.push("body: edited".to_string());
    }
    for key in ["intensity", "release", "parallel", "order"] {
        if let Some(to) = after.get(key) {
            said.push(from_to(key, prior(key), to));
        }
    }
    if let Some(to) = after.get("path") {
        // A rename recorded before rag-t0038 kept the old path as `old_path`.
        let from = prior("path").or_else(|| after.get("old_path"));
        said.push(from_to("path", from, to));
    }
    if target_kind == TargetKind::Document && kind == EventKind::Edit {
        if let Some(to) = after.get("revision") {
            said.push(from_to("revision", prior("revision"), to));
        }
    }
    said
}

/// The longest value a change names before it is cut with `…`.
const LINE_VALUE_CHARS: usize = 40;

/// `key: from → to`, or `key: to` when the prior value was not recorded.
fn from_to(key: &str, from: Option<&serde_json::Value>, to: &serde_json::Value) -> String {
    match from {
        Some(from) => format!("{key}: {} → {}", value_said(from), value_said(to)),
        None => format!("{key}: {}", value_said(to)),
    }
}

/// A value as a change names it: a string as itself, `none` for null, `yes`
/// or `no` for a flag, a list comma-separated (`none` when empty).
fn value_said(v: &serde_json::Value) -> String {
    use serde_json::Value;
    match v {
        Value::String(s) => clip(s, LINE_VALUE_CHARS),
        Value::Null => "none".to_string(),
        Value::Bool(true) => "yes".to_string(),
        Value::Bool(false) => "no".to_string(),
        Value::Array(a) if a.is_empty() => "none".to_string(),
        Value::Array(a) => clip(
            &a.iter().map(value_said).collect::<Vec<_>>().join(", "),
            LINE_VALUE_CHARS,
        ),
        other => clip(&other.to_string(), LINE_VALUE_CHARS),
    }
}

/// Whether a record is blocked, as a change names it: its reason while
/// blocked (`dependency`), `no` while not. A block recorded without its reason
/// takes it from `fallback` (the prior values), else reads `yes`.
fn block_said(
    blocked: Option<&serde_json::Value>,
    reason: Option<&serde_json::Value>,
    fallback: Option<&serde_json::Map<String, serde_json::Value>>,
) -> String {
    if blocked.and_then(|b| b.as_bool()) == Some(false) {
        return "no".to_string();
    }
    reason
        .filter(|r| !r.is_null())
        .or_else(|| {
            fallback
                .and_then(|b| b.get("block_reason"))
                .filter(|r| !r.is_null())
        })
        .map(value_said)
        .unwrap_or_else(|| "yes".to_string())
}

/// A list change as what it added and removed: `+Physics −Biomes`. The same
/// members in another order read as the new list.
fn list_delta(from: &serde_json::Value, to: &serde_json::Value) -> String {
    let empty = Vec::new();
    let from = from.as_array().unwrap_or(&empty);
    let to_list = to.as_array().unwrap_or(&empty);
    let mut parts: Vec<String> = to_list
        .iter()
        .filter(|v| !from.contains(v))
        .map(|v| format!("+{}", value_said(v)))
        .collect();
    parts.extend(
        from.iter()
            .filter(|v| !to_list.contains(v))
            .map(|v| format!("−{}", value_said(v))),
    );
    if parts.is_empty() {
        value_said(to)
    } else {
        parts.join(" ")
    }
}

/// A link as `kind:target` (`item:rag-t0002`).
fn link_said(l: &serde_json::Value) -> String {
    let kind = l.get("kind").and_then(|v| v.as_str()).unwrap_or("?");
    let target = l.get("target").and_then(|v| v.as_str()).unwrap_or("?");
    clip(&format!("{kind}:{target}"), LINE_VALUE_CHARS)
}

/// A queued item's position by its neighbour: `top` with none before it,
/// else `after rag-t0012`.
fn position(prev_id: &serde_json::Value) -> String {
    match prev_id.as_str() {
        Some(p) => format!("after {}", clip(p, LINE_VALUE_CHARS)),
        None => "top".to_string(),
    }
}

/// A move's requested place (`"top"`, `{"after": "rag-t0012"}`), for a move
/// recorded before its neighbour was: `top`, `bottom`, `after …`, `before …`.
fn place_said(place: &serde_json::Value) -> String {
    match place {
        serde_json::Value::Object(o) => o
            .iter()
            .next()
            .map(|(k, v)| format!("{k} {}", value_said(v)))
            .unwrap_or_default(),
        other => value_said(other),
    }
}

/// `s` on one line (every run of whitespace, newlines included, one space),
/// cut to `max` characters with `…`.
fn clip(s: &str, max: usize) -> String {
    let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= max {
        return one;
    }
    let mut cut: String = one.chars().take(max.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

/// Which events a feed or a read wants.
#[derive(Debug, Clone, Default)]
pub struct FeedFilter {
    /// One project, or `None` for every project.
    pub project: Option<String>,
    /// The surfaces wanted; `None` for any.
    pub surfaces: Option<Vec<Surface>>,
    /// The kinds wanted; `None` for every kind.
    pub kinds: Option<Vec<EventKind>>,
}

impl FeedFilter {
    /// Whether `e` passes. The same test the SQL in
    /// [`TrackerStore::events_after`] applies, for the live side.
    pub fn matches(&self, e: &FeedEvent) -> bool {
        self.project.as_deref().is_none_or(|p| p == e.project)
            && self
                .surfaces
                .as_ref()
                .is_none_or(|s| s.contains(&e.surface))
            && self.kinds.as_ref().is_none_or(|k| k.contains(&e.kind))
    }

    fn push_where(&self, q: &mut QueryBuilder<'_, Sqlite>) {
        if let Some(p) = &self.project {
            q.push(" AND e.project = ").push_bind(p.clone());
        }
        if let Some(surfaces) = &self.surfaces {
            q.push(" AND e.surface IN (");
            let mut sep = q.separated(", ");
            for s in surfaces {
                sep.push_bind(s.as_str());
            }
            // An empty list matches nothing: `IN ('')` keeps the SQL valid.
            if surfaces.is_empty() {
                sep.push_bind("");
            }
            q.push(")");
        }
        if let Some(kinds) = &self.kinds {
            q.push(" AND e.kind IN (");
            let mut sep = q.separated(", ");
            for k in kinds {
                sep.push_bind(k.as_str());
            }
            if kinds.is_empty() {
                sep.push_bind("");
            }
            q.push(")");
        }
    }
}

/// The store's half of the feed: the channel, the last id sent on it, and the
/// shutdown signal subscribers watch.
pub(crate) struct Feed {
    tx: broadcast::Sender<Arc<FeedEvent>>,
    last: Mutex<i64>,
    closed: watch::Sender<bool>,
}

impl Feed {
    pub(crate) fn new(last: i64, capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity.max(1));
        let (closed, _) = watch::channel(false);
        Self {
            tx,
            last: Mutex::new(last),
            closed,
        }
    }

    /// Set the mark the first publish reads after.
    pub(crate) async fn start_at(&self, last: i64) {
        *self.last.lock().await = last;
    }
}

const FEED_SELECT: &str = "SELECT e.event_id, e.ts, e.author_email, e.agent, e.surface, e.kind, \
     e.body, e.fields, e.fields_before, e.project, e.target_kind, e.target_id, \
     CASE e.target_kind \
       WHEN 'item' THEN (SELECT title FROM items WHERE id = e.target_id) \
       WHEN 'spec' THEN (SELECT title FROM specs WHERE project = e.project AND slug = e.target_id) \
       WHEN 'milestone' THEN (SELECT title FROM milestones WHERE project = e.project \
         AND spec_slug || '/' || code = e.target_id) \
       WHEN 'concept' THEN (SELECT title FROM concepts WHERE project = e.project AND slug = e.target_id) \
       WHEN 'document' THEN (SELECT title FROM documents WHERE id = e.target_id) \
     END AS title \
     FROM events e WHERE e.event_id > ";

#[derive(sqlx::FromRow)]
struct FeedRow {
    #[sqlx(flatten)]
    event: EventRow,
    project: String,
    target_kind: String,
    target_id: String,
    title: Option<String>,
}

impl FeedRow {
    fn into_feed_event(self) -> TResult<FeedEvent> {
        let target_kind = self.target_kind.parse()?;
        let e = self.event.into_event()?;
        Ok(FeedEvent {
            event_id: e.event_id,
            ts: e.ts,
            project: self.project,
            target_kind,
            target_id: self.target_id,
            title: self.title,
            author_email: e.author_email,
            agent: e.agent,
            surface: e.surface,
            kind: e.kind,
            body: e.body,
            fields: e.fields,
            before: e.before,
        })
    }
}

impl TrackerStore {
    /// This store with a feed buffering `capacity` events per subscriber
    /// instead of [`FEED_CAPACITY`]. Call it straight after
    /// [`TrackerStore::open`], before the store is cloned or subscribed to:
    /// it replaces the feed of this handle only. The lag tests use it.
    pub async fn with_feed_capacity(mut self, capacity: usize) -> Self {
        let last = *self.feed.last.lock().await;
        self.feed = Arc::new(Feed::new(last, capacity));
        self
    }

    /// Commit a write transaction, then publish what it appended to the feed.
    /// Every write path that appends an event commits through here.
    pub(crate) async fn commit(&self, tx: sqlx::Transaction<'static, Sqlite>) -> TResult<()> {
        tx.commit().await?;
        self.publish().await;
        Ok(())
    }

    /// Send every event committed since the last publish, in id order. Never
    /// fails the write that called it: a read error is logged and the next
    /// publish catches up.
    pub(crate) async fn publish(&self) {
        let mut last = self.feed.last.lock().await;
        if self.feed.tx.receiver_count() == 0 {
            // Nobody listening: move the mark on without reading the rows. The
            // maximum is read **before** the receivers are counted: a
            // subscriber counted as absent subscribes after that read, so its
            // replay sees every id up to the maximum; anything newer is
            // published by its own write, which will count the subscriber.
            let max = match self.latest_event_id().await {
                Ok(max) => max,
                Err(e) => {
                    tracing::warn!(error = %e, "tracker feed: could not read the last event id");
                    return;
                }
            };
            if self.feed.tx.receiver_count() == 0 {
                *last = max.max(*last);
                return;
            }
        }
        match self.events_after(&FeedFilter::default(), *last, None).await {
            Ok(events) => {
                for e in events {
                    *last = e.event_id;
                    // An error here only means every receiver has gone.
                    let _ = self.feed.tx.send(Arc::new(e));
                }
            }
            Err(e) => tracing::warn!(error = %e, "tracker feed: could not read new events"),
        }
    }

    /// Listen to the feed: every event committed from now on, in id order.
    /// Subscribe **before** replaying with [`TrackerStore::events_after`], then
    /// drop any id already replayed, and nothing is lost or repeated.
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<FeedEvent>> {
        self.feed.tx.subscribe()
    }

    /// A signal that turns `true` when the server is shutting down
    /// ([`TrackerStore::close_feed`]), so a feed can say goodbye.
    pub fn feed_closing(&self) -> watch::Receiver<bool> {
        self.feed.closed.subscribe()
    }

    /// Tell every feed the server is going away. Returns how many were
    /// listening, so the caller can give them a moment to close cleanly.
    pub fn close_feed(&self) -> usize {
        let listening = self.feed.closed.receiver_count();
        self.feed.closed.send_replace(true);
        listening
    }

    /// The events after `since` that pass `filter`, oldest first, at most
    /// `limit` of them (`None`: all).
    pub async fn events_after(
        &self,
        filter: &FeedFilter,
        since: i64,
        limit: Option<i64>,
    ) -> TResult<Vec<FeedEvent>> {
        let mut q = QueryBuilder::<Sqlite>::new(FEED_SELECT);
        q.push_bind(since);
        filter.push_where(&mut q);
        q.push(" ORDER BY e.event_id");
        if let Some(limit) = limit {
            q.push(" LIMIT ").push_bind(limit);
        }
        let rows: Vec<FeedRow> = q.build_query_as().fetch_all(&self.pool).await?;
        rows.into_iter().map(FeedRow::into_feed_event).collect()
    }

    /// How many events after `since` pass `filter`.
    pub async fn count_events_after(&self, filter: &FeedFilter, since: i64) -> TResult<i64> {
        let mut q =
            QueryBuilder::<Sqlite>::new("SELECT COUNT(*) FROM events e WHERE e.event_id > ");
        q.push_bind(since);
        filter.push_where(&mut q);
        Ok(q.build_query_scalar().fetch_one(&self.pool).await?)
    }

    /// The newest event id in the store (every project; ids are global), `0`
    /// when there are none. Where a feed starts when it wants only what comes
    /// next.
    pub async fn latest_event_id(&self) -> TResult<i64> {
        let max: Option<i64> = sqlx::query_scalar("SELECT MAX(event_id) FROM events")
            .fetch_one(&self.pool)
            .await?;
        Ok(max.unwrap_or(0))
    }
}
