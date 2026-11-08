//! What the search index needs from the store (m05, D13): every document at its
//! current revision, every item with its notes and every phase (spec:roadmap D28),
//! read in one consistent pass.
//!
//! `rag-ingest reconcile-tracker` turns these into Qdrant points; this module only
//! reads. It returns plain records rather than the API's views so the reconcile
//! does not depend on how a route renders them.

use std::collections::BTreeMap;

use super::{DocKind, EventKind, ItemStatus, ItemType, PhaseState, TResult, TrackerStore};

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
    /// Whether it is blocked (rag-t0072): the search filters on it, and it is
    /// in the item's text, so a block or unblock re-indexes the item.
    pub blocked: bool,
    pub title: String,
    pub body: String,
    /// Its labels (rag-t0027), sorted case-insensitively; empty when none.
    pub labels: Vec<String>,
    /// The phase it is linked to, frozen or not; `None` for none. A frozen ticket
    /// stays in the corpus by design (spec:roadmap D28), so an agent searching
    /// before planning finds it.
    pub phase: Option<ItemPhase>,
    /// The notes written on it, oldest first: the bodies of its `note`, `status`,
    /// `block`, `unblock` and `approve` events, which are the ones a writer may
    /// explain (a note is optional since rag-t0007; without one the body is
    /// generated from the change, e.g. "Status: pending → done."). Generated bodies of
    /// other events ("Set title, body.") are left out: they carry no meaning
    /// beyond the fields, which the item's own text already holds.
    pub notes: Vec<String>,
}

/// An item's phase as its chunk header says it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemPhase {
    pub title: String,
    pub frozen: bool,
}

/// A phase as the index sees it (spec:roadmap D28): its title and body, in any
/// state. A phase is never deleted, so its point never is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhaseForIndex {
    /// `<project>-p<seq:04>`.
    pub id: String,
    pub project: String,
    pub title: String,
    pub body: String,
    pub state: PhaseState,
}

/// Everything the tracker corpus is built from, ordered by id so a reconcile is
/// deterministic.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IndexSnapshot {
    pub documents: Vec<DocForIndex>,
    pub items: Vec<ItemForIndex>,
    pub phases: Vec<PhaseForIndex>,
}

/// The event kinds whose bodies are notes worth indexing (see [`ItemForIndex::notes`]).
const NOTE_KINDS: &[EventKind] = &[
    EventKind::Note,
    EventKind::Status,
    EventKind::Block,
    EventKind::Unblock,
    EventKind::Approve,
];

/// One row of `all_for_index`'s read of the tickets, with the phase's title and `frozen`.
type ItemIndexRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    i64,
    i64,
);

impl TrackerStore {
    /// Every document, item and phase, for the search index. One read transaction,
    /// so a write landing mid-read cannot pair a document's new revision number with
    /// its old body, or a ticket's phase with a title it no longer has.
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

        let rows: Vec<ItemIndexRow> = sqlx::query_as(
            "SELECT i.id, i.project, i.type, i.status, i.title, i.body, p.title, i.frozen, \
             i.blocked FROM items i LEFT JOIN phases p ON p.id = i.phase_id ORDER BY i.id",
        )
        .fetch_all(&mut *tx)
        .await?;
        let mut items = Vec::with_capacity(rows.len());
        for (id, project, item_type, status, title, body, phase_title, frozen, blocked) in rows {
            let notes = notes.remove(&id).unwrap_or_default();
            let labels = labels.remove(&id).unwrap_or_default();
            let phase = phase_title.map(|title| ItemPhase {
                title,
                frozen: frozen != 0,
            });
            items.push(ItemForIndex {
                id,
                project,
                item_type: item_type.parse()?,
                status: status.parse()?,
                blocked: blocked != 0,
                title,
                body,
                labels,
                phase,
                notes,
            });
        }

