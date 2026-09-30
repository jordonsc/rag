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
//!
//! Same durability rules as the corpus `run`: token-safe batches, each topic
//! written as soon as its vectors arrive, its stale points pruned only after
//! ([`VectorStore::delete_topic_except_hash`]), and a [`Breaker`] (state beside
//! the ledger DB, on the volume the reconcile container mounts) that stops
//! re-attempting a reconcile that keeps failing identically.

use std::collections::HashSet;

use rag_core::config::Config;
use rag_core::hashing::hash_str;
use rag_core::ids;
use rag_core::ledger::{LedgerStore, Topic, TopicForIndex};
use rag_core::model::{Corpus, LedgerPayload, LedgerPoint, LedgerPointKind};
use rag_core::qdrant::VectorStore;
use rag_core::voyage::VoyageClient;

use crate::breaker::{self, Breaker};
use crate::chunker::Chunker;
use crate::pipeline::{self, Progress, UnitSink};

/// Breaker state file, kept beside the ledger DB.
const BREAKER_FILE: &str = ".rag-ledger-breaker.json";

/// One changed topic's points, waiting for their vectors.
struct PendingTopic {
    topic_id: String,
    topic_hash: String,
    points: Vec<LedgerPoint>,
}

/// Writes one topic's points, then retires its stale ones.
struct LedgerSink<'a> {
    store: &'a VectorStore,
    topics: &'a [PendingTopic],
}

impl UnitSink for LedgerSink<'_> {
    async fn persist(&mut self, unit: usize, vectors: Vec<Vec<f32>>) -> anyhow::Result<()> {
        let t = &self.topics[unit];
        if !t.points.is_empty() {
            self.store.upsert_ledger_points(&t.points, &vectors).await?;
        }
        self.store
            .delete_topic_except_hash(&t.topic_id, &t.topic_hash)
            .await?;
        Ok(())
    }
}

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

    // Topics gone from SQLite have no replacement to wait for. Changed topics keep
    // their old points until the new ones are written (see LedgerSink).
    for id in &removed {
        store.delete_by_topic(id).await?;
    }

    let fp = breaker::fingerprint(
        std::iter::once(format!(
            "ledger model={} dims={} chunk={}/{}",
            cfg.voyage.embed_model,
            cfg.voyage.dimensions,
            cfg.chunk.max_tokens,
            cfg.chunk.overlap_tokens
        ))
        .chain(
            changed
                .iter()
                .map(|t| format!("{}\u{0}{}", t.topic.topic_id, t.topic_hash)),
        ),
    );
    let breaker_path = cfg
        .ledger
        .db_path
        .parent()
        .map(|d| d.join(BREAKER_FILE))
        .unwrap_or_else(|| BREAKER_FILE.into());
    let mut breaker = Breaker::load(&breaker_path, cfg.ingest.breaker_threshold);
    if !changed.is_empty() && breaker.is_open(&fp) {
        let st = breaker.state();
        tracing::error!(
            consecutive = st.consecutive,
            changed_topics = changed.len(),
            last_error = %st.error,
            state = %breaker_path.display(),
            "CIRCUIT BREAKER OPEN: this ledger reconcile has failed identically {} runs in a row; \
             NOT re-attempting it until a topic changes (delete the state file to retry now)",
            st.consecutive
        );
        anyhow::bail!(
            "circuit breaker open: ledger reconcile of {} topics failed identically {} runs in a row (last error: {})",
            changed.len(),
            st.consecutive,
            st.error
        );
    }

    // Build the point set for changed topics. The topic point (title + summary +
    // current_state) stays whole — it's the canonical "what is this topic" vector.
    // Event bodies are free-form and can run long, so each is chunked into one
    // point per chunk (chunk_index in the deterministic id).
    let mut pending: Vec<PendingTopic> = Vec::with_capacity(changed.len());
    for t in &changed {
        let mut points: Vec<LedgerPoint> = Vec::new();
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
        pending.push(PendingTopic {
            topic_id: topic.topic_id.clone(),
            topic_hash: t.topic_hash.clone(),
            points,
        });
    }

    // Embed + persist topic by topic.
    let texts: Vec<String> = pending
        .iter()
        .flat_map(|t| t.points.iter().map(|p| p.payload.text.clone()))
        .collect();
    let unit_lens: Vec<usize> = pending.iter().map(|t| t.points.len()).collect();
    let mut progress = Progress::default();
    let mut sink = LedgerSink {
        store: &store,
        topics: &pending,
    };
    let outcome =
        pipeline::embed_units(&voyage, &texts, &unit_lens, &mut sink, &mut progress).await;
    let tokens = progress.tokens;

    let total = store.points_count().await.unwrap_or(0);
    println!("== reconcile-ledger ==");
    println!("topics in ledger : {}", topics.len());
    println!("unchanged        : {unchanged}");
    println!("changed/new      : {}", changed.len());
    println!("removed topics   : {}", removed.len());
    println!(
        "topics persisted : {} / {}",
        progress.units_persisted,
        pending.len()
    );
    println!("points pending   : {}", texts.len());
    println!("embedding tokens : {tokens}");
    println!("points in index  : {total}");
    println!("elapsed          : {:.1}s", started.elapsed().as_secs_f64());
    match outcome {
        Ok(()) => {
            breaker.record_success();
            Ok(())
        }
        Err(e) => {
            let n = breaker.record_failure(&fp, &format!("{e:#}"));
            tracing::error!(
                consecutive = n,
                threshold = breaker.threshold(),
                topics_persisted = progress.units_persisted,
                tokens,
                "ledger reconcile failed; the topics persisted above are kept"
            );
            Err(e)
        }
    }
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
