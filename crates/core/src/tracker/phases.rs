//! A project's roadmap (`spec:roadmap`): an ordered list of **phases**, each
//! holding tickets out of the queue until it is released.
//!
//! A phase's own order is kept here, in `phases.prev_id` and `next_id` with the
//! ends on the project row (`roadmap_link_at`, `roadmap_unlink`, `roadmap_walk`:
//! the queue's algorithm over a different table). Its frozen tickets' order is in
//! `list.rs`, whose [`Owner::Phase`] reads `phases.head_id` and `tail_id`.
//!
//! The ticket-level writes (`create_item_in_phase`, `set_item_phase`, the status
//! rule) are in `items.rs`. This module has the phase's writes, each one
//! `BEGIN IMMEDIATE` transaction committing through [`TrackerStore::commit`],
//! among them **release** (D11), which joins the phase's list to the queue, and
//! **recall** (D12), which undoes it for the tickets still `pending`, and the
//! integrity check of it all (D3, [`phase_problems`]).

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::{json, Map, Value};
use sqlx::SqliteConnection;

use super::items::{item_seq, load_items, retain_label};
use super::list::{self, Owner, Place};
use super::{
    append_event, ensure_project, events_for, given_note, now_iso, queued_status, refused,
    require_title, Actor, Event, EventKind, Item, ItemStatus, ItemType, PhaseState, TResult,
    TargetKind, TrackerError, TrackerStore, Who,
};

/// A phase (spec:roadmap D1).
#[derive(Debug, Clone, Serialize)]
pub struct Phase {
    /// `<project>-p<seq:04>`, minted by the server.
    pub id: String,
    pub project: String,
    pub title: String,
    /// Markdown.
    pub body: String,
    pub state: PhaseState,
    /// Its neighbours on the roadmap; planned phases only.
    pub prev_id: Option<String>,
    pub next_id: Option<String>,
    /// The ends of its list of frozen tickets; planned phases only.
    pub head_id: Option<String>,
    pub tail_id: Option<String>,
    /// Always serialised, `null` included: a client recognises a phase by it.
    pub released_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// A phase's size and progress (spec:roadmap D25), from its linked tickets.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct PhaseSize {
    /// Frozen, drafts left out.
    pub frozen: i64,
    /// Unfrozen and not done or cancelled, drafts left out.
    pub open: i64,
    /// Done, drafts left out.
    pub done: i64,
    /// Cancelled, drafts left out.
    pub cancelled: i64,
    /// Every linked draft, whatever its status.
    pub drafts: i64,
    /// Blocked, of `frozen` and `open`.
    pub blocked: i64,
    /// Every linked ticket.
    pub total: i64,
    /// Released, with at least one linked ticket and all of them `done` or
    /// `cancelled` (D15, by status alone: a pending draft is open).
    pub complete: bool,
}

/// A phase with its size and, when asked for, its history and tickets.
#[derive(Debug, Clone, Serialize)]
pub struct PhaseRecord {
    #[serde(flatten)]
    pub phase: Phase,
    pub size: PhaseSize,
    /// Oldest first. Empty when the caller asked for the record alone.
    pub events: Vec<Event>,
    /// Frozen in phase order, then unfrozen queued in queue order, then the rest
    /// by age.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tickets: Option<Vec<Item>>,
    /// What the phase's next release or recall would leave waiting across the
    /// boundary (D13), so a confirmation can state it first.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub would_wait: Option<Vec<Waiting>>,
}

/// A ticket left waiting across the boundary (D13): an unfrozen queued ticket
/// with a `depends_on` on a frozen one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Waiting {
    pub ticket: String,
    pub on: String,
}

/// The reply to a release or a recall (D13).
#[derive(Debug, Clone, Serialize)]
pub struct PhaseOutcome {
    #[serde(flatten)]
    pub record: PhaseRecord,
    /// The tickets it moved.
    pub moved: i64,
    /// A release's place in the queue: `bottom`, `top`, `before <id>` or
    /// `after <id>`. `None` on a recall.
    pub placed: Option<String>,
    /// What the write left waiting across the boundary. It does not refuse.
    pub waiting: Vec<Waiting>,
}

/// A change to a ticket's phase ([`TrackerStore::set_item_phase`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PhaseChange {
    /// Link it to this phase, moving it as the phase's state says (D8).
    Set(String),
    /// Remove its link (D9).
    Clear,
    /// `false` pulls it to the queue; `true` re-freezes it in its own phase (D9).
    Frozen(bool),
}

/// Input to [`TrackerStore::create_phase`].
#[derive(Debug, Clone)]
pub struct NewPhase {
    pub project: String,
    pub title: String,
    pub body: String,
    /// Where it joins the roadmap; normally [`Place::Bottom`].
    pub place: Place,
    pub note: Option<String>,
}

/// Input to [`TrackerStore::update_phase`]. `None` leaves a field alone; a value
/// equal to the current one is not a change.
#[derive(Debug, Clone, Default)]
pub struct PhaseUpdate {
    pub title: Option<String>,
    pub body: Option<String>,
    /// Optional with a change; alone, it is a note and must not be blank.
    pub note: Option<String>,
}

#[derive(sqlx::FromRow)]
struct PhaseRow {
    id: String,
    project: String,
    title: String,
    body: String,
    state: String,
    prev_id: Option<String>,
    next_id: Option<String>,
    head_id: Option<String>,
    tail_id: Option<String>,
    released_at: Option<String>,
    created_at: String,
    updated_at: String,
}

