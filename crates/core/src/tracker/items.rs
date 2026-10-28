//! Queue items (D3, D6, D7, D10): create, read, update, move, acknowledge, and
//! the queue view the dashboard and `tracker_queue` read.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::{json, Map, Value};
use sqlx::SqliteConnection;

use super::labels;
use super::list::{self, Place};
use super::{
    append_event, ensure_project, events_for, given_note, now_iso, refused, require_title,
    validate_link, Actor, Approval, BlockReason, Event, EventKind, Intensity, ItemStatus, ItemType,
    Link, LinkKind, TResult, TargetKind, TrackerError, TrackerStore, Who,
};

/// Whether an item with this status is in the queue (the linked list).
pub fn queued_status(status: ItemStatus) -> bool {
    matches!(
        status,
        ItemStatus::Pending
            | ItemStatus::InProgress
            | ItemStatus::Failed
            | ItemStatus::Deferred
            | ItemStatus::Review
    )
}

/// The queued statuses as an SQL list, for `status IN …`. Must agree with
/// [`queued_status`] (a test checks it).
pub(super) const QUEUED_IN: &str = "('pending', 'in_progress', 'failed', 'deferred', 'review')";

/// The status transitions an item may make (TR-03):
///
/// * `pending` ↔ `in_progress`;
/// * `pending` or `in_progress` → `done` or `failed` (the manager may record quick
///   work done without first marking it in progress: a manager's change to m01's
///   table, made in m02);
/// * any queued status (`pending`, `in_progress`, `failed`, `deferred`,
///   `review`) → `cancelled`;
/// * `done`, `failed` or `cancelled` → `pending` (a reopen);
/// * `pending`, `in_progress` or `failed` → `deferred`, and `deferred` →
///   `pending` (a resume, in place), `in_progress` or `done` (owner,
///   2026-10-27, rag-t0017). A deferred item stays in the list;
/// * `pending`, `in_progress` or `failed` → `review`, and `review` → `done`
///   (confirmed), `in_progress` or `pending` (sent back) (owner, 2026-10-27,
///   rag-t0024). A review item stays in the list.
pub fn transition_allowed(from: ItemStatus, to: ItemStatus) -> bool {
    use ItemStatus::*;
    matches!(
        (from, to),
        (Pending, InProgress)
            | (InProgress, Pending)
            | (Pending | InProgress | Deferred | Review, Done)
            | (Pending | InProgress, Failed)
            | (Pending | InProgress | Failed | Deferred | Review, Cancelled)
            | (Done | Failed | Cancelled | Deferred | Review, Pending)
            | (Pending | InProgress | Failed, Deferred)
            | (Deferred | Review, InProgress)
            | (Pending | InProgress | Failed, Review)
    )
}

/// A queue item.
#[derive(Debug, Clone, Serialize)]
pub struct Item {
    /// `<project>-t<seq:04>`, minted by the server.
    pub id: String,
    pub project: String,
    #[serde(rename = "type")]
    pub item_type: ItemType,
    pub title: String,
    /// Markdown: the brief, the scope, the acceptance.
    pub body: String,
    pub status: ItemStatus,
    pub blocked: bool,
    /// Set while blocked.
    pub block_reason: Option<BlockReason>,
    /// The note the block was made with, if it had one. Only set while blocked.
    pub block_note: Option<String>,
    pub approval: Approval,
    pub assignee: Option<String>,
    /// A gate's intensity; `null` on every other type.
    pub intensity: Option<Intensity>,
    /// A gate's release flag; always `false` on every other type.
    pub release: bool,
    /// May start before the gates above it clear, and still lands after them
    /// (rag-t0013). Never set on a gate.
    pub parallel: bool,
    /// The items it waits on while blocked with reason `dependency`, items of
    /// its own project (rag-t0018). Empty otherwise: cleared when it unblocks.
    pub depends_on: Vec<String>,
    /// Whether the item is in the queue (status `pending`, `in_progress`,
    /// `failed` or `deferred`).
    pub queued: bool,
    pub prev_id: Option<String>,
    pub next_id: Option<String>,
    pub links: Vec<Link>,
    /// Free-text labels (rag-t0027), sorted case-insensitively, in the
    /// project's casing. Empty when it has none.
    pub labels: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub done_at: Option<String>,
    pub acknowledged_at: Option<String>,
}

/// An item with its history.
#[derive(Debug, Clone, Serialize)]
pub struct ItemRecord {
    #[serde(flatten)]
    pub item: Item,
    /// Oldest first. Empty when the caller asked for the record alone.
    pub events: Vec<Event>,
}

/// Input to [`TrackerStore::create_item`].
#[derive(Debug, Clone)]
pub struct NewItem {
    pub project: String,
    pub item_type: ItemType,
    pub title: String,
    pub body: String,
    pub assignee: Option<String>,
    pub approval: Approval,
    pub links: Vec<Link>,
    /// Required on a gate; refused on any other type.
    pub intensity: Option<Intensity>,
    /// Only a gate may be a release.
    pub release: bool,
    /// May start before the gates above it clear (rag-t0013). Refused on a gate.
    pub parallel: bool,
    /// Its labels (rag-t0027); see [`labels::clean_labels`] for the rules.
    pub labels: Vec<String>,
    /// Where it joins the queue; normally [`Place::Bottom`].
    pub place: Place,
    /// Optional; without one the event says what was created.
    pub note: Option<String>,
}

/// Input to [`TrackerStore::update_item`]. `None` (or an empty list) leaves a
/// field alone; a value equal to the current one is not a change.
#[derive(Debug, Clone, Default)]
pub struct ItemUpdate {
    pub status: Option<ItemStatus>,
    /// `Some(true)` blocks (needs `block_reason`), `Some(false)` unblocks.
    pub blocked: Option<bool>,
    /// With `blocked: Some(true)`, or alone to block or to change the reason.
    pub block_reason: Option<BlockReason>,
    /// The items it waits on, replacing the list wholesale (rag-t0018). Only
    /// with reason `dependency` (given now or already held), which needs at
    /// least one; refused otherwise. Items of the same project, not itself, not
    /// waiting on it (no cycle), and not all already done.
    pub depends_on: Option<Vec<String>>,
    pub approval: Option<Approval>,
    /// `Some("")` clears the assignee.
    pub assignee: Option<String>,
    pub title: Option<String>,
    pub body: Option<String>,
    pub add_links: Vec<Link>,
    pub remove_links: Vec<Link>,
    /// Gate only.
    pub intensity: Option<Intensity>,
    /// Gate only.
    pub release: Option<bool>,
    /// Any type but a gate (rag-t0013).
    pub parallel: Option<bool>,
    /// The item's labels, replacing the set wholesale (rag-t0027); `Some(vec![])`
    /// clears them. Order and duplicates do not matter.
    pub labels: Option<Vec<String>>,
    /// Optional with any change (the body is then generated from it); alone, it
    /// is a note and must not be blank.
    pub note: Option<String>,
}

