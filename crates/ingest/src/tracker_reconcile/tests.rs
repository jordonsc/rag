//! The tracker reconcile against a real (temporary) tracker store, an in-memory
//! index standing in for Qdrant and a fake embedder standing in for Voyage: no
//! network, no spend (m05 § Tests).

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

use rag_core::error::Error;
use rag_core::tracker::{
    Actor, Approval, Edit, ItemStatus, ItemType, ItemUpdate, NewConcept, NewDocument, NewItem,
    Place, Surface, TrackerStore,
};
use uuid::Uuid;

use super::*;

/// Embeds each text as `[len]`; fails every request once `fail` is set.
#[derive(Default)]
struct FakeEmbedder {
    calls: Cell<usize>,
    texts: Cell<usize>,
    fail: Cell<bool>,
}

impl BatchEmbedder for FakeEmbedder {
    async fn embed(&self, texts: &[String]) -> rag_core::Result<(Vec<Vec<f32>>, u64)> {
        self.calls.set(self.calls.get() + 1);
        if self.fail.get() {
            return Err(Error::Voyage("503: unavailable".into()));
        }
        self.texts.set(self.texts.get() + texts.len());
        Ok((
            texts.iter().map(|t| vec![t.len() as f32]).collect(),
            texts.iter().map(|t| t.len() as u64).sum(),
        ))
    }
}

/// The index as a map of point id to payload, with Qdrant's semantics for the
/// four calls the reconcile makes.
#[derive(Default)]
struct MemIndex {
    points: RefCell<BTreeMap<Uuid, TrackerPayload>>,
}

impl MemIndex {
    fn of(&self, tracker_id: &str) -> Vec<TrackerPayload> {
        let mut v: Vec<TrackerPayload> = self
            .points
            .borrow()
            .values()
            .filter(|p| p.tracker_id == tracker_id)
            .cloned()
            .collect();
        v.sort_by_key(|p| p.chunk_index);
        v
    }
}

impl TrackerIndex for MemIndex {
    async fn unit_hashes(&self) -> anyhow::Result<HashMap<String, String>> {
        let mut map: HashMap<String, String> = HashMap::new();
        for p in self.points.borrow().values() {
            let e = map
                .entry(p.tracker_id.clone())
                .or_insert_with(|| p.tracker_hash.clone());
            if *e != p.tracker_hash {
                *e = rag_core::qdrant::MIXED_HASH.to_string();
            }
        }
        Ok(map)
    }
    async fn upsert(&self, points: &[TrackerPoint], vectors: &[Vec<f32>]) -> anyhow::Result<()> {
        assert_eq!(points.len(), vectors.len());
        let mut m = self.points.borrow_mut();
        for p in points {
            m.insert(p.id, p.payload.clone());
        }
        Ok(())
    }
    async fn prune(&self, tracker_id: &str, keep_hash: &str) -> anyhow::Result<()> {
        self.points
            .borrow_mut()
            .retain(|_, p| p.tracker_id != tracker_id || p.tracker_hash == keep_hash);
        Ok(())
    }
    async fn remove(&self, tracker_id: &str) -> anyhow::Result<()> {
        self.points
            .borrow_mut()
            .retain(|_, p| p.tracker_id != tracker_id);
        Ok(())
    }
}

struct Fx {
    _dir: tempfile::TempDir,
    store: TrackerStore,
    index: MemIndex,
    embedder: FakeEmbedder,
    /// 100 characters a chunk, so a short fixture spans several.
    chunker: Chunker,
}

async fn fx() -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let store = TrackerStore::open(dir.path().join("tracker.db"), dir.path().join("att"))
        .await
        .unwrap();
    Fx {
        _dir: dir,
        store,
        index: MemIndex::default(),
        embedder: FakeEmbedder::default(),
        chunker: Chunker::new(25, 0).unwrap(),
    }
}

fn actor() -> Actor {
    Actor::new("dev@example.com", Some("Claude Test"), Surface::Mcp)
}

