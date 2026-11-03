//! The queue as a doubly linked list (D5, R11), and each planned phase's list of
//! frozen tickets (spec:roadmap D2, D10): the same algorithm over two list
//! owners ([`Owner`]).
//!
//! Each queued item (`pending`, `in_progress`, `failed` or `deferred`, blocked or
//! not) holds
//! `prev_id` and `next_id`; the project row holds the queue's `head_id` and
//! `tail_id`. A frozen ticket holds the same two links, in its phase's list, and
//! the phase row holds that list's ends; so the main walk never meets a frozen
//! ticket, provided anchors are checked ([`check_anchor`]). Done and cancelled
//! items hold neither. Every operation here runs on the caller's transaction and
//! touches at most four rows: the item, its two neighbours (old or new), and the
//! list's owner.
//!
//! A move is expressed relative to another item or to an end, **never as a
//! number**, so it cannot go stale while another write lands.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use sqlx::SqliteConnection;

use super::{refused, ItemStatus, TResult, TrackerError, TrackerStore};

/// Where to put an item in its project's queue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Place {
    Top,
    Bottom,
    /// Immediately before this queued item of the same project.
    Before(String),
    /// Immediately after this queued item of the same project.
    After(String),
}

/// Which list an item is linked in: its project's queue, or a planned phase's
/// frozen tickets (spec:roadmap D2). [`super::Item::owner`] says which.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Owner<'a> {
    /// The queue of this project.
    Queue(&'a str),
    /// The frozen tickets of the phase with this id.
    Phase(&'a str),
}

#[derive(Debug, Clone)]
struct Ends {
    head: Option<String>,
    tail: Option<String>,
}

async fn ends(conn: &mut SqliteConnection, owner: &Owner<'_>) -> TResult<Ends> {
    let (sql, key, what) = match *owner {
        Owner::Queue(project) => (
            "SELECT head_id, tail_id FROM projects WHERE name = ?",
            project,
            "project",
        ),
        Owner::Phase(phase) => (
            "SELECT head_id, tail_id FROM phases WHERE id = ?",
            phase,
            "phase",
        ),
    };
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(sql)
        .bind(key)
        .fetch_optional(&mut *conn)
        .await?;
    let (head, tail) = row.ok_or_else(|| TrackerError::NotFound(format!("no {what} {key:?}")))?;
    Ok(Ends { head, tail })
}

async fn set_ends(conn: &mut SqliteConnection, owner: &Owner<'_>, ends: &Ends) -> TResult<()> {
    let (sql, key) = match *owner {
        Owner::Queue(project) => (
            "UPDATE projects SET head_id = ?, tail_id = ? WHERE name = ?",
            project,
        ),
        Owner::Phase(phase) => (
            "UPDATE phases SET head_id = ?, tail_id = ? WHERE id = ?",
            phase,
        ),
    };
    sqlx::query(sql)
        .bind(&ends.head)
        .bind(&ends.tail)
        .bind(key)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

async fn set_prev(conn: &mut SqliteConnection, id: &str, prev: Option<&str>) -> TResult<()> {
    sqlx::query("UPDATE items SET prev_id = ? WHERE id = ?")
        .bind(prev)
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

async fn set_next(conn: &mut SqliteConnection, id: &str, next: Option<&str>) -> TResult<()> {
    sqlx::query("UPDATE items SET next_id = ? WHERE id = ?")
        .bind(next)
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

async fn links_of(
    conn: &mut SqliteConnection,
    id: &str,
) -> TResult<(Option<String>, Option<String>)> {
    let row: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT prev_id, next_id FROM items WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?;
    row.ok_or_else(|| TrackerError::NotFound(format!("no ticket {id:?}")))
}

/// Refuse an anchor that is not on `owner`'s list, or is `item` itself. A queued
/// ticket frozen in a phase is on no queue, so it is refused for the queue
/// (spec:roadmap D2, D10): without this, `before: <frozen>` would splice the
/// queue into a phase's list. A phase takes only its own frozen tickets.
pub(super) async fn check_anchor(
    conn: &mut SqliteConnection,
    owner: &Owner<'_>,
    item: &str,
    anchor: &str,
) -> TResult<()> {
    if anchor == item {
        return refused(format!("cannot place {item} relative to itself"));
    }
    let row: Option<(String, String, i64, Option<String>)> =
        sqlx::query_as("SELECT project, status, frozen, phase_id FROM items WHERE id = ?")
            .bind(anchor)
            .fetch_optional(&mut *conn)
            .await?;
    let Some((anchor_project, status, frozen, phase)) = row else {
        return refused(format!("no ticket {anchor:?} to place {item} relative to"));
    };
    match *owner {
        Owner::Queue(project) => {
            if anchor_project != project {
                return refused(format!(
                    "{anchor} belongs to project {anchor_project}, not {project}: tickets move only within their own queue"
                ));
            }
            let status: ItemStatus = status.parse()?;
            if !super::queued_status(status) {
                return refused(format!(
                    "{anchor} is {status} and not in the queue; place {item} relative to a queued ticket"
                ));
            }
            if frozen != 0 {
                return refused(format!(
                    "{anchor} is frozen in phase {}: place {item} relative to a queued ticket",
                    phase.as_deref().unwrap_or("(none)")
                ));
            }
        }
        Owner::Phase(id) => {
            if frozen == 0 || phase.as_deref() != Some(id) {
                return refused(format!(
                    "{anchor} is not in phase {id}: a frozen ticket moves only within its phase"
                ));
            }
        }
    }
    Ok(())
}

/// Resolve `place` on `owner`'s list to the (prev, next) neighbours something
/// placed there gets, checking an anchor.
async fn neighbours(
    conn: &mut SqliteConnection,
    owner: &Owner<'_>,
    item: &str,
    place: &Place,
    e: &Ends,
) -> TResult<(Option<String>, Option<String>)> {
    Ok(match place {
        Place::Top => (None, e.head.clone()),
        Place::Bottom => (e.tail.clone(), None),
        Place::Before(anchor) => {
            check_anchor(conn, owner, item, anchor).await?;
            let (anchor_prev, _) = links_of(conn, anchor).await?;
            (anchor_prev, Some(anchor.clone()))
        }
        Place::After(anchor) => {
            check_anchor(conn, owner, item, anchor).await?;
            let (_, anchor_next) = links_of(conn, anchor).await?;
            (Some(anchor.clone()), anchor_next)
        }
    })
}

/// Link `item` (currently unlinked) into `owner`'s list at `place`.
pub(super) async fn link_at(
    conn: &mut SqliteConnection,
    owner: &Owner<'_>,
    item: &str,
    place: &Place,
) -> TResult<()> {
    let mut e = ends(conn, owner).await?;
    let (prev, next) = neighbours(conn, owner, item, place, &e).await?;
    sqlx::query("UPDATE items SET prev_id = ?, next_id = ? WHERE id = ?")
        .bind(&prev)
        .bind(&next)
        .bind(item)
        .execute(&mut *conn)
        .await?;
    match &prev {
        Some(p) => set_next(conn, p, Some(item)).await?,
        None => e.head = Some(item.to_string()),
    }
    match &next {
        Some(n) => set_prev(conn, n, Some(item)).await?,
        None => e.tail = Some(item.to_string()),
    }
    set_ends(conn, owner, &e).await
}

/// Take `item` out of `owner`'s list, joining its neighbours.
pub(super) async fn unlink(
    conn: &mut SqliteConnection,
    owner: &Owner<'_>,
    item: &str,
) -> TResult<()> {
    let mut e = ends(conn, owner).await?;
    let (prev, next) = links_of(conn, item).await?;
    match &prev {
        Some(p) => set_next(conn, p, next.as_deref()).await?,
        None => e.head = next.clone(),
    }
    match &next {
        Some(n) => set_prev(conn, n, prev.as_deref()).await?,
        None => e.tail = prev.clone(),
    }
    sqlx::query("UPDATE items SET prev_id = NULL, next_id = NULL WHERE id = ?")
        .bind(item)
        .execute(&mut *conn)
        .await?;
    set_ends(conn, owner, &e).await
}

/// Link a chain that is already linked within itself, its ends `head` and `tail`,
/// into `owner`'s list at `place` (a phase's release, spec:roadmap D11): the
/// neighbours are resolved as [`link_at`] resolves them, and only the chain's two
/// ends, those neighbours and the owner change.
pub(super) async fn join_chain(
    conn: &mut SqliteConnection,
    owner: &Owner<'_>,
    head: &str,
    tail: &str,
    place: &Place,
) -> TResult<()> {
    let mut e = ends(conn, owner).await?;
    let (prev, next) = neighbours(conn, owner, head, place, &e).await?;
    set_prev(conn, head, prev.as_deref()).await?;
    set_next(conn, tail, next.as_deref()).await?;
    match &prev {
        Some(p) => set_next(conn, p, Some(head)).await?,
        None => e.head = Some(head.to_string()),
    }
    match &next {
        Some(n) => set_prev(conn, n, Some(tail)).await?,
        None => e.tail = Some(tail.to_string()),
    }
    set_ends(conn, owner, &e).await
}

/// The items on `owner`'s list, in list order, by walking from the head: the
/// queued items not frozen, or a phase's frozen tickets. Stops (rather than
/// looping) on a cycle; [`TrackerStore::check`] reports it.
pub(super) async fn walk(conn: &mut SqliteConnection, owner: &Owner<'_>) -> TResult<Vec<String>> {
    let Ok(e) = ends(conn, owner).await else {
        return Ok(Vec::new());
    };
    let rows: Vec<(String, Option<String>)> = match *owner {
        Owner::Queue(project) => {
            sqlx::query_as(&format!(
                "SELECT id, next_id FROM items WHERE project = ? AND frozen = 0 AND status IN {}",
                super::items::QUEUED_IN
            ))
            .bind(project)
            .fetch_all(&mut *conn)
            .await?
        }
        Owner::Phase(phase) => {
            sqlx::query_as("SELECT id, next_id FROM items WHERE phase_id = ? AND frozen = 1")
                .bind(phase)
                .fetch_all(&mut *conn)
                .await?
        }
    };
    let next: HashMap<String, Option<String>> = rows.into_iter().collect();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut cur = e.head;
    while let Some(id) = cur {
        if !seen.insert(id.clone()) {
            break;
        }
        cur = next.get(&id).cloned().flatten();
        out.push(id);
    }
    Ok(out)
}

/// The result of [`TrackerStore::check`] (D5's integrity check).
#[derive(Debug, Clone, Serialize)]
pub struct IntegrityReport {
    pub project: String,
    /// `true` when `problems` is empty.
    pub ok: bool,
    /// How many items are in the main list: queued (`pending`, `in_progress`,
    /// `failed`, `deferred`, `review`) and not frozen.
    pub queued: usize,
    /// How many tickets are frozen in a phase (spec:roadmap D3).
    pub frozen: usize,
    /// The list as walked from the head.
    pub order: Vec<String>,
    /// Each fault found, in words. Empty when the list is sound.
    pub problems: Vec<String>,
}

#[derive(sqlx::FromRow)]
struct LinkRow {
    id: String,
    status: String,
    prev_id: Option<String>,
    next_id: Option<String>,
    frozen: i64,
}

impl TrackerStore {
    /// D5's integrity check: one head, one tail, every link answered by its
    /// partner, no cycle, the walk covering every queued item that is not frozen,
    /// and no link on an item that is neither queued nor frozen. It also checks
    /// `depends_on` (rag-t0018): held only by items blocked with reason
    /// `dependency`, each such item waiting on at least one item of its own
    /// project that is not done; and the roadmap (spec:roadmap D3,
    /// [`super::phases::phase_problems`]). A project that does not exist is
    /// trivially sound.
    pub async fn check(&self, project: &str) -> TResult<IntegrityReport> {
        let mut conn = self.pool.acquire().await?;
        let ends: Option<(Option<String>, Option<String>)> =
            sqlx::query_as("SELECT head_id, tail_id FROM projects WHERE name = ?")
                .bind(project)
                .fetch_optional(&mut *conn)
                .await?;
        let rows = sqlx::query_as::<_, LinkRow>(
            "SELECT id, status, prev_id, next_id, frozen FROM items WHERE project = ?",
        )
        .bind(project)
        .fetch_all(&mut *conn)
        .await?;
        let mut problems = Vec::new();
        let Some((head, tail)) = ends else {
            return Ok(IntegrityReport {
                project: project.to_string(),
                ok: rows.is_empty(),
                queued: 0,
                frozen: 0,
                order: Vec::new(),
                problems: if rows.is_empty() {
                    Vec::new()
                } else {
                    vec!["items exist for a project with no project row".into()]
                },
            });
        };

        let mut by_id: HashMap<&str, &LinkRow> = HashMap::new();
        let mut queued: HashSet<&str> = HashSet::new();
        for r in &rows {
            by_id.insert(&r.id, r);
            let status: ItemStatus = r.status.parse()?;
            // A frozen ticket's links are its phase's list: `phase_problems`
            // walks those, and says if it should not be frozen.
            if r.frozen != 0 {
                continue;
            }
            if super::queued_status(status) {
                queued.insert(&r.id);
            } else if r.prev_id.is_some() || r.next_id.is_some() {
                problems.push(format!("{} is {} but still linked", r.id, status));
            }
        }

        // Every link answered by its partner.
        for r in &rows {
            if let Some(n) = &r.next_id {
                match by_id.get(n.as_str()) {
                    Some(nr) if nr.prev_id.as_deref() == Some(r.id.as_str()) => {}
                    Some(_) => problems.push(format!(
                        "{}.next = {n}, but {n}.prev does not point back",
                        r.id
                    )),
                    None => problems.push(format!(
                        "{}.next = {n}, which is not an item of this project",
                        r.id
                    )),
                }
            }
            if let Some(p) = &r.prev_id {
                match by_id.get(p.as_str()) {
                    Some(pr) if pr.next_id.as_deref() == Some(r.id.as_str()) => {}
                    Some(_) => problems.push(format!(
                        "{}.prev = {p}, but {p}.next does not point back",
                        r.id
                    )),
                    None => problems.push(format!(
                        "{}.prev = {p}, which is not an item of this project",
                        r.id
                    )),
                }
            }
        }

        // One head and one tail.
        let heads: Vec<&str> = queued
            .iter()
            .copied()
            .filter(|id| by_id[id].prev_id.is_none())
            .collect();
        let tails: Vec<&str> = queued
            .iter()
            .copied()
            .filter(|id| by_id[id].next_id.is_none())
            .collect();
        if queued.is_empty() {
            if head.is_some() || tail.is_some() {
                problems.push(format!(
                    "the queue is empty but head = {head:?}, tail = {tail:?}"
                ));
            }
        } else {
            if heads.len() != 1 {
                problems.push(format!(
                    "{} items have no prev (expected exactly one head)",
                    heads.len()
                ));
            }
            if tails.len() != 1 {
                problems.push(format!(
                    "{} items have no next (expected exactly one tail)",
                    tails.len()
                ));
            }
            if head.as_deref() != heads.first().copied() || heads.len() != 1 {
                problems.push(format!(
                    "project head is {head:?}, the item with no prev is {heads:?}"
                ));
            }
            if tail.as_deref() != tails.first().copied() || tails.len() != 1 {
                problems.push(format!(
                    "project tail is {tail:?}, the item with no next is {tails:?}"
                ));
            }
        }

        // Walk from the head: no cycle, and it covers every queued item.
        let mut order = Vec::new();
        let mut seen = HashSet::new();
        let mut cur = head.clone();
        while let Some(id) = cur {
            if !seen.insert(id.clone()) {
                problems.push(format!("cycle: the walk reaches {id} twice"));
                break;
            }
            let Some(r) = by_id.get(id.as_str()) else {
                problems.push(format!(
                    "the walk reaches {id}, which is not an item of this project"
                ));
                break;
            };
            if !queued.contains(id.as_str()) {
                problems.push(format!("the walk reaches {id}, which is not queued"));
            }
            cur = r.next_id.clone();
            order.push(id);
        }
        if order.last() != tail.as_ref() && !(order.is_empty() && tail.is_none()) {
            problems.push(format!(
                "the walk ends at {:?}, but the tail is {tail:?}",
                order.last()
            ));
        }
        let missed: Vec<&str> = queued
            .iter()
            .copied()
            .filter(|id| !seen.contains(*id))
            .collect();
        if !missed.is_empty() {
            let mut missed = missed;
            missed.sort_unstable();
            problems.push(format!(
                "queued but not reached by the walk: {}",
                missed.join(", ")
            ));
        }

        // What blocked items wait on (rag-t0018).
        problems.extend(super::items::dependency_problems(&mut conn, project).await?);
        // Each from link answered by its request's became, and back (rag-t0044).
        problems.extend(super::items::request_link_problems(&mut conn, project).await?);
        // The phases and their frozen tickets (spec:roadmap D3).
        problems.extend(super::phases::phase_problems(&mut conn, project).await?);

        Ok(IntegrityReport {
            project: project.to_string(),
            ok: problems.is_empty(),
            queued: queued.len(),
            frozen: rows.iter().filter(|r| r.frozen != 0).count(),
            order,
            problems,
        })
    }
}
