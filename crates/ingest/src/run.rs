//! `run` — embed + index the corpus into Qdrant, idempotently and incrementally.
//!
//! Strategy: snapshot the index (`path -> file_hash`), diff it against the current
//! corpus, then (re)embed only changed/new files, delete stale points for changed
//! files, and remove points for files that no longer exist. Embedding is batched
//! across all changed chunks so a full ingest is a few hundred requests, not one
//! per file.

use std::collections::HashSet;

use rag_core::config::Config;
use rag_core::hashing::hash_str;
use rag_core::model::{Chunk, Corpus};
use rag_core::qdrant::VectorStore;
use rag_core::voyage::VoyageClient;
use rayon::prelude::*;

use crate::chunker::Chunker;
use crate::discovery::DiscoveredFile;
use crate::source::{self, Source};

/// Points per Qdrant upsert request.
const UPSERT_BATCH: usize = 256;

pub struct RunOptions {
    pub corpus: Option<Corpus>,
    pub repo: Option<String>,
    /// Re-embed everything in scope, ignoring the unchanged-hash check.
    pub full: bool,
    pub source: Source,
}

pub async fn run(cfg: &Config, opts: &RunOptions) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let store = VectorStore::from_env(&cfg.qdrant)?;
    store.health().await?;
    let voyage = VoyageClient::from_env(cfg.voyage.clone())?;
    let chunker = Chunker::new(cfg.chunk.max_tokens, cfg.chunk.overlap_tokens)?;

    // 1. Resolve the corpus source (local FS or GitHub clones).
    let resolved = source::resolve(cfg, opts.source, opts.corpus, opts.repo.as_deref()).await?;
    let files = resolved.files;

    // Purge archived/excluded repos (GitHub source) before diffing.
    let mut purged_repos = 0;
    if let Some(gh) = &resolved.github {
        for repo in &gh.purge_repos {
            store.delete_by_repo(repo).await?;
            purged_repos += 1;
        }
    }

    // Existing index snapshot (scoped to the same filter).
    let index = store
        .index_file_hashes(opts.corpus, opts.repo.as_deref())
        .await?;
    tracing::info!(
        corpus_files = files.len(),
        indexed_paths = index.len(),
        "diffing corpus against index"
    );

    // 2. Decide per-file actions: hash files in parallel, compare to the index.
    let hashes: Vec<(usize, String)> = files
        .par_iter()
        .enumerate()
        .filter_map(|(i, f)| {
            std::fs::read_to_string(&f.path)
                .ok()
                .map(|t| (i, hash_str(&t)))
        })
        .collect();

    let mut changed: Vec<&DiscoveredFile> = Vec::new();
    let mut delete_paths: Vec<String> = Vec::new();
    let mut unchanged = 0u64;
    let discovered: HashSet<String> = files.iter().map(path_str).collect();

    for (i, file_hash) in &hashes {
        let file = &files[*i];
        let path = path_str(file);
        let current = index.get(&path);
        if !opts.full && current == Some(file_hash) {
            unchanged += 1;
        } else {
            changed.push(file);
            if current.is_some() {
                // File exists in the index but changed → drop its stale points first.
                delete_paths.push(path);
            }
        }
    }

    // Files in the index that no longer exist in the corpus → remove entirely.
    let removed: Vec<String> = index
        .keys()
        .filter(|p| !discovered.contains(p.as_str()))
        .cloned()
        .collect();
    delete_paths.extend(removed.iter().cloned());

    // 3. Apply deletions (stale + removed).
    for path in &delete_paths {
        store.delete_by_path(path).await?;
    }

    // 4. Chunk changed files in parallel, then embed all chunks in batches.
    let chunks: Vec<Chunk> = changed
        .par_iter()
        .flat_map_iter(|f| {
            chunker
                .chunk_file(f)
                .map(|(c, _)| c)
                .unwrap_or_default()
                .into_iter()
        })
        .collect();

    let mut tokens = 0u64;
    if !chunks.is_empty() {
        let texts: Vec<String> = chunks.iter().map(|c| c.payload.text.clone()).collect();
        let (vectors, used) = voyage.embed_documents(&texts).await?;
        tokens = used;
        anyhow::ensure!(
            vectors.len() == chunks.len(),
            "embedding count {} != chunk count {}",
            vectors.len(),
            chunks.len()
        );
        for (cb, vb) in chunks
            .chunks(UPSERT_BATCH)
            .zip(vectors.chunks(UPSERT_BATCH))
        {
            store.upsert_chunks(cb, vb).await?;
        }
    }

    let total = store.points_count().await?;
    println!("== ingest run ==");
    println!("corpus files     : {}", files.len());
    println!("unchanged        : {unchanged}");
    println!("changed/new      : {}", changed.len());
    println!("removed files    : {}", removed.len());
    println!("purged repos     : {purged_repos}");
    println!("chunks upserted  : {}", chunks.len());
    println!("embedding tokens : {tokens}");
    println!("points in index  : {total}");
    println!("elapsed          : {:.1}s", started.elapsed().as_secs_f64());
    Ok(())
}

/// Path as stored in the payload (lossy string, matching the chunker).
fn path_str(f: &DiscoveredFile) -> String {
    f.path.to_string_lossy().into_owned()
}
