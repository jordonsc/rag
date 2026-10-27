//! The queue as a doubly linked list (D5, R11).
//!
//! Each queued item (`pending`, `in_progress`, `failed` or `deferred`, blocked or
//! not) holds
//! `prev_id` and `next_id`; the project row holds `head_id` and `tail_id`. Done
//! and cancelled items hold neither. Every operation here runs on the caller's
//! transaction and touches at most four rows: the item, its two neighbours (old
//! or new), and the project.
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

#[derive(Debug, Clone)]
struct Ends {
    head: Option<String>,
    tail: Option<String>,
}

async fn ends(conn: &mut SqliteConnection, project: &str) -> TResult<Ends> {
    let row: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT head_id, tail_id FROM projects WHERE name = ?")
            .bind(project)
            .fetch_optional(&mut *conn)
            .await?;
    let (head, tail) =
        row.ok_or_else(|| TrackerError::NotFound(format!("no project {project:?}")))?;
    Ok(Ends { head, tail })
}

async fn set_ends(conn: &mut SqliteConnection, project: &str, ends: &Ends) -> TResult<()> {
    sqlx::query("UPDATE projects SET head_id = ?, tail_id = ? WHERE name = ?")
        .bind(&ends.head)
        .bind(&ends.tail)
        .bind(project)
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
    row.ok_or_else(|| TrackerError::NotFound(format!("no item {id:?}")))
}

/// Refuse an anchor that is not a queued item of `project`, or is `item` itself.
async fn check_anchor(
    conn: &mut SqliteConnection,
    project: &str,
    item: &str,
    anchor: &str,
) -> TResult<()> {
    if anchor == item {
        return refused(format!("cannot place {item} relative to itself"));
    }
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT project, status FROM items WHERE id = ?")
            .bind(anchor)
            .fetch_optional(&mut *conn)
            .await?;
    let Some((anchor_project, status)) = row else {
        return refused(format!("no item {anchor:?} to place {item} relative to"));
    };
    if anchor_project != project {
        return refused(format!(
            "{anchor} belongs to project {anchor_project}, not {project}: items move only within their own queue"
        ));
    }
    let status: ItemStatus = status.parse()?;
    if !super::queued_status(status) {
        return refused(format!(
            "{anchor} is {status} and not in the queue; place {item} relative to a queued item"
        ));
    }
    Ok(())
}

/// Link `item` (currently unlinked) into `project`'s list at `place`.
pub(super) async fn link_at(
    conn: &mut SqliteConnection,
    project: &str,
    item: &str,
    place: &Place,
) -> TResult<()> {
    let mut e = ends(conn, project).await?;
    // Resolve the place to (prev, next) neighbours.
    let (prev, next): (Option<String>, Option<String>) = match place {
        Place::Top => (None, e.head.clone()),
        Place::Bottom => (e.tail.clone(), None),
        Place::Before(anchor) => {
            check_anchor(conn, project, item, anchor).await?;
            let (anchor_prev, _) = links_of(conn, anchor).await?;
            (anchor_prev, Some(anchor.clone()))
        }
        Place::After(anchor) => {
            check_anchor(conn, project, item, anchor).await?;
            let (_, anchor_next) = links_of(conn, anchor).await?;
            (Some(anchor.clone()), anchor_next)
        }
    };
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
    set_ends(conn, project, &e).await
}

/// Take `item` out of `project`'s list, joining its neighbours.
pub(super) async fn unlink(conn: &mut SqliteConnection, project: &str, item: &str) -> TResult<()> {
    let mut e = ends(conn, project).await?;
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
    set_ends(conn, project, &e).await
}

/// The queued items of `project`, in list order, by walking from the head.
/// Stops (rather than looping) on a cycle; [`TrackerStore::check`] reports it.
pub(super) async fn walk(conn: &mut SqliteConnection, project: &str) -> TResult<Vec<String>> {
    let Ok(e) = ends(conn, project).await else {
        return Ok(Vec::new());
    };
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(&format!(
        "SELECT id, next_id FROM items WHERE project = ? AND status IN {}",
        super::items::QUEUED_IN
    ))
    .bind(project)
    .fetch_all(&mut *conn)
    .await?;
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
    /// How many items are queued (`pending`, `in_progress`, `failed`, `deferred`).
    pub queued: usize,
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
}

impl TrackerStore {
    /// D5's integrity check: one head, one tail, every link answered by its
    /// partner, no cycle, the walk covering every queued item, and no link on an
    /// item that is not queued. It also checks `depends_on` (rag-t0018): held only
    /// by items blocked with reason `dependency`, each such item waiting on at
    /// least one item of its own project that is not done. A project that does
    /// not exist is trivially sound.
    pub async fn check(&self, project: &str) -> TResult<IntegrityReport> {
        let mut conn = self.pool.acquire().await?;
        let ends: Option<(Option<String>, Option<String>)> =
            sqlx::query_as("SELECT head_id, tail_id FROM projects WHERE name = ?")
                .bind(project)
                .fetch_optional(&mut *conn)
                .await?;
        let rows = sqlx::query_as::<_, LinkRow>(
            "SELECT id, status, prev_id, next_id FROM items WHERE project = ?",
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

        Ok(IntegrityReport {
            project: project.to_string(),
            ok: problems.is_empty(),
            queued: queued.len(),
            order,
            problems,
        })
    }
}
