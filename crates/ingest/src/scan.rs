//! `scan` — read-only corpus walk + chunk, reporting what would be ingested.
//!
//! No embedding, no DB writes. Used to validate discovery/ignore rules, grammar
//! coverage, and chunk sizing before the real ingest (Phase 04). Chunking runs in
//! parallel across files (rayon) since it is CPU-bound and per-file independent.

use std::collections::BTreeMap;

use rag_core::config::Config;
use rag_core::model::Corpus;
use rayon::prelude::*;

use crate::chunker::Chunker;
use crate::discovery::{self, SkipReason};
use crate::source::{self, Source};

pub struct ScanOptions {
    pub corpus: Option<Corpus>,
    pub repo: Option<String>,
    /// Print up to this many sample chunks as JSON to stdout.
    pub sample: usize,
    pub source: Source,
}

/// Per-file outcome produced in parallel, then reduced.
struct FileSummary {
    language: String,
    chunk_count: u64,
    code_fallback: bool,
    error: bool,
    sample: Option<serde_json::Value>,
}

#[derive(Default)]
struct Stats {
    files_scanned: u64,
    files_no_chunks: u64,
    total_chunks: u64,
    errors: u64,
    /// language -> (files, chunks)
    per_language: BTreeMap<String, (u64, u64)>,
    /// code-fallback language -> file count
    fallback: BTreeMap<String, u64>,
}

pub async fn run(cfg: &Config, opts: &ScanOptions) -> anyhow::Result<()> {
    let resolved = source::resolve(cfg, opts.source, opts.corpus, opts.repo.as_deref()).await?;
    let files = resolved.files;
    let skips = resolved.skips;
    let chunker = Chunker::new(cfg.chunk.max_tokens, cfg.chunk.overlap_tokens)?;
    let want_sample = opts.sample > 0;

    let summaries: Vec<FileSummary> = files
        .par_iter()
        .map(|file| {
            let t0 = std::time::Instant::now();
            let result = chunker.chunk_file(file);
            let dt = t0.elapsed();
            if dt.as_secs_f64() > 2.0 {
                tracing::warn!(path = %file.path.display(), secs = dt.as_secs_f64(), "slow file");
            }
            match result {
                Ok((chunks, code_fallback)) => {
                    let language = chunks
                        .first()
                        .map(|c| c.payload.language.clone())
                        .unwrap_or_else(|| crate::language::classify(&file.path).language);
                    let sample = if want_sample {
                        chunks.first().map(sample_json)
                    } else {
                        None
                    };
                    FileSummary {
                        language,
                        chunk_count: chunks.len() as u64,
                        code_fallback,
                        error: false,
                        sample,
                    }
                }
                Err(e) => {
                    tracing::warn!(path = %file.path.display(), error = %e, "chunk failed");
                    FileSummary {
                        language: crate::language::classify(&file.path).language,
                        chunk_count: 0,
                        code_fallback: false,
                        error: true,
                        sample: None,
                    }
                }
            }
        })
        .collect();

    let mut stats = Stats::default();
    let mut samples = Vec::new();
    for s in &summaries {
        stats.files_scanned += 1;
        if s.error {
            stats.errors += 1;
            continue;
        }
        if s.chunk_count == 0 {
            stats.files_no_chunks += 1;
        }
        let entry = stats.per_language.entry(s.language.clone()).or_default();
        entry.0 += 1;
        entry.1 += s.chunk_count;
        stats.total_chunks += s.chunk_count;
        if s.code_fallback {
            *stats.fallback.entry(s.language.clone()).or_default() += 1;
        }
        if samples.len() < opts.sample {
            if let Some(v) = &s.sample {
                samples.push(v.clone());
            }
        }
    }

    report(&files, &skips, &stats);

    if !samples.is_empty() {
        println!("\n--- sample chunks ({}) ---", samples.len());
        for s in samples {
            println!("{}", serde_json::to_string(&s)?);
        }
    }
    Ok(())
}

fn report(files: &[discovery::DiscoveredFile], skips: &[(SkipReason, u64)], stats: &Stats) {
    println!("== corpus scan ==");
    println!("files selected : {}", files.len());
    println!("files chunked  : {}", stats.files_scanned - stats.errors);
    println!("files w/0 chunks: {}", stats.files_no_chunks);
    println!("errors         : {}", stats.errors);
    println!("total chunks   : {}", stats.total_chunks);

    println!("\n-- by language (files / chunks) --");
    let mut langs: Vec<_> = stats.per_language.iter().collect();
    langs.sort_by(|a, b| b.1 .1.cmp(&a.1 .1));
    for (lang, (f, c)) in langs {
        println!("  {lang:14} {f:>6} files  {c:>8} chunks");
    }

    if !skips.is_empty() {
        println!("\n-- skipped --");
        for (reason, n) in skips {
            println!("  {reason:?}: {n}");
        }
    }

    if !stats.fallback.is_empty() {
        println!("\n-- code-grammar coverage gaps (chunked as text) --");
        for (ext, n) in &stats.fallback {
            println!("  {ext}: {n} files");
        }
    }
}

fn sample_json(chunk: &rag_core::model::Chunk) -> serde_json::Value {
    let p = &chunk.payload;
    let preview: String = p.text.chars().take(160).collect();
    serde_json::json!({
        "id": chunk.id.to_string(),
        "corpus": p.corpus.as_str(),
        "repo": p.repo,
        "path": p.path,
        "language": p.language,
        "lines": format!("{}-{}", p.start_line, p.end_line),
        "chars": p.text.len(),
        "preview": preview,
    })
}