const PHASE_COLS: &str = "id, project, title, body, state, prev_id, next_id, head_id, tail_id, \
     released_at, created_at, updated_at";

impl PhaseRow {
    fn into_phase(self) -> TResult<Phase> {
        Ok(Phase {
            id: self.id,
            project: self.project,
            title: self.title,
            body: self.body,
            state: self.state.parse()?,
            prev_id: self.prev_id,
            next_id: self.next_id,
            head_id: self.head_id,
            tail_id: self.tail_id,
            released_at: self.released_at,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

pub(super) async fn load_phase(conn: &mut SqliteConnection, id: &str) -> TResult<Option<Phase>> {
    sqlx::query_as::<_, PhaseRow>(&format!("SELECT {PHASE_COLS} FROM phases WHERE id = ?"))
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?
        .map(PhaseRow::into_phase)
        .transpose()
}

pub(super) async fn must_phase(conn: &mut SqliteConnection, id: &str) -> TResult<Phase> {
    load_phase(conn, id)
        .await?
        .ok_or_else(|| TrackerError::NotFound(format!("no phase {id:?}")))
}

// ---- Size (D25) ---------------------------------------------------------------

/// Adds up a phase's grouped ticket rows into its [`PhaseSize`].
#[derive(Default)]
pub(super) struct Tally {
    size: PhaseSize,
    /// Linked tickets of a status other than `done` or `cancelled`.
    unclosed: i64,
}

impl Tally {
    pub(super) fn add(&mut self, status: &str, draft: bool, frozen: bool, blocked: bool, n: i64) {
        let closed = matches!(status, "done" | "cancelled");
        self.size.total += n;
        if !closed {
            self.unclosed += n;
        }
        if draft {
            self.size.drafts += n;
            return;
        }
        if blocked && !closed {
            self.size.blocked += n;
        }
        if frozen {
            self.size.frozen += n;
        } else {
            match status {
                "done" => self.size.done += n,
                "cancelled" => self.size.cancelled += n,
                _ => self.size.open += n,
            }
        }
    }

    pub(super) fn size(&self, state: PhaseState) -> PhaseSize {
        PhaseSize {
            complete: self.size.total > 0 && self.unclosed == 0 && state == PhaseState::Released,
            ..self.size
        }
    }
}

async fn size_of(conn: &mut SqliteConnection, phase: &Phase) -> TResult<PhaseSize> {
    let rows: Vec<(String, i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT status, draft, frozen, blocked, COUNT(*) FROM items WHERE phase_id = ? \
         GROUP BY status, draft, frozen, blocked",
    )
    .bind(&phase.id)
    .fetch_all(&mut *conn)
    .await?;
    let mut tally = Tally::default();
    for (status, draft, frozen, blocked, n) in rows {
        tally.add(&status, draft != 0, frozen != 0, blocked != 0, n);
    }
    Ok(tally.size(phase.state))
}

// ---- The roadmap's list ---------------------------------------------------------

async fn roadmap_ends(
    conn: &mut SqliteConnection,
    project: &str,
) -> TResult<(Option<String>, Option<String>)> {
    let row: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT roadmap_head_id, roadmap_tail_id FROM projects WHERE name = ?")
            .bind(project)
            .fetch_optional(&mut *conn)
            .await?;
    row.ok_or_else(|| TrackerError::NotFound(format!("no project {project:?}")))
}

async fn set_roadmap_ends(
    conn: &mut SqliteConnection,
    project: &str,
    head: &Option<String>,
    tail: &Option<String>,
) -> TResult<()> {
    sqlx::query("UPDATE projects SET roadmap_head_id = ?, roadmap_tail_id = ? WHERE name = ?")
        .bind(head)
        .bind(tail)
        .bind(project)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

async fn set_phase_prev(conn: &mut SqliteConnection, id: &str, prev: Option<&str>) -> TResult<()> {
    sqlx::query("UPDATE phases SET prev_id = ? WHERE id = ?")
        .bind(prev)
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

async fn set_phase_next(conn: &mut SqliteConnection, id: &str, next: Option<&str>) -> TResult<()> {
    sqlx::query("UPDATE phases SET next_id = ? WHERE id = ?")
        .bind(next)
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

async fn phase_links(
    conn: &mut SqliteConnection,
    id: &str,
) -> TResult<(Option<String>, Option<String>)> {
    let row: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT prev_id, next_id FROM phases WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?;
    row.ok_or_else(|| TrackerError::NotFound(format!("no phase {id:?}")))
}

/// Refuse an anchor that is `phase` itself, or is not a planned phase of `project`.
async fn check_roadmap_anchor(
    conn: &mut SqliteConnection,
    project: &str,
    phase: &str,
    anchor: &str,
) -> TResult<()> {
    if anchor == phase {
        return refused(format!("cannot place {phase} relative to itself"));
    }
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT project, state FROM phases WHERE id = ?")
            .bind(anchor)
            .fetch_optional(&mut *conn)
            .await?;
    match row {
        None => refused(format!("no phase {anchor:?} to place {phase} relative to")),
        Some((p, _)) if p != project => refused(format!(
            "{anchor} belongs to project {p}, not {project}: phases move only within their own \
             roadmap"
        )),
        Some((_, state)) if state != PhaseState::Planned.as_str() => refused(format!(
            "{anchor} is {state} and not on the roadmap; place {phase} relative to a planned phase"
        )),
        Some(_) => Ok(()),
    }
}

/// Link `phase` (currently unlinked) into `project`'s roadmap at `place`.
pub(super) async fn roadmap_link_at(
    conn: &mut SqliteConnection,
    project: &str,
    phase: &str,
    place: &Place,
) -> TResult<()> {
    let (mut head, mut tail) = roadmap_ends(conn, project).await?;
    let (prev, next): (Option<String>, Option<String>) = match place {
        Place::Top => (None, head.clone()),
        Place::Bottom => (tail.clone(), None),
        Place::Before(anchor) => {
            check_roadmap_anchor(conn, project, phase, anchor).await?;
            let (anchor_prev, _) = phase_links(conn, anchor).await?;
            (anchor_prev, Some(anchor.clone()))
        }
        Place::After(anchor) => {
            check_roadmap_anchor(conn, project, phase, anchor).await?;
            let (_, anchor_next) = phase_links(conn, anchor).await?;
            (Some(anchor.clone()), anchor_next)
        }
    };
    sqlx::query("UPDATE phases SET prev_id = ?, next_id = ? WHERE id = ?")
        .bind(&prev)
        .bind(&next)
        .bind(phase)
        .execute(&mut *conn)
        .await?;
    match &prev {
        Some(p) => set_phase_next(conn, p, Some(phase)).await?,
        None => head = Some(phase.to_string()),
    }
    match &next {
        Some(n) => set_phase_prev(conn, n, Some(phase)).await?,
        None => tail = Some(phase.to_string()),
    }
    set_roadmap_ends(conn, project, &head, &tail).await
}

/// Take `phase` off `project`'s roadmap, joining its neighbours.
pub(super) async fn roadmap_unlink(
    conn: &mut SqliteConnection,
    project: &str,
    phase: &str,
) -> TResult<()> {
    let (mut head, mut tail) = roadmap_ends(conn, project).await?;
    let (prev, next) = phase_links(conn, phase).await?;
    match &prev {
        Some(p) => set_phase_next(conn, p, next.as_deref()).await?,
        None => head = next.clone(),
    }
    match &next {
        Some(n) => set_phase_prev(conn, n, prev.as_deref()).await?,
        None => tail = prev.clone(),
    }
    sqlx::query("UPDATE phases SET prev_id = NULL, next_id = NULL WHERE id = ?")
        .bind(phase)
        .execute(&mut *conn)
        .await?;
    set_roadmap_ends(conn, project, &head, &tail).await
}

/// The roadmap's links, for [`roadmap_walk`] and its plan test.
pub(super) const ROADMAP_WALK_SQL: &str =
    "SELECT id, next_id FROM phases WHERE project = ? AND state = 'planned'";

/// `project`'s planned phases in roadmap order, by walking from the head. Stops
/// (rather than looping) on a cycle; [`phase_problems`] reports it. An unknown
/// project has none.
pub(super) async fn roadmap_walk(
    conn: &mut SqliteConnection,
    project: &str,
) -> TResult<Vec<String>> {
    let Ok((head, _)) = roadmap_ends(conn, project).await else {
        return Ok(Vec::new());
    };
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(ROADMAP_WALK_SQL)
        .bind(project)
        .fetch_all(&mut *conn)
        .await?;
    let next: HashMap<String, Option<String>> = rows.into_iter().collect();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut cur = head;
    while let Some(id) = cur {
        if !seen.insert(id.clone()) {
            break;
        }
        cur = next.get(&id).cloned().flatten();
        out.push(id);
    }
    Ok(out)
}

// ---- The boundary list (D13) ----------------------------------------------------

/// Whether a ticket is frozen once a write is done: as it is now, or as the
/// phase's next release or recall would leave it.
#[derive(Debug, Clone, Copy)]
enum After<'a> {
    /// The write is done: the row as it now is.
    AsIs,
    /// This planned phase is released: only other phases' tickets stay frozen.
    Release(&'a str),
    /// This released phase is recalled: its `pending` tickets freeze too.
    Recall(&'a str),
}

impl After<'_> {
    fn frozen(self, frozen: bool, phase: Option<&str>, status: &str) -> bool {
        match self {
            After::AsIs => frozen,
            After::Release(this) => frozen && phase != Some(this),
            After::Recall(this) => {
                frozen || (phase == Some(this) && status == ItemStatus::Pending.as_str())
            }
        }
    }
}

/// Each ticket left waiting across the boundary once a write is done (D13): an
/// unfrozen queued ticket with a `depends_on` on a frozen one, where either is
/// linked to `phase_id`. Sorted by waiter, then target.
async fn waiting_pairs(
    conn: &mut SqliteConnection,
    project: &str,
    phase_id: &str,
    after: After<'_>,
) -> TResult<Vec<Waiting>> {
    type Row = (
        String,
        String,
        i64,
        Option<String>,
        String,
        String,
        i64,
        Option<String>,
    );
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT w.id, w.status, w.frozen, w.phase_id, t.id, t.status, t.frozen, t.phase_id \
         FROM item_depends d JOIN items w ON w.id = d.item_id JOIN items t ON t.id = d.depends_on \
         WHERE w.project = ?",
    )
    .bind(project)
    .fetch_all(&mut *conn)
    .await?;
    let mut out = Vec::new();
    for (waiter, w_status, w_frozen, w_phase, target, t_status, t_frozen, t_phase) in rows {
        let queued = w_status.parse::<ItemStatus>().is_ok_and(queued_status);
        let keeps = queued
            && !after.frozen(w_frozen != 0, w_phase.as_deref(), &w_status)
            && after.frozen(t_frozen != 0, t_phase.as_deref(), &t_status)
            && (w_phase.as_deref() == Some(phase_id) || t_phase.as_deref() == Some(phase_id));
        if keeps {
            out.push(Waiting {
                ticket: waiter,
                on: target,
            });
        }
    }
    out.sort_by_key(|w| (item_seq(&w.ticket), item_seq(&w.on)));
    Ok(out)
}

/// What `phase`'s next release or recall would leave waiting (D13). An archived
/// phase has neither to come.
async fn would_wait(conn: &mut SqliteConnection, phase: &Phase) -> TResult<Vec<Waiting>> {
    let after = match phase.state {
        PhaseState::Planned => After::Release(&phase.id),
        PhaseState::Released => After::Recall(&phase.id),
        PhaseState::Archived => return Ok(Vec::new()),
    };
    waiting_pairs(conn, &phase.project, &phase.id, after).await
}

/// `phase`'s linked tickets: frozen in phase order, then unfrozen queued in queue
/// order, then the rest by age.
async fn phase_items(conn: &mut SqliteConnection, phase: &Phase) -> TResult<Vec<Item>> {
    let mut items = load_items(
        conn,
        &phase.project,
        "AND phase_id = ?",
        Some(phase.id.as_str()),
    )
    .await?;
    let in_phase = list::walk(conn, &Owner::Phase(&phase.id)).await?;
    let in_queue = list::walk(conn, &Owner::Queue(&phase.project)).await?;
    let rank: HashMap<&str, (u8, i64)> = in_phase
        .iter()
        .enumerate()
        .map(|(k, id)| (id.as_str(), (0u8, k as i64)))
        .chain(
            in_queue
                .iter()
                .enumerate()
                .map(|(k, id)| (id.as_str(), (1u8, k as i64))),
        )
        .collect();
    items.sort_by_key(|i| {
        rank.get(i.id.as_str())
            .copied()
            .unwrap_or((2, item_seq(&i.id)))
    });
    Ok(items)
}

/// The words a release's place is said in (D18).
fn place_said(place: &Place) -> String {
    match place {
        Place::Top => "top".to_string(),
        Place::Bottom => "bottom".to_string(),
        Place::Before(a) => format!("before {a}"),
        Place::After(a) => format!("after {a}"),
    }
}

/// An event's body that always begins with what happened (D18): a note follows
/// it, and never replaces it.
fn announced(what: &str, note: Option<&str>) -> String {
    match given_note(note) {
        Some(note) => format!("{what} {note}"),
        None => what.to_string(),
    }
}

/// Set a phase's state and write the `edit` event saying so.
async fn write_state(
    conn: &mut SqliteConnection,
    phase: &Phase,
    to: PhaseState,
    body: &str,
    who: &Who,
    now: &str,
) -> TResult<()> {
    sqlx::query("UPDATE phases SET state = ?, updated_at = ? WHERE id = ?")
        .bind(to.as_str())
        .bind(now)
        .bind(&phase.id)
        .execute(&mut *conn)
        .await?;
    append_event(
        conn,
        &phase.project,
        TargetKind::Phase,
        &phase.id,
        who,
        EventKind::Edit,
        body,
        &json!({ "state": to }),
        Some(&json!({ "state": phase.state })),
        now,
    )
    .await?;
    Ok(())
}

impl TrackerStore {
    /// Create a phase (D1): `planned`, on the roadmap at `place`. Its id is
    /// `<project>-p<seq:04>`, the sequence per project and never reused.
    pub async fn create_phase(&self, new: NewPhase, actor: &Actor) -> TResult<PhaseRecord> {
        let who = actor.validated()?;
        let title = require_title(&new.title)?;
        let now = now_iso();
        let mut tx = self.write_tx().await?;
        ensure_project(&mut tx, &new.project, &now).await?;
        let seq: i64 = sqlx::query_scalar(
            "UPDATE projects SET phase_seq = phase_seq + 1 WHERE name = ? RETURNING phase_seq",
        )
        .bind(&new.project)
        .fetch_one(&mut *tx)
        .await?;
        let id = format!("{}-p{seq:04}", new.project);
        sqlx::query(
            "INSERT INTO phases (id, project, seq, title, body, state, created_at, updated_at) \
             VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(&id)
        .bind(&new.project)
        .bind(seq)
        .bind(&title)
        .bind(&new.body)
        .bind(PhaseState::Planned.as_str())
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        roadmap_link_at(&mut tx, &new.project, &id, &new.place).await?;
        let body = given_note(new.note.as_deref()).unwrap_or_else(|| "Created phase.".to_string());
        append_event(
            &mut tx,
            &new.project,
            TargetKind::Phase,
            &id,
            &who,
            EventKind::Create,
            &body,
            &json!({ "title": title, "state": PhaseState::Planned, "place": new.place }),
            None,
            &now,
        )
        .await?;
        self.commit(tx).await?;
        self.written_phase(&id).await
    }

    /// A phase, with its history when `history`, and with its tickets and what its
    /// next release or recall would leave waiting (D13) when `tickets`.
    pub async fn get_phase(
        &self,
        id: &str,
        history: bool,
        tickets: bool,
    ) -> TResult<Option<PhaseRecord>> {
        let mut tx = self.pool.begin().await?;
        let Some(phase) = load_phase(&mut tx, id).await? else {
            return Ok(None);
        };
        let size = size_of(&mut tx, &phase).await?;
        let events = if history {
            events_for(&mut tx, &phase.project, TargetKind::Phase, id).await?
        } else {
            Vec::new()
        };
        let (tickets, would) = if tickets {
            (
                Some(phase_items(&mut tx, &phase).await?),
                Some(would_wait(&mut tx, &phase).await?),
            )
        } else {
            (None, None)
        };
        tx.commit().await?;
        Ok(Some(PhaseRecord {
            phase,
            size,
            events,
            tickets,
            would_wait: would,
        }))
    }

    /// The record a write replies with: the phase and its history.
    async fn written_phase(&self, id: &str) -> TResult<PhaseRecord> {
        self.get_phase(id, true, false)
            .await?
            .ok_or_else(|| TrackerError::Internal("phase vanished after a write".into()))
    }

    /// A phase's title or body, in any state. One event: an `edit`, or a `note`
    /// when only a note was given. A call that changes nothing and says nothing is
    /// refused.
    pub async fn update_phase(
        &self,
        id: &str,
        upd: PhaseUpdate,
        actor: &Actor,
    ) -> TResult<PhaseRecord> {
        let who = actor.validated()?;
        let now = now_iso();
        let mut tx = self.write_tx().await?;
        let phase = must_phase(&mut tx, id).await?;
        let mut fields = Map::new();
        let mut before = Map::new();
        if let Some(title) = &upd.title {
            let title = require_title(title)?;
            if title != phase.title {
                sqlx::query("UPDATE phases SET title = ? WHERE id = ?")
                    .bind(&title)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
                fields.insert("title".to_string(), json!(title));
                before.insert("title".to_string(), json!(phase.title));
            }
        }
        if let Some(body) = upd.body.as_ref().filter(|b| **b != phase.body) {
            sqlx::query("UPDATE phases SET body = ? WHERE id = ?")
                .bind(body)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            fields.insert("body".to_string(), json!(body));
            before.insert("body".to_string(), json!(phase.body));
        }
        let (kind, body) = match (fields.is_empty(), given_note(upd.note.as_deref())) {
            (true, None) => {
                return refused(format!(
                    "nothing to update on {id}: no field changed and no note given"
                ))
            }
            (true, Some(note)) => (EventKind::Note, note),
            (false, Some(note)) => (EventKind::Edit, note),
            (false, None) => {
                let names: Vec<&str> = fields.keys().map(String::as_str).collect();
                (EventKind::Edit, format!("Set {}.", names.join(", ")))
            }
        };
        sqlx::query("UPDATE phases SET updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        append_event(
            &mut tx,
            &phase.project,
            TargetKind::Phase,
            id,
            &who,
            kind,
            &body,
            &Value::Object(fields),
            Some(&Value::Object(before)),
            &now,
        )
        .await?;
        self.commit(tx).await?;
        self.written_phase(id).await
    }

    /// Move a planned phase on the roadmap (D10): `before` or `after` another
    /// planned phase of the project, or to the `top` or `bottom`.
    pub async fn move_phase(
        &self,
        id: &str,
        place: Place,
        note: Option<&str>,
        actor: &Actor,
    ) -> TResult<PhaseRecord> {
        let who = actor.validated()?;
        let now = now_iso();
        let mut tx = self.write_tx().await?;
        let phase = must_phase(&mut tx, id).await?;
        if phase.state != PhaseState::Planned {
            return refused(format!(
                "{id} is {}: only a planned phase moves on the roadmap",
                phase.state
            ));
        }
        // A refused anchor drops the transaction, unlink included.
        if let Place::Before(a) | Place::After(a) = &place {
            check_roadmap_anchor(&mut tx, &phase.project, id, a).await?;
        }
        roadmap_unlink(&mut tx, &phase.project, id).await?;
        roadmap_link_at(&mut tx, &phase.project, id, &place).await?;
        let prev_id: Option<String> = sqlx::query_scalar("SELECT prev_id FROM phases WHERE id = ?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        sqlx::query("UPDATE phases SET updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let body = given_note(note).unwrap_or_else(|| match &place {
            Place::Top => "Moved to the top.".to_string(),
            Place::Bottom => "Moved to the bottom.".to_string(),
            Place::Before(a) => format!("Moved before {a}."),
            Place::After(a) => format!("Moved after {a}."),
        });
        append_event(
            &mut tx,
            &phase.project,
            TargetKind::Phase,
            id,
            &who,
            EventKind::Move,
            &body,
            &json!({ "place": place, "prev_id": prev_id }),
            Some(&json!({ "prev_id": phase.prev_id })),
            &now,
        )
        .await?;
        self.commit(tx).await?;
        self.written_phase(id).await
    }

    /// Archive a phase (D14): a released one, or a planned one with no open ticket,
    /// which leaves the roadmap. Phases are never deleted.
    pub async fn archive_phase(
        &self,
        id: &str,
        note: Option<&str>,
        actor: &Actor,
    ) -> TResult<PhaseRecord> {
        let who = actor.validated()?;
        let now = now_iso();
        let mut tx = self.write_tx().await?;
        let phase = must_phase(&mut tx, id).await?;
        match phase.state {
            PhaseState::Archived => return refused(format!("{id} is already archived")),
            PhaseState::Released => {}
            PhaseState::Planned => {
                let open: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM items WHERE phase_id = ? \
                     AND status NOT IN ('done', 'cancelled')",
                )
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
                if open > 0 {
                    return refused(format!(
                        "{id} is planned and has {open} open {}: cancel, move or release them \
                         first",
                        if open == 1 { "ticket" } else { "tickets" }
                    ));
                }
                roadmap_unlink(&mut tx, &phase.project, id).await?;
            }
        }
        let body = given_note(note).unwrap_or_else(|| "Phase archived.".to_string());
        write_state(&mut tx, &phase, PhaseState::Archived, &body, &who, &now).await?;
        self.commit(tx).await?;
        self.written_phase(id).await
    }

    /// Unarchive a phase (D14): `released` again if it has a `released_at`, else
    /// `planned` at the roadmap's bottom.
    pub async fn unarchive_phase(
        &self,
        id: &str,
        note: Option<&str>,
        actor: &Actor,
    ) -> TResult<PhaseRecord> {
        let who = actor.validated()?;
        let now = now_iso();
        let mut tx = self.write_tx().await?;
        let phase = must_phase(&mut tx, id).await?;
        if phase.state != PhaseState::Archived {
            return refused(format!(
                "{id} is {}: only an archived phase can be unarchived",
                phase.state
            ));
        }
        let to = if phase.released_at.is_some() {
            PhaseState::Released
        } else {
            roadmap_link_at(&mut tx, &phase.project, id, &Place::Bottom).await?;
            PhaseState::Planned
        };
        let body = given_note(note).unwrap_or_else(|| "Phase unarchived.".to_string());
        write_state(&mut tx, &phase, to, &body, &who, &now).await?;
        self.commit(tx).await?;
        self.written_phase(id).await
    }

    /// A phase's linked tickets in [`PhaseRecord::tickets`]' order, frozen included,
    /// optionally only those with `status` and only those carrying `label`.
    /// `NotFound` for an unknown phase or one of another project.
    pub async fn list_phase_items(
        &self,
        project: &str,
        phase_id: &str,
        status: Option<ItemStatus>,
        label: Option<&str>,
    ) -> TResult<Vec<Item>> {
        let mut tx = self.pool.begin().await?;
        let phase = load_phase(&mut tx, phase_id)
            .await?
            .filter(|p| p.project == project)
            .ok_or_else(|| {
                TrackerError::NotFound(format!("no phase {phase_id:?} in project {project}"))
            })?;
        let mut items = phase_items(&mut tx, &phase).await?;
        tx.commit().await?;
        if let Some(status) = status {
            items.retain(|i| i.status == status);
        }
        retain_label(&mut items, label);
        Ok(items)
    }

    /// Release a planned phase (D11, D13, D16, D18), in one transaction: its list
    /// joins the queue at `place`, in order; its tickets thaw, each with a stamped
    /// `move` event that opens its `pending` span; it leaves the roadmap; and,
    /// last, so that it holds the write's last id, its `release` event is written,
    /// the one frame a monitor sees. A phase with no frozen tickets may be released.
    pub async fn release_phase(
        &self,
        id: &str,
        place: Place,
        note: Option<&str>,
        actor: &Actor,
    ) -> TResult<PhaseOutcome> {
        let who = actor.validated()?;
        let now = now_iso();
        let mut tx = self.write_tx().await?;
        let phase = must_phase(&mut tx, id).await?;
        if phase.state != PhaseState::Planned {
            return refused(format!(
                "{id} is {}: only a planned phase can be released",
                phase.state
            ));
        }
        let project = phase.project.as_str();
        let queue = Owner::Queue(project);
        // First, and even with nothing to join: a bad anchor changes nothing.
        if let Place::Before(a) | Place::After(a) = &place {
            list::check_anchor(&mut tx, &queue, id, a).await?;
        }
        let tickets = list::walk(&mut tx, &Owner::Phase(id)).await?;
        if let (Some(head), Some(tail)) = (&phase.head_id, &phase.tail_id) {
            list::join_chain(&mut tx, &queue, head, tail, &place).await?;
        }
        sqlx::query(
            "UPDATE items SET frozen = 0, updated_at = ? WHERE phase_id = ? AND frozen = 1",
        )
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        let body = format!("Released with phase {id}.");
        for ticket in &tickets {
            append_event(
                &mut tx,
                project,
                TargetKind::Item,
                ticket,
                &who,
                EventKind::Move,
                &body,
                &json!({ "frozen": false }),
                Some(&json!({ "frozen": true })),
                &now,
            )
            .await?;
        }
        roadmap_unlink(&mut tx, project, id).await?;
        sqlx::query(
            "UPDATE phases SET state = ?, released_at = ?, head_id = NULL, tail_id = NULL, \
             updated_at = ? WHERE id = ?",
        )
        .bind(PhaseState::Released.as_str())
        .bind(&now)
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        let placed = place_said(&place);
        append_event(
            &mut tx,
            project,
            TargetKind::Phase,
            id,
            &who,
            EventKind::Release,
            &announced("Phase released.", note),
            &json!({
                "state": PhaseState::Released,
                "released_at": now,
                "tickets": tickets.len(),
                "placed": placed,
            }),
            Some(&json!({ "state": phase.state, "released_at": phase.released_at })),
            &now,
        )
        .await?;
        let waiting = waiting_pairs(&mut tx, project, id, After::AsIs).await?;
        self.commit(tx).await?;
        Ok(PhaseOutcome {
            record: self.written_phase(id).await?,
            moved: tickets.len() as i64,
            placed: Some(placed),
            waiting,
        })
    }

    /// Recall a released phase (D12, D13, D16, D18), in one transaction: every
    /// linked ticket of status `pending`, draft or blocked or not, freezes and
    /// returns to the phase's list **in its current queue order**, each with a
    /// stamped `move` event; any other status stays where it is, keeping the link;
    /// the phase joins the **top** of the roadmap; and, last, its `recall` event is
    /// written.
    pub async fn recall_phase(
        &self,
        id: &str,
        note: Option<&str>,
        actor: &Actor,
    ) -> TResult<PhaseOutcome> {
        let who = actor.validated()?;
        let now = now_iso();
        let mut tx = self.write_tx().await?;
        let phase = must_phase(&mut tx, id).await?;
        if phase.state != PhaseState::Released {
            return refused(format!(
                "{id} is {}: only a released phase can be recalled",
                phase.state
            ));
        }
        let project = phase.project.as_str();
        let queue = Owner::Queue(project);
        let own = Owner::Phase(id);
        let pending: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM items WHERE phase_id = ? AND frozen = 0 AND status = 'pending'",
        )
        .bind(id)
        .fetch_all(&mut *tx)
        .await?;
        let pending: HashSet<String> = pending.into_iter().collect();
        let tickets: Vec<String> = list::walk(&mut tx, &queue)
            .await?
            .into_iter()
            .filter(|t| pending.contains(t))
            .collect();
        let body = format!("Recalled with phase {id}.");
        for ticket in &tickets {
            list::unlink(&mut tx, &queue, ticket).await?;
            list::link_at(&mut tx, &own, ticket, &Place::Bottom).await?;
            sqlx::query("UPDATE items SET frozen = 1, updated_at = ? WHERE id = ?")
                .bind(&now)
                .bind(ticket)
                .execute(&mut *tx)
                .await?;
            append_event(
                &mut tx,
                project,
                TargetKind::Item,
                ticket,
                &who,
                EventKind::Move,
                &body,
                &json!({ "frozen": true }),
                Some(&json!({ "frozen": false })),
                &now,
            )
            .await?;
        }
        sqlx::query("UPDATE phases SET state = ?, released_at = NULL, updated_at = ? WHERE id = ?")
            .bind(PhaseState::Planned.as_str())
            .bind(&now)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        roadmap_link_at(&mut tx, project, id, &Place::Top).await?;
        append_event(
            &mut tx,
            project,
            TargetKind::Phase,
            id,
            &who,
            EventKind::Recall,
            &announced("Phase recalled.", note),
            &json!({
                "state": PhaseState::Planned,
                "released_at": null,
                "tickets": tickets.len(),
            }),
            Some(&json!({ "state": phase.state, "released_at": phase.released_at })),
            &now,
        )
        .await?;
        let waiting = waiting_pairs(&mut tx, project, id, After::AsIs).await?;
        self.commit(tx).await?;
        Ok(PhaseOutcome {
            record: self.written_phase(id).await?,
            moved: tickets.len() as i64,
            placed: None,
            waiting,
        })
    }
}

// ---- Integrity (D3) -------------------------------------------------------------

/// One ticket with a phase or a frozen flag, for [`phase_problems`].
#[derive(sqlx::FromRow)]
struct PhaseTicket {
    id: String,
    #[sqlx(rename = "type")]
    item_type: String,
    status: String,
    frozen: i64,
    phase_id: Option<String>,
    prev_id: Option<String>,
    next_id: Option<String>,
}

/// The roadmap's faults in `project`, in words (D3), for the integrity check: a
/// frozen ticket not `pending`, with no phase, or in a phase not planned; a phase
/// of another project on a ticket, or one that does not exist; a request with a
/// phase; a planned phase's walk not covering exactly its frozen tickets, with a
/// cycle or a stale end; a released or archived phase holding an end or a roadmap
/// link; and the roadmap's walk not covering exactly the planned phases, in both
/// directions, with stale ends.
pub(super) async fn phase_problems(
    conn: &mut SqliteConnection,
    project: &str,
) -> TResult<Vec<String>> {
    let mut problems = Vec::new();
    let phases: Vec<Phase> = sqlx::query_as::<_, PhaseRow>(&format!(
        "SELECT {PHASE_COLS} FROM phases WHERE project = ? ORDER BY seq"
    ))
    .bind(project)
    .fetch_all(&mut *conn)
    .await?
    .into_iter()
    .map(PhaseRow::into_phase)
    .collect::<TResult<_>>()?;
    let by_id: HashMap<&str, &Phase> = phases.iter().map(|p| (p.id.as_str(), p)).collect();

    let tickets: Vec<PhaseTicket> = sqlx::query_as(
        "SELECT id, type, status, frozen, phase_id, prev_id, next_id FROM items \
         WHERE project = ? AND (frozen = 1 OR phase_id IS NOT NULL) ORDER BY seq",
    )
    .bind(project)
    .fetch_all(&mut *conn)
    .await?;
    // Each phase's frozen tickets, and every frozen ticket by id.
    let mut members: HashMap<&str, HashSet<&str>> = HashMap::new();
    let mut frozen: HashMap<&str, &PhaseTicket> = HashMap::new();
    for t in &tickets {
        let is_frozen = t.frozen != 0;
        if is_frozen {
            frozen.insert(&t.id, t);
            if t.status != ItemStatus::Pending.as_str() {
                problems.push(format!("{} is frozen but {}", t.id, t.status));
            }
        }
        if t.item_type == ItemType::Request.as_str() {
            if let Some(p) = &t.phase_id {
                problems.push(format!("{} is a request with phase {p}", t.id));
            }
        }
        let Some(p) = t.phase_id.as_deref() else {
            if is_frozen {
                problems.push(format!("{} is frozen with no phase", t.id));
            }
            continue;
        };
        match by_id.get(p) {
            Some(phase) => {
                if is_frozen {
                    members.entry(p).or_default().insert(&t.id);
                    if phase.state != PhaseState::Planned {
                        problems.push(format!(
                            "{} is frozen in phase {p}, which is {}",
                            t.id, phase.state
                        ));
                    }
                }
            }
            None => {
                let theirs: Option<String> =
                    sqlx::query_scalar("SELECT project FROM phases WHERE id = ?")
                        .bind(p)
                        .fetch_optional(&mut *conn)
                        .await?;
                problems.push(match theirs {
                    Some(other) => format!("{} names phase {p}, of project {other}", t.id),
                    None => format!("{} names phase {p}, which does not exist", t.id),
                });
            }
        }
    }

    // Each phase's list.
    let none = HashSet::new();
    for phase in &phases {
        let id = phase.id.as_str();
        let mine = members.get(id).unwrap_or(&none);
        if phase.state != PhaseState::Planned {
            if phase.head_id.is_some() || phase.tail_id.is_some() {
                problems.push(format!(
                    "phase {id} is {} but has head = {:?}, tail = {:?}",
                    phase.state, phase.head_id, phase.tail_id
                ));
            }
            if phase.prev_id.is_some() || phase.next_id.is_some() {
                problems.push(format!(
                    "phase {id} is {} but is linked on the roadmap: prev = {:?}, next = {:?}",
                    phase.state, phase.prev_id, phase.next_id
                ));
            }
            continue;
        }
        let mut seen: HashSet<&str> = HashSet::new();
        let mut last: Option<&str> = None;
        let mut cur = phase.head_id.as_deref();
        while let Some(t) = cur {
            if !seen.insert(t) {
                problems.push(format!("phase {id}: cycle, the walk reaches {t} twice"));
                break;
            }
            if !mine.contains(t) {
                problems.push(format!(
                    "phase {id}: the walk reaches {t}, which is not frozen in it"
                ));
                break;
            }
            last = Some(t);
            cur = frozen.get(t).and_then(|r| r.next_id.as_deref());
        }
        if last != phase.tail_id.as_deref() {
            problems.push(format!(
                "phase {id}: the walk ends at {last:?}, but the tail is {:?}",
                phase.tail_id
            ));
        }
        if let Some(head) = phase.head_id.as_deref().and_then(|h| frozen.get(h)) {
            if let Some(prev) = &head.prev_id {
                problems.push(format!("phase {id}: its head {} has prev {prev}", head.id));
            }
        }
        let mut missed: Vec<&str> = mine
            .iter()
            .copied()
            .filter(|t| !seen.contains(*t))
            .collect();
        if !missed.is_empty() {
            missed.sort_unstable();
            problems.push(format!(
                "phase {id}: frozen but not reached by the walk: {}",
                missed.join(", ")
            ));
        }
    }

    // The roadmap, each way.
    let ends: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT roadmap_head_id, roadmap_tail_id FROM projects WHERE name = ?")
            .bind(project)
            .fetch_optional(&mut *conn)
            .await?;
    let (head, tail) = ends.unwrap_or((None, None));
    let planned: HashSet<&str> = phases
        .iter()
        .filter(|p| p.state == PhaseState::Planned)
        .map(|p| p.id.as_str())
        .collect();
    let walk_roadmap = |from: Option<&str>, forward: bool, problems: &mut Vec<String>| {
        let mut out: Vec<String> = Vec::new();
        let way = if forward { "forward" } else { "backward" };
        let mut seen: HashSet<String> = HashSet::new();
        let mut cur = from.map(str::to_string);
        while let Some(id) = cur {
            if !seen.insert(id.clone()) {
                problems.push(format!(
                    "the roadmap's {way} walk reaches {id} twice: a cycle"
                ));
                break;
            }
            let Some(phase) = by_id.get(id.as_str()) else {
                problems.push(format!(
                    "the roadmap's {way} walk reaches {id}, which is not a phase of this project"
                ));
                break;
            };
            if !planned.contains(id.as_str()) {
                problems.push(format!(
                    "the roadmap's {way} walk reaches {id}, which is {}",
                    phase.state
                ));
            }
            cur = if forward {
                phase.next_id.clone()
            } else {
                phase.prev_id.clone()
            };
            out.push(id);
        }
        out
    };
    let forward = walk_roadmap(head.as_deref(), true, &mut problems);
    let mut backward = walk_roadmap(tail.as_deref(), false, &mut problems);
    backward.reverse();
    if forward != backward {
        problems.push(format!(
            "the roadmap reads {forward:?} forward but {backward:?} backward"
        ));
    }
    if forward.last().map(String::as_str) != tail.as_deref() {
        problems.push(format!(
            "the roadmap's walk ends at {:?}, but its tail is {tail:?}",
            forward.last()
        ));
    }
    let mut missed: Vec<&str> = planned
        .iter()
        .copied()
        .filter(|p| !forward.iter().any(|f| f == p))
        .collect();
    if !missed.is_empty() {
        missed.sort_unstable();
        problems.push(format!(
            "planned but not reached by the roadmap's walk: {}",
            missed.join(", ")
        ));
    }
    Ok(problems)
}
