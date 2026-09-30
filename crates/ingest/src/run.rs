//! `run` — embed + index the corpus into Qdrant, idempotently and incrementally.
//!
//! Strategy: snapshot the index (`path -> file_hash`), diff it against the current
//! corpus, and (re)embed only changed/new files. Files that no longer exist are
//! removed outright. Everything else is ordered so that **a failed run keeps what
//! it paid for and never leaves a file with fewer points than it started with**:
//!
//! * Embedding is batched across files in token-safe batches, and each file is
//!   written the moment its last vector arrives ([`pipeline::embed_units`]) — a
//!   run that fails at batch *k* has persisted every file finished before it.
//! * A changed file's old points are deleted only **after** its new points are
//!   written, and only those not carrying the new `file_hash`
//!   ([`VectorStore::delete_path_except_hash`]). Interrupted between the two, the
//!   path carries mixed hashes, which the next diff reads as changed
//!   ([`rag_core::qdrant::MIXED_HASH`]) and finishes.
//! * The pending work is fingerprinted, and a [`Breaker`] stops re-attempting work
//!   that has failed identically `ingest.breaker_threshold` runs in a row.

use std::collections::HashSet;

use anyhow::Context;
use rag_core::config::Config;
use rag_core::hashing::hash_str;
use rag_core::model::{Chunk, Corpus};
use rag_core::qdrant::VectorStore;
use rag_core::voyage::VoyageClient;
use rayon::prelude::*;

use crate::breaker::{self, Breaker};
use crate::chunker::Chunker;
use crate::discovery::DiscoveredFile;
use crate::pipeline::{self, Progress, UnitSink};
use crate::source::{self, Source};

pub struct RunOptions {
    pub corpus: Option<Corpus>,
    pub repo: Option<String>,
    /// Re-embed everything in scope, ignoring the unchanged-hash check.
    pub full: bool,
    pub source: Source,
    /// Attempt the work even if the circuit breaker is open for it.
    pub force: bool,
}

/// A changed file, chunked and waiting for its vectors.
struct PendingFile {
    path: String,
    /// The hash its new points carry; everything else under `path` is stale.
    file_hash: String,
    chunks: Vec<Chunk>,
}

/// Writes one file's points, then retires its stale ones.
struct CorpusSink<'a> {
    store: &'a VectorStore,
    files: &'a [PendingFile],
}

impl UnitSink for CorpusSink<'_> {
    async fn persist(&mut self, unit: usize, vectors: Vec<Vec<f32>>) -> anyhow::Result<()> {
        let file = &self.files[unit];
        if !file.chunks.is_empty() {
            self.store
                .upsert_chunks(&file.chunks, &vectors)
                .await
                .with_context(|| format!("upsert {}", file.path))?;
        }
        self.store
            .delete_path_except_hash(&file.path, &file.file_hash)
            .await
            .with_context(|| format!("prune stale points of {}", file.path))?;
        Ok(())
    }
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
    for (reason, n) in &resolved.skips {
        tracing::info!(?reason, files = n, "skipped during discovery");
    }

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

    let mut changed: Vec<(&DiscoveredFile, String)> = Vec::new();
    let mut unchanged = 0u64;
    let discovered: HashSet<String> = files.iter().map(path_str).collect();

    for (i, file_hash) in &hashes {
        let file = &files[*i];
        let current = index.get(&path_str(file));
        if !opts.full && current == Some(file_hash) {
            unchanged += 1;
        } else {
            changed.push((file, file_hash.clone()));
        }
    }

    // 3. Files in the index that no longer exist in the corpus (deleted, or now
    // excluded by a .ragignore or the density guard) → remove entirely. There is
    // no replacement to wait for, and this costs nothing, so it is not gated.
    let removed: Vec<String> = index
        .keys()
        .filter(|p| !discovered.contains(p.as_str()))
        .cloned()
        .collect();
    for path in &removed {
        store.delete_by_path(path).await?;
    }

    // 4. The breaker: is this exact work known to fail?
    let fp = work_fingerprint(cfg, opts, &changed);
    let mut breaker = Breaker::load(cfg.breaker_path(), cfg.ingest.breaker_threshold);
    if !changed.is_empty() && breaker.is_open(&fp) {
        let st = breaker.state();
        if opts.force {
            tracing::warn!(
                consecutive = st.consecutive,
                "circuit breaker is OPEN for this work; --force given, attempting anyway"
            );
        } else {
            tracing::error!(
                consecutive = st.consecutive,
                threshold = breaker.threshold(),
                changed_files = changed.len(),
                last_error = %st.error,
                state = %cfg.breaker_path().display(),
                "CIRCUIT BREAKER OPEN: this exact work has failed identically {} runs in a row; \
                 NOT re-attempting it (no embedding spend). It is retried when the pending \
                 files or the config change, or by running with --force.",
                st.consecutive
            );
            anyhow::bail!(
                "circuit breaker open: {} changed files have failed identically {} runs in a row (last error: {})",
                changed.len(),
                st.consecutive,
                st.error
            );
        }
    }

    // 5. Chunk changed files in parallel, one unit per file. A file that cannot be
    // chunked is left exactly as indexed (its old points stay) and retried next run.
    let chunked: Vec<Option<PendingFile>> = changed
        .par_iter()
        .map(|(f, diff_hash)| match chunker.chunk_file(f) {
            Ok((chunks, _)) => Some(PendingFile {
                path: path_str(f),
                file_hash: chunks
                    .first()
                    .map(|c| c.payload.file_hash.clone())
                    .unwrap_or_else(|| diff_hash.clone()),
                chunks,
            }),
            Err(e) => {
                tracing::warn!(path = %f.path.display(), error = %e, "could not chunk; leaving its indexed points as they are");
                None
            }
        })
        .collect();
    let pending: Vec<PendingFile> = chunked.into_iter().flatten().collect();
    let texts: Vec<String> = pending
        .iter()
        .flat_map(|f| f.chunks.iter().map(|c| c.payload.text.clone()))
        .collect();
    let unit_lens: Vec<usize> = pending.iter().map(|f| f.chunks.len()).collect();

    // 6. Embed + persist file by file.
    let mut progress = Progress::default();
    let mut sink = CorpusSink {
        store: &store,
        files: &pending,
    };
    let outcome =
        pipeline::embed_units(&voyage, &texts, &unit_lens, &mut sink, &mut progress).await;

    let total = store.points_count().await.unwrap_or(0);
    println!("== ingest run ==");
    println!("corpus files     : {}", files.len());
    println!("unchanged        : {unchanged}");
    println!("changed/new      : {}", changed.len());
    println!(
        "files persisted  : {} / {}",
        progress.units_persisted,
        pending.len()
    );
    println!("removed files    : {}", removed.len());
    println!("purged repos     : {purged_repos}");
    println!("chunks pending   : {}", texts.len());
    println!("embed requests   : {}", progress.batches);
    println!("embedding tokens : {}", progress.tokens);
    println!("points in index  : {total}");
    println!("elapsed          : {:.1}s", started.elapsed().as_secs_f64());

    match outcome {
        Ok(()) => {
            breaker.record_success();
            Ok(())
        }
        Err(e) => {
            let message = format!("{e:#}");
            let n = breaker.record_failure(&fp, &message);
            tracing::error!(
                consecutive = n,
                threshold = breaker.threshold(),
                files_persisted = progress.units_persisted,
                files_pending = pending.len(),
                tokens = progress.tokens,
                "ingest run failed; the files persisted above are kept and will not be re-embedded"
            );
            if breaker.threshold() > 0 && n >= breaker.threshold() {
                tracing::error!(
                    "CIRCUIT BREAKER OPENED after {n} identical failures: the next runs will not \
                     re-attempt this work until the pending files or the config change"
                );
            }
            Err(e)
        }
    }
}

