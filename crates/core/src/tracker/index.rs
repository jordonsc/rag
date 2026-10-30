//! What the search index needs from the store (m05, D13): every document at its
//! current revision and every item with its notes, read in one consistent pass.
//!
//! `rag-ingest reconcile-tracker` turns these into Qdrant points; this module only
//! reads. It returns plain records rather than the API's views so the reconcile
//! does not depend on how a route renders them.

use std::collections::BTreeMap;

use super::{DocKind, EventKind, ItemStatus, ItemType, TResult, TrackerStore};

/// A document as the index sees it: its record and its current body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocForIndex {
    /// `<project>-d<seq:04>`.
    pub id: String,
    pub project: String,
    pub path: String,
    pub kind: DocKind,
    pub title: String,
    pub revision: i64,
    pub body: String,
}

/// An item as the index sees it: its record and the notes on its history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemForIndex {
    /// `<project>-t<seq:04>`.
    pub id: String,
    pub project: String,
    pub item_type: ItemType,
    pub status: ItemStatus,
    pub title: String,
    pub body: String,
    /// Its labels (rag-t0027), sorted case-insensitively; empty when none.
    pub labels: Vec<String>,
    /// The notes written on it, oldest first: the bodies of its `note`, `status`,
    /// `block`, `unblock` and `approve` events, which are the ones a writer may
    /// explain (a note is optional since rag-t0007; without one the body is
    /// generated from the change, e.g. "Status: pending → done."). Generated bodies of
    /// other events ("Set title, body.") are left out: they carry no meaning
    /// beyond the fields, which the item's own text already holds.
    pub notes: Vec<String>,
}

/// Everything the tracker corpus is built from, ordered by id so a reconcile is
/// deterministic.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IndexSnapshot {
    pub documents: Vec<DocForIndex>,
    pub items: Vec<ItemForIndex>,
}

/// The event kinds whose bodies are notes worth indexing (see [`ItemForIndex::notes`]).
const NOTE_KINDS: &[EventKind] = &[
    EventKind::Note,
    EventKind::Status,
    EventKind::Block,
    EventKind::Unblock,
    EventKind::Approve,
];

impl TrackerStore {
    /// Every document and item, for the search index. One read transaction, so
    /// a write landing mid-read cannot pair a document's new revision number with
    /// its old body.
    pub async fn all_for_index(&self) -> TResult<IndexSnapshot> {
        let mut tx = self.pool.begin().await?;

        let docs: Vec<(String, String, String, String, String, i64, String)> = sqlx::query_as(
            "SELECT d.id, d.project, d.path, d.kind, d.title, d.revision, r.body \
             FROM documents d JOIN revisions r ON r.doc_id = d.id AND r.revision = d.revision \
             ORDER BY d.id",
        )
        .fetch_all(&mut *tx)
        .await?;
        let mut documents = Vec::with_capacity(docs.len());
        for (id, project, path, kind, title, revision, body) in docs {
            documents.push(DocForIndex {
                id,
                project,
                path,
                kind: kind.parse()?,
                title,
                revision,
                body,
            });
        }

        let kinds: Vec<&str> = NOTE_KINDS.iter().map(|k| k.as_str()).collect();
        let placeholders = vec!["?"; kinds.len()].join(",");
        let sql = format!(
            "SELECT target_id, body FROM events WHERE target_kind = 'item' \
             AND kind IN ({placeholders}) ORDER BY event_id"
        );
        let mut q = sqlx::query_as::<_, (String, String)>(&sql);
        for k in &kinds {
            q = q.bind(*k);
        }
        let mut notes: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (target, body) in q.fetch_all(&mut *tx).await? {
            let body = body.trim();
            if !body.is_empty() {
                notes.entry(target).or_default().push(body.to_string());
            }
        }

        let mut labels: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let label_rows: Vec<(String, String)> =
            sqlx::query_as("SELECT item_id, label FROM item_labels ORDER BY label_key, label")
                .fetch_all(&mut *tx)
                .await?;
        for (id, label) in label_rows {
            labels.entry(id).or_default().push(label);
        }

        let rows: Vec<(String, String, String, String, String, String)> =
            sqlx::query_as("SELECT id, project, type, status, title, body FROM items ORDER BY id")
                .fetch_all(&mut *tx)
                .await?;
        let mut items = Vec::with_capacity(rows.len());
        for (id, project, item_type, status, title, body) in rows {
            let notes = notes.remove(&id).unwrap_or_default();
            let labels = labels.remove(&id).unwrap_or_default();
            items.push(ItemForIndex {
                id,
                project,
                item_type: item_type.parse()?,
                status: status.parse()?,
                title,
                body,
                labels,
                notes,
            });
        }
        tx.commit().await?;
        Ok(IndexSnapshot { documents, items })
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        Actor, Approval, Edit, ItemUpdate, NewConcept, NewItem, Place, Surface, TrackerStore,
    };
    use super::*;