        let rows: Vec<(String, String, String, String, String)> =
            sqlx::query_as("SELECT id, project, title, body, state FROM phases ORDER BY id")
                .fetch_all(&mut *tx)
                .await?;
        let mut phases = Vec::with_capacity(rows.len());
        for (id, project, title, body, state) in rows {
            phases.push(PhaseForIndex {
                id,
                project,
                title,
                body,
                state: state.parse()?,
            });
        }
        tx.commit().await?;
        Ok(IndexSnapshot {
            documents,
            items,
            phases,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        Actor, Approval, Edit, ItemUpdate, NewConcept, NewItem, NewPhase, Place, Surface,
        TrackerStore,
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
        assert!(!i.blocked);
        assert_eq!(i.item_type, ItemType::Recon);
        assert_eq!(i.labels, vec!["Heat", "physics"]);
        // The status note and the bare note, in order; not the generated create
        // or assign bodies.
        assert_eq!(
            i.notes,
            vec!["started by recon-1", "found the conduction loop"]
        );
        // Linked to no phase, and no phase to read.
        assert_eq!(i.phase, None);
        assert!(snap.phases.is_empty());
    }

    fn new_item(title: &str) -> NewItem {
        NewItem {
            draft: false,
            project: "ubu".into(),
            item_type: ItemType::Dev,
            title: title.into(),
            body: String::new(),
            assignee: None,
            approval: Approval::Unapproved,
            links: Vec::new(),
            intensity: None,
            release: false,
            parallel: false,
            labels: Vec::new(),
            place: Place::Bottom,
            note: None,
        }
    }

    fn new_phase(title: &str, body: &str) -> NewPhase {
        NewPhase {
            project: "ubu".into(),
            title: title.into(),
            body: body.into(),
            place: Place::Bottom,
            note: None,
        }
    }

    /// spec:roadmap D28: frozen tickets stay in, saying so; a phase is its own
    /// record; and a released ticket keeps naming its phase.
    #[tokio::test]
    async fn the_snapshot_holds_phases_and_each_items_phase() {
        let dir = tempfile::tempdir().unwrap();
        let s = TrackerStore::open(dir.path().join("tracker.db"), dir.path().join("att"))
            .await
            .unwrap();
        let a = actor();
        let creatures = s
            .create_phase(new_phase("Creatures", "All of them."), &a)
            .await
            .unwrap()
            .phase
            .id;
        let birds = s
            .create_phase(new_phase("Birds", ""), &a)
            .await
            .unwrap()
            .phase
            .id;
        let plain = s
            .create_item(new_item("Not in a phase"), &a)
            .await
            .unwrap()
            .item
            .id;
        let frozen = s
            .create_item_in_phase(new_item("Wolves"), &creatures, &a)
            .await
            .unwrap()
            .item
            .id;
        let thawed = s
            .create_item_in_phase(new_item("Sparrows"), &birds, &a)
            .await
            .unwrap()
            .item
            .id;
        s.release_phase(&birds, Place::Bottom, None, &a)
            .await
            .unwrap();

        let snap = s.all_for_index().await.unwrap();
        let of = |id: &str| {
            snap.items
                .iter()
                .find(|i| i.id == id)
                .unwrap_or_else(|| panic!("{id} is not in the snapshot"))
                .phase
                .clone()
        };
        assert_eq!(of(&plain), None);
        assert_eq!(
            of(&frozen),
            Some(ItemPhase {
                title: "Creatures".into(),
                frozen: true
            }),
            "a frozen ticket is present, and says so"
        );
        assert_eq!(
            of(&thawed),
            Some(ItemPhase {
                title: "Birds".into(),
                frozen: false
            }),
            "a released ticket keeps its link"
        );
        assert_eq!(
            snap.phases,
            vec![
                PhaseForIndex {
                    id: creatures,
                    project: "ubu".into(),
                    title: "Creatures".into(),
                    body: "All of them.".into(),
                    state: PhaseState::Planned,
                },
                PhaseForIndex {
                    id: birds,
                    project: "ubu".into(),
                    title: "Birds".into(),
                    body: String::new(),
                    state: PhaseState::Released,
                },
            ],
            "by id, in any state"
        );
    }
}