/// The queue view (D14, R12): what the dashboard and `tracker_queue` show.
#[derive(Debug, Clone, Serialize)]
pub struct QueueView {
    pub project: String,
    /// Whether the project has been written to. An unknown project reads as empty.
    pub exists: bool,
    /// The owner's requests waiting to be broken down (rag-t0044): queued
    /// items of type `request`, whatever their status or block, in list
    /// order. Never in `queue`, `review`, `blocked` or `deferred`, so nothing
    /// that reads the queue (`tracker_next`, a gate's batch) sees them.
    pub requests: Vec<Item>,
    /// Done and not yet acknowledged, in the order they finished: oldest first,
    /// newest last (by `done_at`, then id), so the latest sits just above the
    /// queue, as the queue reads (rag-t0029).
    pub done: Vec<Item>,
    /// Items waiting on the owner (status `review`, blocked or not), in list
    /// order (rag-t0024). Each keeps its place in the list. Requests excluded.
    pub review: Vec<Item>,
    /// The queue in list order, gates included, **without** requests, review,
    /// blocked or deferred items.
    pub queue: Vec<Item>,
    /// Blocked items (not deferred or in review), in list order. Each keeps its
    /// place in the list.
    pub blocked: Vec<Item>,
    /// Deferred items, in list order, blocked or not (rag-t0017). Each keeps
    /// its place in the list.
    pub deferred: Vec<Item>,
}

/// One row of [`TrackerStore::list_projects`].
#[derive(Debug, Clone, Serialize)]
pub struct ProjectSummary {
    pub name: String,
    pub created_at: String,
    /// Items in the queue (requests, review, blocked and deferred included).
    pub queued: i64,
    /// Queued requests (rag-t0044), whatever their status or block; counted
    /// under none of the other buckets.
    pub requests: i64,
    /// Blocked items that are not requests, deferred or in review (each of
    /// those is counted under its own bucket).
    pub blocked: i64,
    /// Deferred items, blocked or not, requests excluded.
    pub deferred: i64,
    /// Items in review, blocked or not (rag-t0024), requests excluded.
    pub review: i64,
    pub done_unacknowledged: i64,
}

#[derive(sqlx::FromRow)]
struct ItemRow {
    id: String,
    project: String,
    #[sqlx(rename = "type")]
    item_type: String,
    title: String,
    body: String,
    status: String,
    blocked: i64,
    block_reason: Option<String>,
    block_note: Option<String>,
    approval: String,
    assignee: Option<String>,
    intensity: Option<String>,
    release: i64,
    parallel: i64,
    prev_id: Option<String>,
    next_id: Option<String>,
    created_at: String,
    updated_at: String,
    done_at: Option<String>,
    acknowledged_at: Option<String>,
}

const ITEM_COLS: &str = "id, project, type, title, body, status, blocked, block_reason, \
    block_note, approval, assignee, intensity, release, parallel, prev_id, next_id, created_at, \
    updated_at, done_at, acknowledged_at FROM items";

impl ItemRow {
    fn into_item(
        self,
        links: Vec<Link>,
        depends_on: Vec<String>,
        labels: Vec<String>,
    ) -> TResult<Item> {
        let status: ItemStatus = self.status.parse()?;
        Ok(Item {
            id: self.id,
            project: self.project,
            item_type: self.item_type.parse()?,
            title: self.title,
            body: self.body,
            status,
            blocked: self.blocked != 0,
            block_reason: self.block_reason.map(|r| r.parse()).transpose()?,
            block_note: self.block_note,
            approval: self.approval.parse()?,
            assignee: self.assignee,
            intensity: self.intensity.map(|i| i.parse()).transpose()?,
            release: self.release != 0,
            parallel: self.parallel != 0,
            depends_on,
            queued: queued_status(status),
            prev_id: self.prev_id,
            next_id: self.next_id,
            links,
            labels,
            created_at: self.created_at,
            updated_at: self.updated_at,
            done_at: self.done_at,
            acknowledged_at: self.acknowledged_at,
        })
    }
}

async fn item_links(conn: &mut SqliteConnection, id: &str) -> TResult<Vec<Link>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT kind, target FROM item_links WHERE item_id = ? ORDER BY kind, target",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await?;
    rows.into_iter()
        .map(|(kind, target)| {
            Ok(Link {
                kind: kind.parse()?,
                target,
            })
        })
        .collect()
}

/// What an item waits on, in the order it was given.
async fn item_depends(conn: &mut SqliteConnection, id: &str) -> TResult<Vec<String>> {
    Ok(
        sqlx::query_scalar("SELECT depends_on FROM item_depends WHERE item_id = ? ORDER BY rowid")
            .bind(id)
            .fetch_all(&mut *conn)
            .await?,
    )
}

pub(super) async fn load_item(conn: &mut SqliteConnection, id: &str) -> TResult<Option<Item>> {
    let Some(row) = sqlx::query_as::<_, ItemRow>(&format!("SELECT {ITEM_COLS} WHERE id = ?"))
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?
    else {
        return Ok(None);
    };
    let links = item_links(conn, id).await?;
    let depends_on = item_depends(conn, id).await?;
    let labels = labels::item_labels(conn, id).await?;
    Ok(Some(row.into_item(links, depends_on, labels)?))
}

async fn must_item(conn: &mut SqliteConnection, id: &str) -> TResult<Item> {
    load_item(conn, id)
        .await?
        .ok_or_else(|| TrackerError::NotFound(format!("no ticket {id:?}")))
}

/// Load many items by id with their links, in one query each.
async fn load_items(
    conn: &mut SqliteConnection,
    project: &str,
    where_sql: &str,
) -> TResult<Vec<Item>> {
    let rows =
        sqlx::query_as::<_, ItemRow>(&format!("SELECT {ITEM_COLS} WHERE project = ? {where_sql}"))
            .bind(project)
            .fetch_all(&mut *conn)
            .await?;
    let link_rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT l.item_id, l.kind, l.target FROM item_links l JOIN items i ON i.id = l.item_id \
         WHERE i.project = ? ORDER BY l.kind, l.target",
    )
    .bind(project)
    .fetch_all(&mut *conn)
    .await?;
    let mut links: HashMap<String, Vec<Link>> = HashMap::new();
    for (id, kind, target) in link_rows {
        links.entry(id).or_default().push(Link {
            kind: kind.parse()?,
            target,
        });
    }
    let dep_rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT d.item_id, d.depends_on FROM item_depends d JOIN items i ON i.id = d.item_id \
         WHERE i.project = ? ORDER BY d.rowid",
    )
    .bind(project)
    .fetch_all(&mut *conn)
    .await?;
    let mut depends: HashMap<String, Vec<String>> = HashMap::new();
    for (id, on) in dep_rows {
        depends.entry(id).or_default().push(on);
    }
    let mut labels = labels::project_item_labels(conn, project).await?;
    rows.into_iter()
        .map(|r| {
            let l = links.remove(&r.id).unwrap_or_default();
            let d = depends.remove(&r.id).unwrap_or_default();
            let t = labels.remove(&r.id).unwrap_or_default();
            r.into_item(l, d, t)
        })
        .collect()
}