    fn actor() -> Actor {
        Actor::new("dev@example.com", Some("Claude Test"), Surface::Mcp)
    }

    #[tokio::test]
    async fn the_snapshot_holds_current_bodies_and_item_notes() {
        let dir = tempfile::tempdir().unwrap();
        let s = TrackerStore::open(dir.path().join("tracker.db"), dir.path().join("att"))
            .await
            .unwrap();
        let c = s
            .create_concept(
                NewConcept {
                    draft: false,
                    project: "ubu".into(),
                    slug: "power".into(),
                    title: "Power".into(),
                    state: None,
                    approval: Approval::Unapproved,
                    body: "first body".into(),
                    links: Vec::new(),
                    note: None,
                },
                &actor(),
            )
            .await
            .unwrap();
        let doc_id = c.concept.doc_id.unwrap();
        s.edit_document(&doc_id, 1, Edit::Body("second body".into()), None, &actor())
            .await
            .unwrap();
        let item = s
            .create_item(
                NewItem {
                    draft: false,
                    project: "ubu".into(),
                    item_type: ItemType::Recon,
                    title: "Map the heat code".into(),
                    body: "brief".into(),
                    assignee: None,
                    approval: Approval::Unapproved,
                    links: Vec::new(),
                    intensity: None,
                    release: false,
                    parallel: false,
                    labels: vec!["physics".into(), "Heat".into()],
                    place: Place::Bottom,
                    note: None,
                },
                &actor(),
            )
            .await
            .unwrap()
            .item
            .id;
        let a = actor();
        for u in [
            ItemUpdate {
                status: Some(ItemStatus::InProgress),
                note: Some("started by recon-1".into()),
                ..Default::default()
            },
            ItemUpdate {
                assignee: Some("recon-1".into()),
                ..Default::default()
            },
            ItemUpdate {
                note: Some("found the conduction loop".into()),
                ..Default::default()
            },
        ] {
            s.update_item(&item, u, &a).await.unwrap();
        }

        let snap = s.all_for_index().await.unwrap();
        assert_eq!(snap.documents.len(), 1);
        let d = &snap.documents[0];
        assert_eq!(d.id, doc_id);
        assert_eq!(d.path, "concepts/power.md");
        assert_eq!(d.kind, DocKind::Concept);
        assert_eq!((d.revision, d.body.as_str()), (2, "second body"));

        assert_eq!(snap.items.len(), 1);
        let i = &snap.items[0];
        assert_eq!(i.status, ItemStatus::InProgress);
        assert_eq!(i.item_type, ItemType::Recon);
        assert_eq!(i.labels, vec!["Heat", "physics"]);
        // The status note and the bare note, in order; not the generated create
        // or assign bodies.
        assert_eq!(
            i.notes,
            vec!["started by recon-1", "found the conduction loop"]
        );
    }
}
