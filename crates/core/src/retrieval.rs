//! The shared retrieval pipeline: embed query → ANN search (filtered) → rerank.
//!
//! This is the single implementation of the retrieval quality pipeline. Both the
//! HTTP service (`rag-serve`, Phase 05) and the MCP server (`rag-mcp`, Phase 06)
//! drive it, so the pipeline lives in one place and is never duplicated.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::time::Instant;

use serde::Serialize;

use crate::config::Config;
use crate::error::Result;
use crate::model::{RankedHit, SearchFilters};
use crate::qdrant::VectorStore;
use crate::voyage::VoyageClient;

/// A retrieval request: the query plus knobs. `top_k == 0` means "use the
/// configured default".
#[derive(Debug, Clone)]
pub struct RetrievalRequest {
    pub query: String,
    pub top_k: usize,
    pub filters: SearchFilters,
    pub rerank: bool,
}

/// Per-stage wall-clock timings in milliseconds, surfaced for latency reporting.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Timings {
    pub embed_ms: u64,
    pub search_ms: u64,
    pub rerank_ms: u64,
    pub total_ms: u64,
}

/// The outcome of a retrieval: ranked hits plus diagnostics.
#[derive(Debug, Clone, Serialize)]
pub struct RetrievalResult {
    pub hits: Vec<RankedHit>,
    /// Candidate count after filtering, before the top-`k` cut.
    pub candidates: usize,
    /// Whether the rerank stage actually ran.
    pub reranked: bool,
    pub timings: Timings,
}

/// Owns the external clients and runs the pipeline. Construct once and share
/// across requests — the inner clients are cheap/thread-safe.
pub struct Retriever {
    store: VectorStore,
    voyage: VoyageClient,
    over_fetch: usize,
    default_top_k: usize,
    /// Score multiplier applied to `corpus = ledger` hits before the top-k cut.
    ledger_weight: f32,
}

impl Retriever {
    /// Construct from explicit clients and tuning knobs.
    pub fn new(
        store: VectorStore,
        voyage: VoyageClient,
        over_fetch: usize,
        default_top_k: usize,
        ledger_weight: f32,
    ) -> Self {
        Self {
            store,
            voyage,
            over_fetch: over_fetch.max(1),
            default_top_k: default_top_k.max(1),
            ledger_weight,
        }
    }

    /// Build from config + environment. Reads `VOYAGE_API_KEY` (required) and an
    /// optional `QDRANT_API_KEY`; fails loudly if the Voyage key is missing.
    pub fn from_env(cfg: &Config) -> Result<Self> {
        let store = VectorStore::from_env(&cfg.qdrant)?;
        let voyage = VoyageClient::from_env(cfg.voyage.clone())?;
        Ok(Self::new(
            store,
            voyage,
            cfg.server.over_fetch,
            cfg.server.default_top_k,
            cfg.server.ledger_weight,
        ))
    }

    /// The underlying store (for liveness / stats from the service layer).
    pub fn store(&self) -> &VectorStore {
        &self.store
    }

    /// The default `top_k` applied when a request omits it.
    pub fn default_top_k(&self) -> usize {
        self.default_top_k
    }

    /// Run the full pipeline: embed the query (`input_type = query`), ANN-search an
    /// over-fetch candidate set with payload filters, optionally rerank, and return
    /// the top `top_k` ranked, cited hits.
    pub async fn retrieve(&self, req: &RetrievalRequest) -> Result<RetrievalResult> {
        let started = Instant::now();
        let top_k = if req.top_k == 0 {
            self.default_top_k
        } else {
            req.top_k
        };

        // 1. Embed the query.
        let t = Instant::now();
        let vector = self.voyage.embed_query(&req.query).await?;
        let embed_ms = t.elapsed().as_millis() as u64;

        // 2. ANN search over the over-fetch set with payload filters.
        let t = Instant::now();
        let mut hits = self
            .store
            .search_filtered(vector, self.over_fetch as u64, &req.filters)
            .await?;
        let search_ms = t.elapsed().as_millis() as u64;

        // path_prefix has no keyword index, so apply it here on the portable path.
        if let Some(prefix) = req.filters.path_prefix.as_deref() {
            if !prefix.is_empty() {
                hits.retain(|h| h.rel_path.starts_with(prefix));
            }
        }
        let candidates = hits.len();

        // 3. Rerank (optional). Score each candidate, then apply the ledger weight
        //    and collapse-by-topic before the top_k cut (see `finalise`).
        let mut rerank_ms = 0u64;
        let reranked = req.rerank && !hits.is_empty();
        let scored: Vec<(f32, RankedHit)> = if reranked {
            let t = Instant::now();
            let docs: Vec<String> = hits.iter().map(|h| h.text.clone()).collect();
            let order = self.voyage.rerank(&req.query, &docs).await?;
            rerank_ms = t.elapsed().as_millis() as u64;
            order
                .into_iter()
                .filter_map(|(idx, score)| {
                    hits.get(idx)
                        .map(|h| (score, RankedHit::from_hit(h, Some(score))))
                })
                .collect()
        } else {
            hits.iter()
                .map(|h| (h.score, RankedHit::from_hit(h, None)))
                .collect()
        };
        let ranked = self.finalise(scored, top_k);

        Ok(RetrievalResult {
            hits: ranked,
            candidates,
            reranked,
            timings: Timings {
                embed_ms,
                search_ms,
                rerank_ms,
                total_ms: started.elapsed().as_millis() as u64,
            },
        })
    }

    /// Apply the per-corpus weight, collapse ledger hits to one per topic, re-sort
    /// by effective score, and take the top `top_k`.
    ///
    /// - **Weight**: `corpus = ledger` scores are multiplied by `ledger_weight`
    ///   (1.0 = neutral). Lets ledger be demoted globally without removing it.
    /// - **Topic-collapse**: among hits sharing a `topic_id`, only the
    ///   highest-scoring survives, so one topic's history can't flood the results.
    fn finalise(&self, mut scored: Vec<(f32, RankedHit)>, top_k: usize) -> Vec<RankedHit> {
        if (self.ledger_weight - 1.0).abs() > f32::EPSILON {
            for (score, hit) in scored.iter_mut() {
                if hit.corpus == "ledger" {
                    *score *= self.ledger_weight;
                }
            }
        }
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(Ordering::Equal));

        let mut seen_topics: HashSet<String> = HashSet::new();
        scored
            .into_iter()
            .filter(|(_, hit)| match &hit.topic_id {
                Some(t) => seen_topics.insert(t.clone()),
                None => true,
            })
            .map(|(_, hit)| hit)
            .take(top_k)
            .collect()
    }
}
