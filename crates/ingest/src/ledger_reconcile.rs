//! `reconcile-ledger` — make the Qdrant `corpus = ledger` points match the SQLite
//! ledger, idempotently and incrementally.
//!
//! The SQLite ledger is the source of truth; this is a **pull-based** reconcile,
//! not a write-time hook. It diffs `topic_id -> topic_hash` (SQLite) against the
//! index (Qdrant) and re-embeds only changed/new topics, deleting points for
//! topics that changed (stale) or no longer exist. Because it compares table state
//! rather than intercepting writes, changes made outside the MCP/HTTP path (a
//! manual SQL edit, a future CLI) are caught too. `rag-serve` pokes a trigger file
//! after each write so this runs within seconds; the 15-min timer is the backstop.
//!
//! Each topic maps to one **topic point** (title + summary + current_state) plus
//! one **event point per monologue event** (the event body), so deep history is
//! semantically searchable, not just the current summary.

use std::collections::HashSet;

use rag_core::config::Config;
use rag_core::hashing::hash_str;
use rag_core::ids;
use rag_core::ledger::{LedgerStore, Topic, TopicForIndex};
use rag_core::model::{Corpus, LedgerPayload, LedgerPoint, LedgerPointKind};
use rag_core::qdrant::VectorStore;
use rag_core::voyage::VoyageClient;

use crate::chunker::Chunker;

/// Points per Qdrant upsert request (matches the corpus ingest batch).
const UPSERT_BATCH: usize = 256;

pub async fn run(cfg: &Config) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let store = VectorStore::from_env(&cfg.qdrant)?;
    store.health().await?;
    let voyage = VoyageClient::from_env(cfg.voyage.clone())?;
    let chunker = Chunker::new(cfg.chunk.max_tokens, cfg.chunk.overlap_tokens)?;
    let ledger = LedgerStore::open(&cfg.ledger.db_path).await?;

    // Source of truth + current index snapshot.
    let topics = ledger.all_for_index().await?;
    let indexed = store.ledger_topic_hashes().await?;
    let desired: HashSet<&str> = topics.iter().map(|t| t.topic.topic_id.as_str()).collect();

    // Diff: a topic is changed if its hash differs from (or is absent in) the index.
    let mut changed: Vec<&TopicForIndex> = Vec::new();
    let mut unchanged = 0u64;
    for t in &topics {
        if indexed.get(&t.topic.topic_id) == Some(&t.topic_hash) {
            unchanged += 1;
        } else {
            changed.push(t);
        }
    }

    // Topics indexed but gone from SQLite → purge entirely.
    let removed: Vec<String> = indexed
        .keys()
        .filter(|id| !desired.contains(id.as_str()))
        .cloned()
        .collect();

    // Drop stale points for changed topics and removed topics before re-upserting.
    for t in &changed {
        store.delete_by_topic(&t.topic.topic_id).await?;
    }
    for id in &removed {
        store.delete_by_topic(id).await?;
    }

    // Build the point set for changed topics. The topic point (title + summary +
    // current_state) stays whole — it's the canonical "what is this topic" vector.
    // Event bodies are free-form and can run long, so each is chunked into one
    // point per chunk (chunk_index in the deterministic id).
    let mut points: Vec<LedgerPoint> = Vec::new();
    for t in &changed {
        let topic = &t.topic;
        let topic_text = format!(
            "{}\n\n{}\n\n{}",
            topic.title, topic.summary, topic.current_state
        );
        points.push(make_point(
            topic,
            ids::ledger_topic_id(&topic.topic_id),
            LedgerPointKind::Topic,
            topic_text,
            &t.topic_hash,
        ));
        for ev in &t.events {
            for (ci, chunk) in chunker.chunk_text(&ev.body)?.into_iter().enumerate() {
                points.push(make_point(
                    topic,
                    ids::ledger_event_id(&topic.topic_id, ev.event_id, ci as u32),
                    LedgerPointKind::Event,
                    chunk,
                    &t.topic_hash,
                ));
            }
        }
    }

    // Embed + upsert in batches.
    let mut tokens = 0u64;
    if !points.is_empty() {
        let texts: Vec<String> = points.iter().map(|p| p.payload.text.clone()).collect();
        let (vectors, used) = voyage.embed_documents(&texts).await?;
        tokens = used;
        anyhow::ensure!(
            vectors.len() == points.len(),
            "embedding count {} != point count {}",
            vectors.len(),
            points.len()
        );
        for (pb, vb) in points
            .chunks(UPSERT_BATCH)
            .zip(vectors.chunks(UPSERT_BATCH))
        {
            store.upsert_ledger_points(pb, vb).await?;
        }
    }

    let total = store.points_count().await?;
    println!("== reconcile-ledger ==");
    println!("topics in ledger : {}", topics.len());
    println!("unchanged        : {unchanged}");
    println!("changed/new      : {}", changed.len());
    println!("removed topics   : {}", removed.len());
    println!("points upserted  : {}", points.len());
    println!("embedding tokens : {tokens}");
    println!("points in index  : {total}");
    println!("elapsed          : {:.1}s", started.elapsed().as_secs_f64());
    Ok(())
}

fn make_point(
    topic: &Topic,
    id: uuid::Uuid,
    kind: LedgerPointKind,
    text: String,
    topic_hash: &str,
) -> LedgerPoint {
    let content_hash = hash_str(&text);
    LedgerPoint {
        id,
        payload: LedgerPayload {
            corpus: Corpus::Ledger,
            repo: topic.repo.clone(),
            topic_id: topic.topic_id.clone(),
            topic_type: topic.topic_type.as_str().to_string(),
            status: topic.status.as_str().to_string(),
            title: topic.title.clone(),
            text,
            point_kind: kind.as_str().to_string(),
            content_hash,
            topic_hash: topic_hash.to_string(),
        },
    }
}