impl Fx {
    /// One reconcile, as `run` does it minus the breaker.
    async fn reconcile(&self) -> anyhow::Result<Plan> {
        let snapshot = self.store.all_for_index().await?;
        let indexed = self.index.unit_hashes().await?;
        let plan = plan(&snapshot, &indexed, &self.chunker)?;
        remove_gone(&plan, &self.index).await?;
        let mut progress = Progress::default();
        embed_changed(&plan, &self.index, &self.embedder, &mut progress).await?;
        Ok(plan)
    }

    async fn concept(&self, slug: &str, body: &str) -> String {
        self.store
            .create_concept(
                NewConcept {
                    draft: false,
                    project: "ubu".into(),
                    slug: slug.into(),
                    title: format!("Concept {slug}"),
                    state: None,
                    approval: Approval::Unapproved,
                    body: body.into(),
                    links: Vec::new(),
                    note: None,
                },
                &actor(),
            )
            .await
            .unwrap()
            .concept
            .doc_id
            .unwrap()
    }

    async fn item(&self, title: &str) -> String {
        self.store
            .create_item(
                NewItem {
                    draft: false,
                    project: "ubu".into(),
                    item_type: ItemType::Dev,
                    title: title.into(),
                    body: "Build the solar film.".into(),
                    assignee: None,
                    approval: Approval::Unapproved,
                    links: Vec::new(),
                    intensity: None,
                    release: false,
                    parallel: false,
                    labels: Vec::new(),
                    place: Place::Bottom,
                    note: None,
                },
                &actor(),
            )
            .await
            .unwrap()
            .item
            .id
    }
}

/// Four paragraphs, each about 60 characters: several 100-character chunks.
fn long_body(tag: &str) -> String {
    (1..=4)
        .map(|n| format!("Paragraph {n} of {tag}: the solar film covers the roof panels."))
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[tokio::test]
async fn documents_and_items_are_indexed_with_their_citations() {
    let f = fx().await;
    let doc = f.concept("power", &long_body("r1")).await;
    let item = f.item("Fit the solar film").await;

    let plan = f.reconcile().await.unwrap();
    assert_eq!((plan.units, plan.changed.len()), (2, 2));

    let chunks = f.index.of(&doc);
    assert!(chunks.len() > 1, "the fixture spans chunks");
    for (n, c) in chunks.iter().enumerate() {
        assert_eq!(c.corpus, Corpus::Tracker);
        assert_eq!(c.repo, "ubu");
        assert_eq!(c.rel_path, "concepts/power.md");
        assert_eq!(c.kind, "concept");
        assert_eq!(c.point_kind, "document");
        assert_eq!(c.title, "Concept power");
        assert_eq!(c.revision, Some(1));
        assert_eq!(c.citation, "ubu:concepts/power.md@r1");
        assert_eq!(c.chunk_index as usize, n);
        assert!(c.start_line >= 1 && c.start_line <= c.end_line);
        assert!(
            c.text
                .starts_with("Concept power · ubu:concepts/power.md\n\n"),
            "each chunk names its document: {:?}",
            c.text
        );
    }
    assert_eq!(chunks[0].start_line, 1);
    assert_eq!(chunks.last().unwrap().end_line, 7);

    let it = f.index.of(&item);
    assert_eq!(it.len(), 1, "an item is one point");
    let it = &it[0];
    assert_eq!(it.citation, item);
    assert_eq!(it.rel_path, item);
    assert_eq!(it.kind, "item");
    assert_eq!(it.item_type.as_deref(), Some("dev"));
    assert_eq!(it.status.as_deref(), Some("pending"));
    assert_eq!(it.revision, None);
    assert!(it.text.contains("Fit the solar film") && it.text.contains("Build the solar film."));
}

#[tokio::test]
async fn an_unchanged_store_costs_nothing() {
    let f = fx().await;
    f.concept("power", &long_body("r1")).await;
    f.item("Fit the solar film").await;
    f.reconcile().await.unwrap();
    let calls = f.embedder.calls.get();
    let before = f.index.points.borrow().clone();

    let plan = f.reconcile().await.unwrap();
    assert_eq!((plan.unchanged, plan.changed.len()), (2, 0));
    assert_eq!(f.embedder.calls.get(), calls, "no embedding request");
    assert_eq!(*f.index.points.borrow(), before);
}

#[tokio::test]
async fn an_edit_replaces_its_points_and_leaves_none_of_the_old_revision() {
    let f = fx().await;
    let doc = f.concept("power", &long_body("r1")).await;
    let other = f.concept("heat", "Heat moves by conduction.").await;
    f.reconcile().await.unwrap();
    let before = f.index.of(&doc).len();
    let other_before = f.index.of(&other);

    // A much shorter body: fewer chunks than before, so a stale tail would show.
    f.store
        .edit_document(
            &doc,
            1,
            Edit::Body("One line about wind turbines.".into()),
            None,
            &actor(),
        )
        .await
        .unwrap();
    let texts = f.embedder.texts.get();
    let plan = f.reconcile().await.unwrap();
    assert_eq!(plan.changed.len(), 1, "only the edited document");
    assert_eq!(f.embedder.texts.get() - texts, 1, "one new chunk embedded");

    let after = f.index.of(&doc);
    assert!(before > 1);
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].revision, Some(2));
    assert_eq!(after[0].citation, "ubu:concepts/power.md@r2");
    assert!(after[0].text.contains("wind turbines"));
    assert!(
        f.index
            .points
            .borrow()
            .values()
            .all(|p| p.revision != Some(1) || p.tracker_id != doc),
        "no point of revision 1 is left"
    );
    assert_eq!(
        f.index.of(&other),
        other_before,
        "the other document is untouched"
    );
}

