//! `reconcile-tracker` — make the Qdrant `corpus = tracker` points match the
//! tracker's SQLite store (`specs/tracker/master.md` D13, m05 TS-01),
//! idempotently and incrementally.
//!
//! The same shape as [`crate::ledger_reconcile`]: a **pull-based** diff of
//! `tracker_id -> tracker_hash` (the store) against the index, re-embedding only
//! the units that changed and purging the ones that are gone. A *unit* is what is
//! replaced together:
//!
//! * **a document** (`ubu-d0007`): its current revision's body, chunked by the
//!   markdown chunker, one point a chunk, each with the project, path, kind, title,
//!   revision and the chunk's line range. Point ids are keyed on the document id,
//!   not the path, so an edit or a rename overwrites the same points and prunes the
//!   tail: no point of an old revision or an old path survives a reconcile.
//! * **an item** (`ubu-t0042`): one point of its title, type, status, labels, body
//!   and notes (chunked only if it outgrows a chunk, which a queue item rarely
//!   does). A status or label change changes its hash, so its point is rewritten.
//!
//! Durability as the corpus and the ledger: token-safe batches, each unit written
//! as soon as its vectors arrive and its stale points pruned only after, and a
//! [`Breaker`] (state beside `tracker.db`) that stops re-attempting a reconcile that
//! keeps failing identically. `rag-serve` touches a trigger file after every
//! tracker write so this runs within seconds; a 15-minute timer is the backstop.

use std::collections::{HashMap, HashSet};
use std::future::Future;

use rag_core::config::Config;
use rag_core::hashing::hash_str;
use rag_core::ids;
use rag_core::model::{Corpus, TrackerPayload, TrackerPoint, TrackerPointKind};
use rag_core::qdrant::VectorStore;
use rag_core::tracker::{DocForIndex, IndexSnapshot, ItemForIndex, TrackerStore};
use rag_core::voyage::VoyageClient;

use crate::breaker::{self, Breaker};
use crate::chunker::Chunker;
use crate::pipeline::{self, BatchEmbedder, Progress, UnitSink};

/// Breaker state file, kept beside the tracker DB.
const BREAKER_FILE: &str = ".rag-tracker-breaker.json";

/// The layout of a unit's points. Part of every unit's hash, so changing how a
/// unit is turned into points (its text, its payload) re-indexes every unit on
/// the next run instead of leaving the old layout in place until each is edited.
///
/// Not bumped for labels (rag-t0027): an item's hash is taken over its text, the
/// `Labels:` line is only written when it has labels, so an unlabelled item's
/// text and point are unchanged and a labelled one re-indexes by its own hash.
const INDEX_FORMAT: u32 = 1;

/// Where tracker points are written. [`VectorStore`] in production; a map in
/// the tests, so the reconcile is exercised without Qdrant.
pub trait TrackerIndex {
    /// `tracker_id -> tracker_hash` for every indexed unit.
    fn unit_hashes(&self) -> impl Future<Output = anyhow::Result<HashMap<String, String>>>;
    /// Write points with their vectors (`points[i]` pairs with `vectors[i]`).
    fn upsert(
        &self,
        points: &[TrackerPoint],
        vectors: &[Vec<f32>],
    ) -> impl Future<Output = anyhow::Result<()>>;
    /// Delete a unit's points that do not carry `keep_hash`.
    fn prune(&self, tracker_id: &str, keep_hash: &str) -> impl Future<Output = anyhow::Result<()>>;
    /// Delete every point of a unit.
    fn remove(&self, tracker_id: &str) -> impl Future<Output = anyhow::Result<()>>;
}

