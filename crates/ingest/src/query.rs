//! `query` — embed a query and run a raw vector search (no rerank).
//!
//! A debug aid to prove the embed → search loop end to end before the real
//! retrieval service (Phase 05) adds reranking and filters.

use rag_core::config::Config;
use rag_core::qdrant::VectorStore;
use rag_core::voyage::VoyageClient;

pub async fn query(cfg: &Config, text: &str, limit: u64) -> anyhow::Result<()> {
    let store = VectorStore::from_env(&cfg.qdrant)?;
    store.health().await?;
    let voyage = VoyageClient::from_env(cfg.voyage.clone())?;

    let vector = voyage.embed_query(text).await?;
    let hits = store.search(vector, limit).await?;

    println!("== top {} for: {text:?} ==", hits.len());
    for (i, h) in hits.iter().enumerate() {
        let preview: String = h
            .text
            .chars()
            .take(140)
            .collect::<String>()
            .replace('\n', " ");
        println!(
            "\n{:>2}. [{:.4}] {}:{}-{}  ({}/{})",
            i + 1,
            h.score,
            h.path,
            h.start_line,
            h.end_line,
            h.corpus,
            h.repo
        );
        println!("    {preview}");
    }
    Ok(())
}
