//! Item labels (rag-t0027, owner 2026-10-27): free-text tags such as `Physics`,
//! `Biomes` or `Creatures` that sort a project's items by subject.
//!
//! * An item carries a **set**: at most [`MAX_LABELS`], each at most
//!   [`MAX_LABEL_CHARS`] characters, trimmed (inner runs of whitespace become
//!   one space), never blank, never holding a comma (labels are listed
//!   comma-separated in history bodies and in the MCP text) or a control
//!   character.
//! * Labels match **case-insensitively within a project** and the project's
//!   existing casing wins: labelling an item `physics` when another item of the
//!   project carries `Physics` stores `Physics`. The vocabulary is what the
//!   project's items carry now ([`TrackerStore::project_labels`]); a label no
//!   item carries any more is forgotten.
//! * An item's labels are held sorted case-insensitively, so the order never
//!   depends on how they were typed and a re-sent set in another order is not
//!   a change.
//! * Set wholesale on create and update, as ledger tags are, and recorded on
//!   the event (`Labels: Biomes, Physics.`).

use serde::Serialize;
use sqlx::SqliteConnection;

use super::{refused, TResult, TrackerStore};

/// The most labels one item carries.
pub const MAX_LABELS: usize = 10;

/// The longest label, in characters.
pub const MAX_LABEL_CHARS: usize = 32;

/// One label of a project's vocabulary and how many items carry it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LabelCount {
    pub label: String,
    /// Items of the project carrying it, whatever their status.
    pub count: i64,
    /// Of those, the items still in the queue (pending, in progress, failed,
    /// deferred, review).
    pub queued: i64,
}

/// The key labels are matched by: case-insensitive, Unicode-aware.
pub fn label_key(label: &str) -> String {
    label.to_lowercase()
}

/// Labels as given, cleaned and checked: trimmed with inner whitespace runs
/// collapsed, duplicates (case-insensitive) merged keeping the first, sorted
/// by key. Refuses a blank label, one over [`MAX_LABEL_CHARS`], one with a
/// comma or a control character, and more than [`MAX_LABELS`] distinct ones.
pub fn clean_labels(given: &[String]) -> TResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for raw in given {
        let label = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        if label.is_empty() {
            return refused("a label must not be blank");
        }
        if label.chars().count() > MAX_LABEL_CHARS {
            return refused(format!(
                "the label {label:?} is longer than {MAX_LABEL_CHARS} characters"
            ));
        }
        if label.contains(',') {
            return refused(format!(
                "the label {label:?} holds a comma: give each label as its own entry"
            ));
        }
        if label.chars().any(char::is_control) {
            return refused(format!("the label {label:?} holds a control character"));
        }
        let key = label_key(&label);
        if !out.iter().any(|o| label_key(o) == key) {
            out.push(label);
        }
    }
    if out.len() > MAX_LABELS {
        return refused(format!(
            "a ticket carries at most {MAX_LABELS} labels, not {}",
            out.len()
        ));
    }
    sort_labels(&mut out);
    Ok(out)
}

fn sort_labels(labels: &mut [String]) {
    labels.sort_by(|a, b| label_key(a).cmp(&label_key(b)).then_with(|| a.cmp(b)));
}

/// `labels` (already [`clean_labels`]) in the project's casing: each one that
/// another item of `project` carries takes that item's casing. `item_id` is the
/// item being labelled, left out so an item that alone carries a label can
/// change its casing.
pub(super) async fn in_project_casing(
    conn: &mut SqliteConnection,
    project: &str,
    item_id: &str,
    labels: Vec<String>,
) -> TResult<Vec<String>> {
    let mut out = Vec::with_capacity(labels.len());
    for label in labels {
        let existing: Option<String> = sqlx::query_scalar(
            "SELECT MIN(label) FROM item_labels WHERE project = ? AND label_key = ? \
             AND item_id <> ?",
        )
        .bind(project)
        .bind(label_key(&label))
        .bind(item_id)
        .fetch_one(&mut *conn)
        .await?;
        out.push(existing.unwrap_or(label));
    }
    sort_labels(&mut out);
    Ok(out)
}

/// An item's labels, sorted.
pub(super) async fn item_labels(conn: &mut SqliteConnection, id: &str) -> TResult<Vec<String>> {
    let mut labels: Vec<String> =
        sqlx::query_scalar("SELECT label FROM item_labels WHERE item_id = ?")
            .bind(id)
            .fetch_all(&mut *conn)
            .await?;
    sort_labels(&mut labels);
    Ok(labels)
}

/// Every labelled item of `project` with its labels, sorted.
pub(super) async fn project_item_labels(
    conn: &mut SqliteConnection,
    project: &str,
) -> TResult<std::collections::HashMap<String, Vec<String>>> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT item_id, label FROM item_labels WHERE project = ?")
            .bind(project)
            .fetch_all(&mut *conn)
            .await?;
    let mut map: std::collections::HashMap<String, Vec<String>> = Default::default();
    for (id, label) in rows {
        map.entry(id).or_default().push(label);
    }
    for labels in map.values_mut() {
        sort_labels(labels);
    }
    Ok(map)
}

/// Replace `id`'s labels with `labels` (none clears them).
pub(super) async fn set_labels(
    conn: &mut SqliteConnection,
    project: &str,
    id: &str,
    labels: &[String],
) -> TResult<()> {
    sqlx::query("DELETE FROM item_labels WHERE item_id = ?")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    for label in labels {
        sqlx::query(
            "INSERT INTO item_labels (item_id, project, label, label_key) VALUES (?, ?, ?, ?)",
        )
        .bind(id)
        .bind(project)
        .bind(label)
        .bind(label_key(label))
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// The history's words for a label set: `Labels: Biomes, Physics.`, or
/// `Labels: none.` when it was cleared.
pub(super) fn labels_said(labels: &[String]) -> String {
    if labels.is_empty() {
        "Labels: none.".to_string()
    } else {
        format!("Labels: {}.", labels.join(", "))
    }
}

impl TrackerStore {
    /// A project's label vocabulary: every label its items carry, once each in
    /// the project's casing, sorted case-insensitively, with how many items
    /// carry it (and how many of those are queued). Empty for an unknown project.
    pub async fn project_labels(&self, project: &str) -> TResult<Vec<LabelCount>> {
        let rows: Vec<(String, i64, i64)> = sqlx::query_as(&format!(
            "SELECT MIN(l.label), COUNT(*), COALESCE(SUM(i.status IN {}), 0) \
             FROM item_labels l JOIN items i ON i.id = l.item_id \
             WHERE l.project = ? GROUP BY l.label_key ORDER BY l.label_key",
            super::items::QUEUED_IN
        ))
        .bind(project)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(label, count, queued)| LabelCount {
                label,
                count,
                queued,
            })
            .collect())
    }
}