impl TrackerIndex for VectorStore {
    async fn unit_hashes(&self) -> anyhow::Result<HashMap<String, String>> {
        Ok(self.tracker_unit_hashes().await?)
    }
    async fn upsert(&self, points: &[TrackerPoint], vectors: &[Vec<f32>]) -> anyhow::Result<()> {
        Ok(self.upsert_tracker_points(points, vectors).await?)
    }
    async fn prune(&self, tracker_id: &str, keep_hash: &str) -> anyhow::Result<()> {
        Ok(self
            .delete_tracker_except_hash(tracker_id, keep_hash)
            .await?)
    }
    async fn remove(&self, tracker_id: &str) -> anyhow::Result<()> {
        Ok(self.delete_by_tracker_id(tracker_id).await?)
    }
}

/// One changed unit's points, waiting for their vectors.
#[derive(Debug)]
pub struct Unit {
    pub tracker_id: String,
    pub tracker_hash: String,
    pub points: Vec<TrackerPoint>,
}

/// What a reconcile will do.
#[derive(Debug, Default)]
pub struct Plan {
    /// Units in the store.
    pub units: usize,
    pub unchanged: u64,
    /// Units new or changed since they were indexed, with their points.
    pub changed: Vec<Unit>,
    /// Units indexed but no longer in the store.
    pub removed: Vec<String>,
}

/// The citation of a document chunk: `<project>:<path>@r<revision>`.
pub fn doc_citation(d: &DocForIndex) -> String {
    format!("{}:{}@r{}", d.project, d.path, d.revision)
}

fn doc_hash(d: &DocForIndex) -> String {
    hash_str(&format!(
        "tracker-doc v{INDEX_FORMAT}\u{0}{}\u{0}{}\u{0}{}\u{0}{}\u{0}{}\u{0}{}",
        d.project, d.path, d.kind, d.title, d.revision, d.body
    ))
}

/// An item's searchable text: its title, what it is, its labels (when it has
/// any), its body and its notes.
pub fn item_text(i: &ItemForIndex) -> String {
    let mut t = format!(
        "{}\n{} {} · {} · {}",
        i.title, i.project, i.id, i.item_type, i.status
    );
    if !i.labels.is_empty() {
        t.push_str("\nLabels: ");
        t.push_str(&i.labels.join(", "));
    }
    if !i.body.trim().is_empty() {
        t.push_str("\n\n");
        t.push_str(i.body.trim());
    }
    if !i.notes.is_empty() {
        t.push_str("\n\nNotes:");
        for n in &i.notes {
            t.push_str("\n- ");
            t.push_str(n);
        }
    }
    t
}

fn item_hash(text: &str) -> String {
    hash_str(&format!("tracker-item v{INDEX_FORMAT}\u{0}{text}"))
}

/// A document's points: one per chunk of its current body. Each chunk's text
/// carries a heading line naming the document, so a chunk from deep inside a
/// long spec still says what it is part of, to the embedder and to the reader.
pub fn doc_unit(d: &DocForIndex, hash: String, chunker: &Chunker) -> anyhow::Result<Unit> {
    let citation = doc_citation(d);
    let mut chunks = chunker.chunk_text_lines(&d.body)?;
    if chunks.is_empty() {
        // An empty body still has a title worth finding, and a unit with no
        // points would never show as indexed, so it would be "changed" every run.
        chunks.push((0, 0, String::new()));
    }
    let mut points = Vec::new();
    for (ci, (start, end, chunk)) in chunks.into_iter().enumerate() {
        let heading = format!("{} · {}:{}", d.title, d.project, d.path);
        let text = if chunk.is_empty() {
            heading
        } else {
            format!("{heading}\n\n{chunk}")
        };
        points.push(TrackerPoint {
            id: ids::tracker_point_id(&d.id, ci as u32),
            payload: TrackerPayload {
                corpus: Corpus::Tracker,
                repo: d.project.clone(),
                rel_path: d.path.clone(),
                language: "markdown".into(),
                tracker_id: d.id.clone(),
                point_kind: TrackerPointKind::Document.as_str().into(),
                kind: d.kind.as_str().into(),
                item_type: None,
                status: None,
                title: d.title.clone(),
                revision: Some(d.revision),
                citation: citation.clone(),
                chunk_index: ci as u32,
                start_line: start,
                end_line: end,
                content_hash: hash_str(&text),
                text,
                tracker_hash: hash.clone(),
            },
        });
    }
    Ok(Unit {
        tracker_id: d.id.clone(),
        tracker_hash: hash,
        points,
    })
}