/// Fingerprint of what this run is about to spend on: the pending files and their
/// hashes, plus everything that decides their chunks and vectors.
fn work_fingerprint(
    cfg: &Config,
    opts: &RunOptions,
    changed: &[(&DiscoveredFile, String)],
) -> String {
    let context = format!(
        "model={} dims={} chunk={}/{} full={} corpus={:?} repo={:?}",
        cfg.voyage.embed_model,
        cfg.voyage.dimensions,
        cfg.chunk.max_tokens,
        cfg.chunk.overlap_tokens,
        opts.full,
        opts.corpus.map(|c| c.as_str()),
        opts.repo,
    );
    breaker::fingerprint(
        std::iter::once(context).chain(
            changed
                .iter()
                .map(|(f, h)| format!("{}\u{0}{h}", path_str(f))),
        ),
    )
}

/// Path as stored in the payload (lossy string, matching the chunker).
fn path_str(f: &DiscoveredFile) -> String {
    f.path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn file(path: &str) -> DiscoveredFile {
        DiscoveredFile {
            corpus: Corpus::Code,
            repo: "r".into(),
            path: PathBuf::from(path),
            rel_path: path.into(),
        }
    }

    fn opts() -> RunOptions {
        RunOptions {
            corpus: None,
            repo: None,
            full: false,
            source: Source::Local,
            force: false,
        }
    }

    #[test]
    fn the_fingerprint_moves_when_the_work_or_its_config_moves() {
        let cfg = Config::default();
        let (a, b) = (file("/r/a.rs"), file("/r/b.rs"));
        let base = work_fingerprint(&cfg, &opts(), &[(&a, "1".into()), (&b, "2".into())]);
        // Same work, different order: same fingerprint (the breaker counts it).
        assert_eq!(
            base,
            work_fingerprint(&cfg, &opts(), &[(&b, "2".into()), (&a, "1".into())])
        );
        // A file's content changed: new work.
        assert_ne!(
            base,
            work_fingerprint(&cfg, &opts(), &[(&a, "1".into()), (&b, "3".into())])
        );
        // Progress was made (a file persisted): new work.
        assert_ne!(base, work_fingerprint(&cfg, &opts(), &[(&b, "2".into())]));
        // The embedding model changed: new work.
        let mut other = Config::default();
        other.voyage.embed_model = "voyage-4".into();
        assert_ne!(
            base,
            work_fingerprint(&other, &opts(), &[(&a, "1".into()), (&b, "2".into())])
        );
    }
}