#[tokio::test]
async fn a_rename_moves_the_points_to_the_new_path() {
    let f = fx().await;
    let doc = f
        .store
        .create_document(
            NewDocument {
                draft: false,
                project: "ubu".into(),
                path: "specs/old/notes.md".into(),
                title: "Notes".into(),
                body: long_body("notes"),
                message: None,
            },
            &actor(),
        )
        .await
        .unwrap()
        .document
        .id;
    f.reconcile().await.unwrap();
    let n = f.index.of(&doc).len();

    f.store
        .rename_document(
            &doc,
            Some("specs/new/notes.md"),
            None,
            Some("move"),
            &actor(),
        )
        .await
        .unwrap();
    f.reconcile().await.unwrap();

    let after = f.index.of(&doc);
    assert_eq!(after.len(), n);
    assert!(after.iter().all(|p| p.rel_path == "specs/new/notes.md"
        && p.citation.starts_with("ubu:specs/new/notes.md@r")
        && p.kind == "doc"));
    assert!(
        f.index
            .points
            .borrow()
            .values()
            .all(|p| !p.rel_path.starts_with("specs/old/")),
        "nothing is left at the old path"
    );
}

#[tokio::test]
async fn a_status_change_and_a_note_update_the_items_point() {
    let f = fx().await;
    let item = f.item("Fit the solar film").await;
    f.reconcile().await.unwrap();
    let id = f.index.points.borrow().keys().copied().collect::<Vec<_>>();

    f.store
        .update_item(
            &item,
            ItemUpdate {
                status: Some(ItemStatus::InProgress),
                note: Some("dev-2 took it".into()),
                ..Default::default()
            },
            &actor(),
        )
        .await
        .unwrap();
    let plan = f.reconcile().await.unwrap();
    assert_eq!(plan.changed.len(), 1);

    let p = f.index.of(&item);
    assert_eq!(p.len(), 1);
    assert_eq!(p[0].status.as_deref(), Some("in_progress"));
    assert!(p[0].text.contains("in_progress"));
    assert!(p[0].text.contains("Notes:\n- dev-2 took it"));
    assert_eq!(
        f.index.points.borrow().keys().copied().collect::<Vec<_>>(),
        id,
        "the same point, rewritten in place"
    );
}

#[tokio::test]
async fn a_unit_gone_from_the_store_is_purged() {
    let f = fx().await;
    f.item("Fit the solar film").await;
    f.reconcile().await.unwrap();
    // A unit the store does not hold (a deleted record, or another store's).
    let stray = TrackerPayload {
        tracker_id: "ubu-d0099".into(),
        ..f.index.of("ubu-t0001")[0].clone()
    };
    f.index
        .points
        .borrow_mut()
        .insert(ids::tracker_point_id("ubu-d0099", 0), stray);
    let plan = f.reconcile().await.unwrap();
    assert_eq!(plan.removed, vec!["ubu-d0099".to_string()]);
    assert!(f.index.of("ubu-d0099").is_empty());
    assert_eq!(f.index.of("ubu-t0001").len(), 1);
}