/// An item's point (more than one only if its text outgrows a chunk).
pub fn item_unit(
    i: &ItemForIndex,
    text: &str,
    hash: String,
    chunker: &Chunker,
) -> anyhow::Result<Unit> {
    let mut points = Vec::new();
    for (ci, chunk) in chunker.chunk_text(text)?.into_iter().enumerate() {
        points.push(TrackerPoint {
            id: ids::tracker_point_id(&i.id, ci as u32),
            payload: TrackerPayload {
                corpus: Corpus::Tracker,
                repo: i.project.clone(),
                rel_path: i.id.clone(),
                language: "markdown".into(),
                tracker_id: i.id.clone(),
                point_kind: TrackerPointKind::Item.as_str().into(),
                kind: "item".into(),
                item_type: Some(i.item_type.as_str().into()),
                status: Some(i.status.as_str().into()),
                title: i.title.clone(),
                revision: None,
                citation: i.id.clone(),
                chunk_index: ci as u32,
                start_line: 0,
                end_line: 0,
                content_hash: hash_str(&chunk),
                text: chunk,
                tracker_hash: hash.clone(),
            },
        });
    }
    Ok(Unit {
        tracker_id: i.id.clone(),
        tracker_hash: hash,
        points,
    })
}

/// Diff the store against the index. Only changed units are chunked.
pub fn plan(
    snapshot: &IndexSnapshot,
    indexed: &HashMap<String, String>,
    chunker: &Chunker,
) -> anyhow::Result<Plan> {
    let mut plan = Plan {
        units: snapshot.documents.len() + snapshot.items.len(),
        ..Default::default()
    };
    let mut desired: HashSet<&str> = HashSet::with_capacity(plan.units);
    for d in &snapshot.documents {
        desired.insert(&d.id);
        let hash = doc_hash(d);
        if indexed.get(&d.id) == Some(&hash) {
            plan.unchanged += 1;
        } else {
            plan.changed.push(doc_unit(d, hash, chunker)?);
        }
    }
    for i in &snapshot.items {
        desired.insert(&i.id);
        let text = item_text(i);
        let hash = item_hash(&text);
        if indexed.get(&i.id) == Some(&hash) {
            plan.unchanged += 1;
        } else {
            plan.changed.push(item_unit(i, &text, hash, chunker)?);
        }
    }
    let mut removed: Vec<String> = indexed
        .keys()
        .filter(|id| !desired.contains(id.as_str()))
        .cloned()
        .collect();
    removed.sort();
    plan.removed = removed;
    Ok(plan)
}

/// Writes one unit's points, then retires its stale ones.
struct TrackerSink<'a, I> {
    index: &'a I,
    units: &'a [Unit],
}

impl<I: TrackerIndex> UnitSink for TrackerSink<'_, I> {
    async fn persist(&mut self, unit: usize, vectors: Vec<Vec<f32>>) -> anyhow::Result<()> {
        let u = &self.units[unit];
        if !u.points.is_empty() {
            self.index.upsert(&u.points, &vectors).await?;
        }
        self.index.prune(&u.tracker_id, &u.tracker_hash).await
    }
}

/// Purge the units that left the store. Free, so never behind the breaker.
async fn remove_gone<I: TrackerIndex>(plan: &Plan, index: &I) -> anyhow::Result<()> {
    for id in &plan.removed {
        index.remove(id).await?;
    }
    Ok(())
}