/// The fields a generated body describes in words (`Status: pending → done.`,
/// `Blocked (review).`, `Approval: agent → ratified.`) rather than by name.
const DESCRIBED: &[&str] = &[
    "status",
    "done_at",
    "acknowledged_at",
    "blocked",
    "block_reason",
    "depends_on",
    "unblocked_by",
    "approval",
    "parallel",
    "labels",
];

/// Why a request cannot be parallel (rag-t0044).
const PARALLEL_REQUEST: &str = "a request cannot be parallel: it is never dispatched, only broken \
     into tickets, which may be";

/// The approval an item is created with when the create names none
/// (rag-t0044): `agent` for a ticket broken out of a request (it carries a
/// `from` link: the breakdown is the agent's), else `unapproved`. The owner's
/// approval of the work is given explicitly, as `owner`.
pub fn default_approval(links: &[Link]) -> Approval {
    if links.iter().any(|l| l.kind == LinkKind::From) {
        Approval::Agent
    } else {
        Approval::Unapproved
    }
}

/// Write, in the caller's transaction, the reverse of a `from` link item →
/// request (rag-t0044): `became:<item>` on the request when `added`, its
/// removal otherwise, with a `link` event on the request so its history (and
/// the feed) says what it became. Nothing when the reverse is already so.
async fn reciprocate_from(
    conn: &mut SqliteConnection,
    project: &str,
    item_id: &str,
    request_id: &str,
    added: bool,
    who: &Who,
    now: &str,
) -> TResult<()> {
    let link = Link {
        kind: LinkKind::Became,
        target: item_id.to_string(),
    };
    let changed = if added {
        sqlx::query("INSERT OR IGNORE INTO item_links (item_id, kind, target) VALUES (?,?,?)")
    } else {
        sqlx::query("DELETE FROM item_links WHERE item_id = ? AND kind = ? AND target = ?")
    }
    .bind(request_id)
    .bind(link.kind.as_str())
    .bind(item_id)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if changed == 0 {
        return Ok(());
    }
    sqlx::query("UPDATE items SET updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(request_id)
        .execute(&mut *conn)
        .await?;
    let (body, key) = if added {
        (format!("Became {item_id}."), "links_added")
    } else {
        (
            format!("No longer became {item_id}: its from link was removed."),
            "links_removed",
        )
    };
    append_event(
        conn,
        project,
        TargetKind::Item,
        request_id,
        who,
        EventKind::Link,
        &body,
        &json!({ key: [link] }),
        Some(&json!({})),
        now,
    )
    .await?;
    Ok(())
}

/// The request-link faults in `project`, for the integrity check (rag-t0044):
/// a `from` link whose request lacks the `became` link back, a `became` link
/// whose item lacks the `from`, and a `from` naming anything but a request.
pub(super) async fn request_link_problems(
    conn: &mut SqliteConnection,
    project: &str,
) -> TResult<Vec<String>> {
    let mut problems = Vec::new();
    let froms: Vec<(String, String, Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT l.item_id, l.target, r.type, \
           (SELECT 1 FROM item_links b WHERE b.item_id = l.target AND b.kind = 'became' \
            AND b.target = l.item_id) \
         FROM item_links l JOIN items i ON i.id = l.item_id \
         LEFT JOIN items r ON r.id = l.target \
         WHERE i.project = ? AND l.kind = 'from' ORDER BY i.seq, l.target",
    )
    .bind(project)
    .fetch_all(&mut *conn)
    .await?;
    for (item, request, ty, back) in froms {
        if ty.as_deref() != Some(ItemType::Request.as_str()) {
            problems.push(format!(
                "{item} comes from {request}, which is not a request"
            ));
        } else if back.is_none() {
            problems.push(format!(
                "{item} comes from {request}, which has no became link back"
            ));
        }
    }
    let becames: Vec<(String, String)> = sqlx::query_as(
        "SELECT l.item_id, l.target FROM item_links l JOIN items i ON i.id = l.item_id \
         WHERE i.project = ? AND l.kind = 'became' AND NOT EXISTS \
           (SELECT 1 FROM item_links f WHERE f.item_id = l.target AND f.kind = 'from' \
            AND f.target = l.item_id) \
         ORDER BY i.seq, l.target",
    )
    .bind(project)
    .fetch_all(&mut *conn)
    .await?;
    for (request, item) in becames {
        problems.push(format!(
            "{request} became {item}, which has no from link back"
        ));
    }
    Ok(problems)
}

/// Why a gate cannot be parallel (rag-t0013).
const PARALLEL_GATE: &str = "a gate cannot be parallel: parallel lets work start before the \
     gates above it clear, and a gate is what the work above it waits for";

/// A `depends_on` list as given: trimmed, blanks dropped, duplicates removed,
/// first mention kept.
fn clean_depends(given: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for d in given.iter().map(|d| d.trim()).filter(|d| !d.is_empty()) {
        if !out.iter().any(|o| o == d) {
            out.push(d.to_string());
        }
    }
    out
}

/// Check a `depends_on` list for `id` of `project` (rag-t0018): every entry an
/// item of the same project and not `id` itself, not all of them done already
/// (there would be nothing to wait on), and no cycle: none of them waits, directly
/// or through others, on `id`. Only items blocked with `dependency` hold a list,
/// so the walk is over those.
async fn validate_depends(
    conn: &mut SqliteConnection,
    project: &str,
    id: &str,
    deps: &[String],
) -> TResult<()> {
    let mut all_done = true;
    for d in deps {
        if d == id {
            return refused(format!("{id} cannot depend on itself"));
        }
        let row: Option<(String, String)> =
            sqlx::query_as("SELECT project, status FROM items WHERE id = ?")
                .bind(d)
                .fetch_optional(&mut *conn)
                .await?;
        let Some((their_project, status)) = row else {
            return refused(format!("depends_on names {d:?}, which is not a ticket"));
        };
        if their_project != project {
            return refused(format!(
                "{d} is a ticket of project {their_project}; {id} can only depend on tickets of \
                 its own project ({project})"
            ));
        }
        if status != ItemStatus::Done.as_str() {
            all_done = false;
        }
    }
    if all_done {
        return refused(format!(
            "every ticket {id} would depend on is already done ({}): there is nothing to wait on",
            deps.join(", ")
        ));
    }
    let mut seen: Vec<String> = deps.to_vec();
    let mut frontier: Vec<String> = deps.to_vec();
    while let Some(next) = frontier.pop() {
        let theirs = item_depends(conn, &next).await?;
        for t in theirs {
            if t == id {
                return refused(format!(
                    "{next} already waits on {id}: {id} depending on {} would make a cycle \
                     that never unblocks",
                    deps.join(", ")
                ));
            }
            if !seen.contains(&t) {
                seen.push(t.clone());
                frontier.push(t);
            }
        }
    }
    Ok(())
}

/// Replace `id`'s `depends_on` rows with `deps` (none clears them).
async fn set_depends(conn: &mut SqliteConnection, id: &str, deps: &[String]) -> TResult<()> {
    sqlx::query("DELETE FROM item_depends WHERE item_id = ?")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    for d in deps {
        sqlx::query("INSERT INTO item_depends (item_id, depends_on) VALUES (?, ?)")
            .bind(id)
            .bind(d)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// Unblock, in the caller's transaction, every item blocked with reason
/// `dependency` whose `depends_on` are now all done, `done_id` having just
/// become done (rag-t0018). Each gets an `unblock` event of its own, by the
/// author of the write that finished `done_id` (the surface that write came
/// through, its email and agent), with a generated body that names the trigger:
/// `Unblocked: rag-t0012 is done.` A dependency that is cancelled, or fails,
/// unblocks nothing: what to do then is a person's call.
async fn unblock_dependents(
    conn: &mut SqliteConnection,
    project: &str,
    done_id: &str,
    who: &super::Who,
    now: &str,
) -> TResult<Vec<String>> {
    let waiting: Vec<String> = sqlx::query_scalar(
        "SELECT i.id FROM item_depends d JOIN items i ON i.id = d.item_id \
         WHERE d.depends_on = ? AND i.blocked = 1 AND i.block_reason = 'dependency' \
         ORDER BY i.seq",
    )
    .bind(done_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut unblocked = Vec::new();
    for w in waiting {
        let deps = item_depends(conn, &w).await?;
        let open: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM item_depends d JOIN items t ON t.id = d.depends_on \
             WHERE d.item_id = ? AND t.status <> 'done'",
        )
        .bind(&w)
        .fetch_one(&mut *conn)
        .await?;
        if open > 0 {
            continue;
        }
        sqlx::query(
            "UPDATE items SET blocked = 0, block_reason = NULL, block_note = NULL, \
             updated_at = ? WHERE id = ?",
        )
        .bind(now)
        .bind(&w)
        .execute(&mut *conn)
        .await?;
        set_depends(conn, &w, &[]).await?;
        let body = if deps.len() == 1 {
            format!("Unblocked: {done_id} is done.")
        } else {
            format!(
                "Unblocked: {done_id} is done, the last of {}.",
                deps.join(", ")
            )
        };
        append_event(
            conn,
            project,
            TargetKind::Item,
            &w,
            who,
            EventKind::Unblock,
            &body,
            &json!({ "blocked": false, "depends_on": [], "unblocked_by": done_id }),
            Some(&json!({ "blocked": true, "block_reason": BlockReason::Dependency, "depends_on": deps })),
            now,
        )
        .await?;
        unblocked.push(w);
    }
    Ok(unblocked)
}

/// The `depends_on` faults in `project`, for the integrity check: a list on an
/// item not blocked with reason `dependency`, an entry that is not an item of
/// the project, an item blocked with `dependency` that waits on nothing, or one
/// whose every dependency is done (it should have been unblocked).
pub(super) async fn dependency_problems(
    conn: &mut SqliteConnection,
    project: &str,
) -> TResult<Vec<String>> {
    let mut problems = Vec::new();
    /// item, depends_on, blocked, block_reason, the dependency's project.
    type DepRow = (String, String, i64, Option<String>, Option<String>);
    let rows: Vec<DepRow> = sqlx::query_as(
        "SELECT d.item_id, d.depends_on, i.blocked, i.block_reason, t.project \
         FROM item_depends d JOIN items i ON i.id = d.item_id \
         LEFT JOIN items t ON t.id = d.depends_on \
         WHERE i.project = ? ORDER BY i.seq, d.rowid",
    )
    .bind(project)
    .fetch_all(&mut *conn)
    .await?;
    for (item, on, blocked, reason, their_project) in &rows {
        if *blocked == 0 || reason.as_deref() != Some(BlockReason::Dependency.as_str()) {
            problems.push(format!(
                "{item} depends on {on} but is not blocked with reason dependency"
            ));
        }
        match their_project {
            None => problems.push(format!("{item} depends on {on}, which is not an item")),
            Some(p) if p != project => {
                problems.push(format!("{item} depends on {on}, an item of project {p}"))
            }
            Some(_) => {}
        }
    }
    let blocked: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM items WHERE project = ? AND blocked = 1 \
         AND block_reason = 'dependency' ORDER BY seq",
    )
    .bind(project)
    .fetch_all(&mut *conn)
    .await?;
    for id in blocked {
        let open: (i64, i64) = sqlx::query_as(
            "SELECT COUNT(*), COALESCE(SUM(t.status <> 'done'), 0) FROM item_depends d \
             LEFT JOIN items t ON t.id = d.depends_on WHERE d.item_id = ?",
        )
        .bind(&id)
        .fetch_one(&mut *conn)
        .await?;
        match open {
            (0, _) => problems.push(format!(
                "{id} is blocked with reason dependency but depends on nothing"
            )),
            (_, 0) => problems.push(format!(
                "{id} waits only on done items and should have been unblocked"
            )),
            _ => {}
        }
    }
    Ok(problems)
}

/// What the fields an update set held before it (rag-t0038): each key of
/// `fields` the item has, at its old value. `blocked` and `block_reason` are
/// recorded together, so an unblock says what reason it lifted. A key the item
/// has no value for (`links_added`, `links_removed`) is left out.
fn prior_values(item: &Item, fields: &Map<String, Value>) -> Map<String, Value> {
    let old = serde_json::to_value(item).unwrap_or(Value::Null);
    let mut before = Map::new();
    for key in fields.keys() {
        if let Some(v) = old.get(key) {
            before.insert(key.clone(), v.clone());
        }
    }
    if fields.contains_key("blocked") || fields.contains_key("block_reason") {
        for key in ["blocked", "block_reason"] {
            before.insert(key.into(), old.get(key).cloned().unwrap_or(Value::Null));
        }
    }
    before
}

fn opt_str(v: &Option<String>) -> Value {
    v.as_ref().map_or(Value::Null, |s| Value::String(s.clone()))
}

impl TrackerStore {
    /// Create an item (D3). It joins the queue at `place` (normally the bottom);
    /// its id is `<project>-t<seq:04>`, the sequence per project and never reused.
    pub async fn create_item(&self, new: NewItem, actor: &Actor) -> TResult<ItemRecord> {
        let who = actor.validated()?;
        let title = require_title(&new.title)?;
        match new.item_type {
            ItemType::Gate if new.intensity.is_none() => {
                return refused("a gate needs an intensity (quick|standard|full)")
            }
            ItemType::Gate => {}
            other => {
                if new.intensity.is_some() || new.release {
                    return refused(format!(
                        "intensity and release are gate fields; a {other} ticket cannot have them"
                    ));
                }
            }
        }
        if new.parallel && new.item_type == ItemType::Gate {
            return refused(PARALLEL_GATE);
        }
        if new.parallel && new.item_type == ItemType::Request {
            return refused(PARALLEL_REQUEST);
        }
        if new.item_type == ItemType::Request && new.links.iter().any(|l| l.kind == LinkKind::From)
        {
            return refused(
                "a request cannot come from another request: it is the owner's own; break it \
                 into dev, design, recon, analysis or gate tickets with from:<request id>",
            );
        }
        if new.approval == Approval::Ratified {
            return refused(
                "a ticket cannot be created ratified: ratified follows an agent's approval",
            );
        }
        let note = given_note(new.note.as_deref());
        let given_labels = labels::clean_labels(&new.labels)?;
        let assignee = new
            .assignee
            .as_deref()
            .map(str::trim)
            .filter(|a| !a.is_empty())
            .map(str::to_string);

        let now = now_iso();
        let mut tx = self.write_tx().await?;
        ensure_project(&mut tx, &new.project, &now).await?;
        let seq: i64 = sqlx::query_scalar(
            "UPDATE projects SET item_seq = item_seq + 1 WHERE name = ? RETURNING item_seq",
        )
        .bind(&new.project)
        .fetch_one(&mut *tx)
        .await?;
        let id = format!("{}-t{seq:04}", new.project);

        sqlx::query(
            "INSERT INTO items (id, project, seq, type, title, body, status, approval, assignee, \
             intensity, release, parallel, created_at, updated_at) \
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(&id)
        .bind(&new.project)
        .bind(seq)
        .bind(new.item_type.as_str())
        .bind(&title)
        .bind(&new.body)
        .bind(ItemStatus::Pending.as_str())
        .bind(new.approval.as_str())
        .bind(&assignee)
        .bind(new.intensity.map(|i| i.as_str()))
        .bind(new.release as i64)
        .bind(new.parallel as i64)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;

        let mut links: Vec<Link> = new
            .links
            .iter()
            .map(|l| Link {
                kind: l.kind,
                target: l.target.trim().to_string(),
            })
            .collect();
        links.sort();
        links.dedup();
        for link in &links {
            validate_link(&mut tx, &new.project, link, Some(&id)).await?;
            sqlx::query("INSERT INTO item_links (item_id, kind, target) VALUES (?,?,?)")
                .bind(&id)
                .bind(link.kind.as_str())
                .bind(&link.target)
                .execute(&mut *tx)
                .await?;
        }

        list::link_at(&mut tx, &new.project, &id, &new.place).await?;

        let item_labels =
            labels::in_project_casing(&mut tx, &new.project, &id, given_labels).await?;
        labels::set_labels(&mut tx, &new.project, &id, &item_labels).await?;

        let fields = json!({
            "type": new.item_type,
            "title": title,
            "status": ItemStatus::Pending,
            "approval": new.approval,
            "assignee": assignee,
            "intensity": new.intensity,
            "release": new.release,
            "parallel": new.parallel,
            "links": links,
            "labels": item_labels,
            "place": new.place,
        });
        let body = note.unwrap_or_else(|| {
            let created = super::records::created_body(
                format!("Created {} ticket.", new.item_type),
                new.approval,
            );
            if item_labels.is_empty() {
                created
            } else {
                format!("{created} {}", labels::labels_said(&item_labels))
            }
        });
        append_event(
            &mut tx,
            &new.project,
            TargetKind::Item,
            &id,
            &who,
            EventKind::Create,
            &body,
            &fields,
            None,
            &now,
        )
        .await?;
        // The request it came from records what it became (rag-t0044); that
        // event follows the create's.
        for link in links.iter().filter(|l| l.kind == LinkKind::From) {
            reciprocate_from(&mut tx, &new.project, &id, &link.target, true, &who, &now).await?;
        }
        self.commit(tx).await?;

        self.get_item(&id, true)
            .await?
            .ok_or_else(|| TrackerError::Internal("item vanished after create".into()))
    }

    /// One item, with its history unless `history` is false.
    pub async fn get_item(&self, id: &str, history: bool) -> TResult<Option<ItemRecord>> {
        let mut conn = self.pool.acquire().await?;
        let Some(item) = load_item(&mut conn, id).await? else {
            return Ok(None);
        };
        let events = if history {
            events_for(&mut conn, &item.project, TargetKind::Item, id).await?
        } else {
            Vec::new()
        };
        Ok(Some(ItemRecord { item, events }))
    }

    /// Update an item (TR-03). One transaction, one event. The note is optional
    /// on every change (D7, amended 2026-10-27): without one the body is
    /// generated from the change (`Status: pending → done.`). A call that
    /// changes nothing but carries a note records the note; one that changes
    /// nothing and carries no note is refused.
    pub async fn update_item(
        &self,
        id: &str,
        upd: ItemUpdate,
        actor: &Actor,
    ) -> TResult<ItemRecord> {
        let who = actor.validated()?;
        let now = now_iso();
        let mut tx = self.write_tx().await?;
        let item = must_item(&mut tx, id).await?;
        let project = item.project.clone();
        let mut fields = Map::new();
        // The kinds of change made, for choosing the event's kind.
        let mut kinds: Vec<EventKind> = Vec::new();
        // What the change says when the write carried no note, in order.
        let mut said: Vec<String> = Vec::new();
        let note = given_note(upd.note.as_deref());

        // ---- status --------------------------------------------------------
        let mut status = item.status;
        let mut blocked = item.blocked;
        let mut status_unblocked = false;
        if let Some(to) = upd.status.filter(|s| *s != item.status) {
            if !transition_allowed(item.status, to) {
                return refused(format!(
                    "{id} cannot go from {} to {to} (allowed: pending <-> in_progress, pending|in_progress -> done|failed, \
                     any queued -> cancelled, done|failed|cancelled -> pending, pending|in_progress|failed -> deferred, \
                     deferred -> pending|in_progress|done, pending|in_progress|failed -> review, \
                     review -> done|in_progress|pending)",
                    item.status
                ));
            }
            let was_queued = queued_status(item.status);
            let now_queued = queued_status(to);
            if was_queued && !now_queued {
                list::unlink(&mut tx, &project, id).await?;
                if item.blocked {
                    // Work that has left the queue is no longer waiting on anything.
                    sqlx::query("UPDATE items SET blocked = 0, block_reason = NULL, block_note = NULL WHERE id = ?")
                        .bind(id)
                        .execute(&mut *tx)
                        .await?;
                    fields.insert("blocked".into(), json!(false));
                    blocked = false;
                }
                status_unblocked = true;
            } else if !was_queued && now_queued {
                // A reopen: back into the queue at the top, where reopened work
                // usually belongs (D5). The owner moves it from there.
                list::link_at(&mut tx, &project, id, &Place::Top).await?;
            }
            let done_at = match to {
                ItemStatus::Done => Some(now.clone()),
                _ if to == ItemStatus::Pending && !was_queued => None,
                _ => item.done_at.clone(),
            };
            let acknowledged_at = if to == ItemStatus::Pending && !was_queued {
                None
            } else {
                item.acknowledged_at.clone()
            };
            sqlx::query(
                "UPDATE items SET status = ?, done_at = ?, acknowledged_at = ? WHERE id = ?",
            )
            .bind(to.as_str())
            .bind(&done_at)
            .bind(&acknowledged_at)
            .bind(id)
            .execute(&mut *tx)
            .await?;
            fields.insert("status".into(), json!(to));
            if done_at != item.done_at {
                fields.insert("done_at".into(), opt_str(&done_at));
            }
            if acknowledged_at != item.acknowledged_at {
                fields.insert("acknowledged_at".into(), opt_str(&acknowledged_at));
            }
            said.push(format!("Status: {} → {to}.", item.status));
            if status_unblocked && item.blocked {
                said.push("Unblocked.".into());
            }
            status = to;
            kinds.push(EventKind::Status);
        }

        // ---- block ---------------------------------------------------------
        let block_to: Option<Option<BlockReason>> = match (upd.blocked, upd.block_reason) {
            (Some(false), Some(_)) => {
                return refused("blocked: false and a block_reason contradict each other")
            }
            (Some(false), None) => Some(None),
            (Some(true), None) => {
                return refused("blocking needs a block_reason (redesign|review|dependency)")
            }
            (_, Some(reason)) => Some(Some(reason)),
            (None, None) => None,
        };
        match block_to {
            Some(Some(reason)) if !blocked || item.block_reason != Some(reason) => {
                if !queued_status(status) {
                    return refused(format!(
                        "{id} is {status}; only a queued ticket can be blocked"
                    ));
                }
                sqlx::query(
                    "UPDATE items SET blocked = 1, block_reason = ?, block_note = ? WHERE id = ?",
                )
                .bind(reason.as_str())
                .bind(&note)
                .bind(id)
                .execute(&mut *tx)
                .await?;
                fields.insert("blocked".into(), json!(true));
                fields.insert("block_reason".into(), json!(reason));
                said.push(format!("Blocked ({reason})."));
                kinds.push(EventKind::Block);
            }
            Some(None) if blocked => {
                sqlx::query("UPDATE items SET blocked = 0, block_reason = NULL, block_note = NULL WHERE id = ?")
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
                fields.insert("blocked".into(), json!(false));
                said.push("Unblocked.".into());
                kinds.push(EventKind::Unblock);
            }
            _ => {}
        }

        // ---- depends_on (rag-t0018) ------------------------------------------
        // The list lives only beside reason `dependency`: given with it (now or
        // already held), replacing the old list; cleared by any unblock, any other
        // reason, or the item leaving the queue.
        let reason_after = match block_to {
            Some(r) => r,
            None if blocked => item.block_reason,
            None => None,
        };
        let deps_given = upd.depends_on.as_deref().map(clean_depends);
        if reason_after == Some(BlockReason::Dependency) {
            let deps = deps_given.unwrap_or_else(|| item.depends_on.clone());
            if deps.is_empty() {
                return refused(format!(
                    "blocking {id} with reason dependency needs depends_on: the tickets it waits on"
                ));
            }
            if deps != item.depends_on {
                validate_depends(&mut tx, &project, id, &deps).await?;
                set_depends(&mut tx, id, &deps).await?;
                fields.insert("depends_on".into(), json!(deps));
                said.push(format!("Waits on {}.", deps.join(", ")));
                if !kinds.contains(&EventKind::Block) {
                    kinds.push(EventKind::Block);
                }
            }
        } else {
            if deps_given.as_ref().is_some_and(|d| !d.is_empty()) {
                return refused(format!(
                    "depends_on goes with block_reason dependency, and {id} is not blocked with \
                     it: block it with reason dependency and depends_on together"
                ));
            }
            if !item.depends_on.is_empty() {
                set_depends(&mut tx, id, &[]).await?;
                fields.insert("depends_on".into(), json!([]));
            }
        }

        // ---- approval ------------------------------------------------------
        if let Some(approval) = upd.approval.filter(|a| *a != item.approval) {
            if approval == Approval::Ratified && item.approval != Approval::Agent {
                return refused(format!(
                    "ratified records the owner confirming an agent's approval; {id} is {}, not agent",
                    item.approval
                ));
            }
            sqlx::query("UPDATE items SET approval = ? WHERE id = ?")
                .bind(approval.as_str())
                .bind(id)
                .execute(&mut *tx)
                .await?;
            fields.insert("approval".into(), json!(approval));
            said.push(format!("Approval: {} → {approval}.", item.approval));
            kinds.push(EventKind::Approve);
        }

        // ---- assignee ------------------------------------------------------
        if let Some(assignee) = &upd.assignee {
            let a = assignee.trim();
            let a = (!a.is_empty()).then(|| a.to_string());
            if a != item.assignee {
                sqlx::query("UPDATE items SET assignee = ? WHERE id = ?")
                    .bind(&a)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
                fields.insert("assignee".into(), opt_str(&a));
                kinds.push(EventKind::Assign);
            }
        }

        // ---- links ---------------------------------------------------------
        let mut added = Vec::new();
        for link in &upd.add_links {
            let link = Link {
                kind: link.kind,
                target: link.target.trim().to_string(),
            };
            if item.links.contains(&link) || added.contains(&link) {
                continue;
            }
            if link.kind == LinkKind::From && item.item_type == ItemType::Request {
                return refused(format!(
                    "{id} is a request and cannot come from another request"
                ));
            }
            validate_link(&mut tx, &project, &link, Some(id)).await?;
            sqlx::query("INSERT INTO item_links (item_id, kind, target) VALUES (?,?,?)")
                .bind(id)
                .bind(link.kind.as_str())
                .bind(&link.target)
                .execute(&mut *tx)
                .await?;
            added.push(link);
        }
        let mut removed = Vec::new();
        for link in &upd.remove_links {
            let link = Link {
                kind: link.kind,
                target: link.target.trim().to_string(),
            };
            if link.kind == LinkKind::Became {
                return refused(format!(
                    "became links are written by the server: remove the from link on {} \
                     (remove_links from:{id}) and this one goes with it",
                    link.target
                ));
            }
            if !item.links.contains(&link) {
                return refused(format!(
                    "{id} has no {} link to {:?} to remove",
                    link.kind, link.target
                ));
            }
            sqlx::query("DELETE FROM item_links WHERE item_id = ? AND kind = ? AND target = ?")
                .bind(id)
                .bind(link.kind.as_str())
                .bind(&link.target)
                .execute(&mut *tx)
                .await?;
            removed.push(link);
        }
        if !added.is_empty() || !removed.is_empty() {
            if !added.is_empty() {
                fields.insert("links_added".into(), json!(added));
            }
            if !removed.is_empty() {
                fields.insert("links_removed".into(), json!(removed));
            }
            kinds.push(EventKind::Link);
        }

        // ---- title, body, gate fields ---------------------------------------
        if let Some(title) = &upd.title {
            let title = require_title(title)?;
            if title != item.title {
                sqlx::query("UPDATE items SET title = ? WHERE id = ?")
                    .bind(&title)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
                fields.insert("title".into(), json!(title));
                kinds.push(EventKind::Edit);
            }
        }
        if let Some(body) = upd.body.as_ref().filter(|b| **b != item.body) {
            sqlx::query("UPDATE items SET body = ? WHERE id = ?")
                .bind(body)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            fields.insert("body".into(), json!(body));
            kinds.push(EventKind::Edit);
        }
        if (upd.intensity.is_some() || upd.release.is_some()) && item.item_type != ItemType::Gate {
            return refused(format!(
                "intensity and release are gate fields; {id} is a {} ticket",
                item.item_type
            ));
        }
        if let Some(intensity) = upd.intensity.filter(|i| Some(*i) != item.intensity) {
            sqlx::query("UPDATE items SET intensity = ? WHERE id = ?")
                .bind(intensity.as_str())
                .bind(id)
                .execute(&mut *tx)
                .await?;
            fields.insert("intensity".into(), json!(intensity));
            kinds.push(EventKind::Edit);
        }
        if upd.parallel.is_some() && item.item_type == ItemType::Gate {
            return refused(PARALLEL_GATE);
        }
        if upd.parallel == Some(true) && item.item_type == ItemType::Request {
            return refused(PARALLEL_REQUEST);
        }
        if let Some(parallel) = upd.parallel.filter(|p| *p != item.parallel) {
            sqlx::query("UPDATE items SET parallel = ? WHERE id = ?")
                .bind(parallel as i64)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            fields.insert("parallel".into(), json!(parallel));
            said.push(format!(
                "Parallel: {}.",
                if parallel { "on" } else { "off" }
            ));
            kinds.push(EventKind::Edit);
        }
        if let Some(release) = upd.release.filter(|r| *r != item.release) {
            sqlx::query("UPDATE items SET release = ? WHERE id = ?")
                .bind(release as i64)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            fields.insert("release".into(), json!(release));
            kinds.push(EventKind::Edit);
        }

        // ---- labels (rag-t0027) ---------------------------------------------
        if let Some(given) = &upd.labels {
            let cleaned = labels::clean_labels(given)?;
            let new_labels = labels::in_project_casing(&mut tx, &project, id, cleaned).await?;
            if new_labels != item.labels {
                labels::set_labels(&mut tx, &project, id, &new_labels).await?;
                said.push(labels::labels_said(&new_labels));
                fields.insert("labels".into(), json!(new_labels));
                kinds.push(EventKind::Edit);
            }
        }

        // ---- the one event --------------------------------------------------
        let kind = [
            EventKind::Status,
            EventKind::Block,
            EventKind::Unblock,
            EventKind::Approve,
            EventKind::Assign,
            EventKind::Link,
            EventKind::Edit,
        ]
        .into_iter()
        .find(|k| kinds.contains(k));
        let (kind, body) = match (kind, note) {
            (None, None) => {
                return refused(format!(
                    "nothing to update on {id}: no field changed and no note given"
                ))
            }
            (None, Some(note)) => (EventKind::Note, note),
            (Some(kind), Some(note)) => (kind, note),
            (Some(kind), None) => {
                // Each status, block, unblock and approval change says itself
                // from → to; the rest are named (`Set assignee.`).
                let rest: Vec<&str> = fields
                    .keys()
                    .map(String::as_str)
                    .filter(|f| !DESCRIBED.contains(f))
                    .collect();
                if !rest.is_empty() {
                    said.push(format!("Set {}.", rest.join(", ")));
                }
                (kind, said.join(" "))
            }
        };
        let before = Value::Object(prior_values(&item, &fields));
        let fields = Value::Object(fields);
        sqlx::query("UPDATE items SET updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        append_event(
            &mut tx,
            &project,
            TargetKind::Item,
            id,
            &who,
            kind,
            &body,
            &fields,
            Some(&before),
            &now,
        )
        .await?;
        // A from link added or removed is answered on its request (rag-t0044).
        for (links, on) in [(&added, true), (&removed, false)] {
            for link in links.iter().filter(|l| l.kind == LinkKind::From) {
                reciprocate_from(&mut tx, &project, id, &link.target, on, &who, &now).await?;
            }
        }
        // Finishing an item frees what waited on it, in this same transaction
        // (rag-t0018); its events follow this write's.
        if status == ItemStatus::Done && item.status != ItemStatus::Done {
            unblock_dependents(&mut tx, &project, id, &who, &now).await?;
        }
        self.commit(tx).await?;

        self.get_item(id, true)
            .await?
            .ok_or_else(|| TrackerError::Internal("item vanished after update".into()))
    }

    /// Move a queued item (D5): `before` or `after` another queued item of the
    /// same project, or to the `top` or `bottom`. One transaction, one event.
    pub async fn move_item(
        &self,
        id: &str,
        place: Place,
        note: Option<&str>,
        actor: &Actor,
    ) -> TResult<ItemRecord> {
        let who = actor.validated()?;
        let now = now_iso();
        let mut tx = self.write_tx().await?;
        let item = must_item(&mut tx, id).await?;
        if !item.queued {
            return refused(format!(
                "{id} is {} and not in the queue; only a queued ticket moves",
                item.status
            ));
        }
        // Validate the anchor before unlinking, so a refusal leaves no trace.
        if let Place::Before(a) | Place::After(a) = &place {
            if a == id {
                return refused(format!("cannot move {id} relative to itself"));
            }
        }
        list::unlink(&mut tx, &item.project, id).await?;
        list::link_at(&mut tx, &item.project, id, &place).await?;
        // Where it now sits, by its new neighbour (rag-t0038): `null` is the top.
        let prev_id: Option<String> = sqlx::query_scalar("SELECT prev_id FROM items WHERE id = ?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        let body = note
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| match &place {
                Place::Top => "Moved to the top.".to_string(),
                Place::Bottom => "Moved to the bottom.".to_string(),
                Place::Before(a) => format!("Moved before {a}."),
                Place::After(a) => format!("Moved after {a}."),
            });
        sqlx::query("UPDATE items SET updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        append_event(
            &mut tx,
            &item.project,
            TargetKind::Item,
            id,
            &who,
            EventKind::Move,
            &body,
            &json!({ "place": place, "prev_id": prev_id }),
            Some(&json!({ "prev_id": item.prev_id })),
            &now,
        )
        .await?;
        self.commit(tx).await?;
        self.get_item(id, true)
            .await?
            .ok_or_else(|| TrackerError::Internal("item vanished after move".into()))
    }

    /// Acknowledge every done item of `project` not yet acknowledged (R12): each
    /// is stamped and gets an `acknowledge` event. Returns their ids.
    pub async fn acknowledge_done(&self, project: &str, actor: &Actor) -> TResult<Vec<String>> {
        let who = actor.validated()?;
        let now = now_iso();
        let mut tx = self.write_tx().await?;
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM items WHERE project = ? AND status = 'done' AND acknowledged_at IS NULL ORDER BY seq",
        )
        .bind(project)
        .fetch_all(&mut *tx)
        .await?;
        for id in &ids {
            sqlx::query("UPDATE items SET acknowledged_at = ?, updated_at = ? WHERE id = ?")
                .bind(&now)
                .bind(&now)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            append_event(
                &mut tx,
                project,
                TargetKind::Item,
                id,
                &who,
                EventKind::Acknowledge,
                "Acknowledged done.",
                &json!({ "acknowledged_at": now }),
                Some(&json!({ "acknowledged_at": null })),
                &now,
            )
            .await?;
        }
        self.commit(tx).await?;
        Ok(ids)
    }

    /// The queue view (D14): the requests (rag-t0044), done-unacknowledged oldest
    /// first (rag-t0029), the items in review (blocked or not), the queue in list order without review, blocked
    /// or deferred items, then the blocked items, then the deferred items
    /// (blocked or not), each in list order.
    pub async fn queue_view(&self, project: &str) -> TResult<QueueView> {
        let mut conn = self.pool.acquire().await?;
        let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM projects WHERE name = ?")
            .bind(project)
            .fetch_optional(&mut *conn)
            .await?;
        let order = list::walk(&mut conn, project).await?;
        let mut items: HashMap<String, Item> = load_items(
            &mut conn,
            project,
            &format!(
                "AND (status IN {QUEUED_IN} OR (status = 'done' AND acknowledged_at IS NULL))"
            ),
        )
        .await?
        .into_iter()
        .map(|i| (i.id.clone(), i))
        .collect();
        let mut requests = Vec::new();
        let mut review = Vec::new();
        let mut queue = Vec::new();
        let mut blocked = Vec::new();
        let mut deferred = Vec::new();
        for id in order {
            if let Some(item) = items.remove(&id) {
                if item.item_type == ItemType::Request {
                    requests.push(item);
                } else if item.status == ItemStatus::Review {
                    review.push(item);
                } else if item.status == ItemStatus::Deferred {
                    deferred.push(item);
                } else if item.blocked {
                    blocked.push(item);
                } else {
                    queue.push(item);
                }
            }
        }
        let mut done: Vec<Item> = items
            .into_values()
            .filter(|i| i.status == ItemStatus::Done)
            .collect();
        // Oldest first, newest last: the order the queue reads (rag-t0029).
        done.sort_by(|a, b| {
            a.done_at
                .cmp(&b.done_at)
                .then_with(|| item_seq(&a.id).cmp(&item_seq(&b.id)))
        });
        Ok(QueueView {
            project: project.to_string(),
            exists: exists.is_some(),
            requests,
            done,
            review,
            queue,
            blocked,
            deferred,
        })
    }

    /// Every item of `project`, optionally only those with `status` and only
    /// those carrying `label` (matched case-insensitively, rag-t0027; a blank one
    /// is no filter), oldest first.
    pub async fn list_items(
        &self,
        project: &str,
        status: Option<ItemStatus>,
        label: Option<&str>,
    ) -> TResult<Vec<Item>> {
        let mut conn = self.pool.acquire().await?;
        let mut items = match status {
            Some(s) => {
                load_items(
                    &mut conn,
                    project,
                    &format!("AND status = '{}'", s.as_str()),
                )
                .await?
            }
            None => load_items(&mut conn, project, "").await?,
        };
        let wanted = label
            .map(|l| labels::label_key(&l.split_whitespace().collect::<Vec<_>>().join(" ")))
            .filter(|k| !k.is_empty());
        if let Some(key) = wanted {
            items.retain(|i| i.labels.iter().any(|l| labels::label_key(l) == key));
        }
        items.sort_by_key(|i| item_seq(&i.id));
        Ok(items)
    }

    /// Every project the tracker knows, by name, with its counts.
    pub async fn list_projects(&self) -> TResult<Vec<ProjectSummary>> {
        type Row = (String, String, i64, i64, i64, i64, i64, i64);
        let rows: Vec<Row> = sqlx::query_as(&format!(
            "SELECT p.name, p.created_at, \
               (SELECT COUNT(*) FROM items i WHERE i.project = p.name AND i.status IN {QUEUED_IN}), \
               (SELECT COUNT(*) FROM items i WHERE i.project = p.name AND i.type = 'request' AND i.status IN {QUEUED_IN}), \
               (SELECT COUNT(*) FROM items i WHERE i.project = p.name AND i.type <> 'request' AND i.blocked = 1 AND i.status IN ('pending','in_progress','failed')), \
               (SELECT COUNT(*) FROM items i WHERE i.project = p.name AND i.type <> 'request' AND i.status = 'deferred'), \
               (SELECT COUNT(*) FROM items i WHERE i.project = p.name AND i.type <> 'request' AND i.status = 'review'), \
               (SELECT COUNT(*) FROM items i WHERE i.project = p.name AND i.status = 'done' AND i.acknowledged_at IS NULL) \
             FROM projects p ORDER BY p.name",
        ))
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(
                |(
                    name,
                    created_at,
                    queued,
                    requests,
                    blocked,
                    deferred,
                    review,
                    done_unacknowledged,
                )| {
                    ProjectSummary {
                        name,
                        created_at,
                        queued,
                        requests,
                        blocked,
                        deferred,
                        review,
                        done_unacknowledged,
                    }
                },
            )
            .collect())
    }
}

/// The sequence number in an item id (`ubu-t0042` → 42), for stable ordering.
fn item_seq(id: &str) -> i64 {
    id.rsplit_once("-t")
        .and_then(|(_, n)| n.parse().ok())
        .unwrap_or(0)
}