#[tokio::test]
async fn a_failed_embed_keeps_the_old_points_until_the_new_ones_are_written() {
    let f = fx().await;
    let doc = f.concept("power", &long_body("r1")).await;
    f.reconcile().await.unwrap();
    let before = f.index.of(&doc);

    f.store
        .edit_document(&doc, 1, Edit::Body("Wind instead.".into()), None, &actor())
        .await
        .unwrap();
    f.embedder.fail.set(true);
    assert!(f.reconcile().await.is_err());
    assert_eq!(f.index.of(&doc), before, "write-then-prune: nothing lost");

    f.embedder.fail.set(false);
    f.reconcile().await.unwrap();
    assert_eq!(f.index.of(&doc)[0].revision, Some(2));
}

#[tokio::test]
async fn an_empty_document_is_one_point_of_its_heading() {
    let f = fx().await;
    let doc = f.concept("blank", "").await;
    f.reconcile().await.unwrap();
    let p = f.index.of(&doc);
    assert_eq!(p.len(), 1);
    assert_eq!(p[0].text, "Concept blank · ubu:concepts/blank.md");
    assert_eq!(
        f.reconcile().await.unwrap().changed.len(),
        0,
        "and it settles: not re-embedded every run"
    );
}

#[tokio::test]
async fn a_deferred_item_stays_indexed_with_its_status() {
    // rag-t0017: deferred is a status like any other; the reconcile keeps the
    // item's point and rewrites it, never drops it.
    let f = fx().await;
    let item = f.item("Fit the solar film").await;
    f.reconcile().await.unwrap();
    f.store
        .update_item(
            &item,
            ItemUpdate {
                status: Some(ItemStatus::Deferred),
                ..Default::default()
            },
            &actor(),
        )
        .await
        .unwrap();
    let plan = f.reconcile().await.unwrap();
    assert_eq!(plan.changed.len(), 1);
    let p = f.index.of(&item);
    assert!(!p.is_empty());
    assert!(
        p.iter().all(|x| x.status.as_deref() == Some("deferred")),
        "{p:#?}"
    );
    assert!(p[0].text.contains("· deferred"), "{}", p[0].text);
}

#[test]
fn item_text_carries_what_the_item_is() {
    let i = ItemForIndex {
        id: "ubu-t0042".into(),
        project: "ubu".into(),
        item_type: ItemType::Gate,
        status: ItemStatus::Failed,
        title: "Standard gate".into(),
        body: String::new(),
        labels: Vec::new(),
        notes: vec!["clippy red".into()],
    };
    assert_eq!(
        item_text(&i),
        "Standard gate\nubu ubu-t0042 · gate · failed\n\nNotes:\n- clippy red"
    );
}

#[test]
fn item_text_carries_its_labels_only_when_it_has_some() {
    let mut i = ItemForIndex {
        id: "ubu-t0050".into(),
        project: "ubu".into(),
        item_type: ItemType::Dev,
        status: ItemStatus::Pending,
        title: "Gas buoyancy".into(),
        body: "Parcels rise.".into(),
        labels: vec!["Gases".into(), "Physics".into()],
        notes: Vec::new(),
    };
    assert_eq!(
        item_text(&i),
        "Gas buoyancy\nubu ubu-t0050 · dev · pending\nLabels: Gases, Physics\n\nParcels rise."
    );
    let labelled = item_hash(&item_text(&i));
    // Without labels the text is as it was before labels existed, so an
    // unlabelled item's point is not rewritten (INDEX_FORMAT is unchanged).
    i.labels.clear();
    assert_eq!(
        item_text(&i),
        "Gas buoyancy\nubu ubu-t0050 · dev · pending\n\nParcels rise."
    );
    assert_ne!(item_hash(&item_text(&i)), labelled);
}