/// Embed and persist the changed units, unit by unit.
async fn embed_changed<I: TrackerIndex, E: BatchEmbedder>(
    plan: &Plan,
    index: &I,
    embedder: &E,
    progress: &mut Progress,
) -> anyhow::Result<usize> {
    let texts: Vec<String> = plan
        .changed
        .iter()
        .flat_map(|u| u.points.iter().map(|p| p.payload.text.clone()))
        .collect();
    let unit_lens: Vec<usize> = plan.changed.iter().map(|u| u.points.len()).collect();
    let mut sink = TrackerSink {
        index,
        units: &plan.changed,
    };
    pipeline::embed_units(embedder, &texts, &unit_lens, &mut sink, progress).await?;
    Ok(texts.len())
}

pub async fn run(cfg: &Config) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let store = VectorStore::from_env(&cfg.qdrant)?;
    store.health().await?;
    let voyage = VoyageClient::from_env(cfg.voyage.clone())?;
    let chunker = Chunker::new(cfg.chunk.max_tokens, cfg.chunk.overlap_tokens)?;
    let tracker = TrackerStore::open(&cfg.tracker.db_path, &cfg.tracker.attachments_dir).await?;

    let snapshot = tracker.all_for_index().await?;
    let indexed = store.unit_hashes().await?;
    let plan = plan(&snapshot, &indexed, &chunker)?;
    remove_gone(&plan, &store).await?;

    let fp = breaker::fingerprint(
        std::iter::once(format!(
            "tracker v{INDEX_FORMAT} model={} dims={} chunk={}/{}",
            cfg.voyage.embed_model,
            cfg.voyage.dimensions,
            cfg.chunk.max_tokens,
            cfg.chunk.overlap_tokens
        ))
        .chain(
            plan.changed
                .iter()
                .map(|u| format!("{}\u{0}{}", u.tracker_id, u.tracker_hash)),
        ),
    );
    let breaker_path = cfg
        .tracker
        .db_path
        .parent()
        .map(|d| d.join(BREAKER_FILE))
        .unwrap_or_else(|| BREAKER_FILE.into());
    let mut breaker = Breaker::load(&breaker_path, cfg.ingest.breaker_threshold);
    if !plan.changed.is_empty() && breaker.is_open(&fp) {
        let st = breaker.state();
        tracing::error!(
            consecutive = st.consecutive,
            changed_units = plan.changed.len(),
            last_error = %st.error,
            state = %breaker_path.display(),
            "CIRCUIT BREAKER OPEN: this tracker reconcile has failed identically {} runs in a row; \
             NOT re-attempting it until a document or item changes (delete the state file to retry now)",
            st.consecutive
        );
        anyhow::bail!(
            "circuit breaker open: tracker reconcile of {} units failed identically {} runs in a row (last error: {})",
            plan.changed.len(),
            st.consecutive,
            st.error
        );
    }

    let mut progress = Progress::default();
    let outcome = embed_changed(&plan, &store, &voyage, &mut progress).await;
    let points: usize = plan.changed.iter().map(|u| u.points.len()).sum();

    let total = store.points_count().await.unwrap_or(0);
    println!("== reconcile-tracker ==");
    println!(
        "units in tracker : {} ({} documents, {} items)",
        plan.units,
        snapshot.documents.len(),
        snapshot.items.len()
    );
    println!("unchanged        : {}", plan.unchanged);
    println!("changed/new      : {}", plan.changed.len());
    println!("removed units    : {}", plan.removed.len());
    println!(
        "units persisted  : {} / {}",
        progress.units_persisted,
        plan.changed.len()
    );
    println!("points pending   : {points}");
    println!("embedding tokens : {}", progress.tokens);
    println!("points in index  : {total}");
    println!("elapsed          : {:.1}s", started.elapsed().as_secs_f64());
    match outcome {
        Ok(_) => {
            breaker.record_success();
            Ok(())
        }
        Err(e) => {
            let n = breaker.record_failure(&fp, &format!("{e:#}"));
            tracing::error!(
                consecutive = n,
                threshold = breaker.threshold(),
                units_persisted = progress.units_persisted,
                tokens = progress.tokens,
                "tracker reconcile failed; the units persisted above are kept"
            );
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests;
