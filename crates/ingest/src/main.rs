//! `rag-ingest` — corpus walk, chunk, embed, and index.
//!
//! Subcommands: `init` (Phase 02), `scan` (Phase 03), `run` + `query` (Phase 04),
//! `reconcile-ledger` and `reconcile-tracker` (the SQLite-backed corpora).

mod breaker;
mod chunker;
mod discovery;
mod github;
mod language;
mod ledger_reconcile;
mod pipeline;
mod query;
mod run;
mod scan;
mod source;
mod tracker_reconcile;

use clap::{Parser, Subcommand, ValueEnum};
use rag_core::config::Config;
use rag_core::model::Corpus;
use rag_core::qdrant::VectorStore;
use source::Source;

#[derive(Parser)]
#[command(name = "rag-ingest", about = "RAG corpus ingestion", version)]
struct Cli {
    /// Path to the TOML config file (defaults + env still apply if absent).
    #[arg(long, default_value = "rag.toml")]
    config: String,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Create the Qdrant collection if it doesn't exist (idempotent).
    Init,
    /// Walk + chunk the corpus and report what would be ingested (read-only).
    Scan {
        /// Restrict to a single corpus.
        #[arg(long, value_enum)]
        corpus: Option<CorpusArg>,
        /// Restrict to a single repo (top-level dir name, or `wiki`).
        #[arg(long)]
        repo: Option<String>,
        /// Print up to N sample chunks as JSON.
        #[arg(long, default_value_t = 0)]
        sample: usize,
        /// Corpus source: local filesystem or GitHub clones.
        #[arg(long, value_enum, default_value_t = Source::Local)]
        source: Source,
    },
    /// Embed + index the corpus into Qdrant (incremental by default).
    Run {
        #[arg(long, value_enum)]
        corpus: Option<CorpusArg>,
        #[arg(long)]
        repo: Option<String>,
        /// Re-embed everything in scope, ignoring unchanged-hash checks.
        #[arg(long)]
        full: bool,
        /// Corpus source: local filesystem or GitHub clones.
        #[arg(long, value_enum, default_value_t = Source::Local)]
        source: Source,
        /// Attempt the work even if the circuit breaker has stopped it after
        /// repeated identical failures (each attempt may be billed).
        #[arg(long)]
        force: bool,
    },
    /// Embed a query and run a raw vector search (debug; no rerank).
    Query {
        /// The query text.
        text: String,
        /// Number of results.
        #[arg(long, default_value_t = 10)]
        limit: u64,
    },
    /// Reconcile the Qdrant ledger index against the SQLite ledger (incremental).
    ReconcileLedger,
    /// Reconcile the Qdrant tracker index (`corpus = tracker`: documents and queue
    /// items) against the tracker's SQLite store (incremental).
    ReconcileTracker,
}

#[derive(Copy, Clone, ValueEnum)]
enum CorpusArg {
    Code,
    Wiki,
}

impl From<CorpusArg> for Corpus {
    fn from(a: CorpusArg) -> Self {
        match a {
            CorpusArg::Code => Corpus::Code,
            CorpusArg::Wiki => Corpus::Wiki,
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    rag_core::telemetry::init();
    let cli = Cli::parse();
    let cfg = Config::load_from(&cli.config)?;

    match cli.command {
        Some(Command::Init) => init(&cfg).await,
        Some(Command::Scan {
            corpus,
            repo,
            sample,
            source,
        }) => {
            scan::run(
                &cfg,
                &scan::ScanOptions {
                    corpus: corpus.map(Into::into),
                    repo,
                    sample,
                    source,
                },
            )
            .await
        }
        Some(Command::Run {
            corpus,
            repo,
            full,
            source,
            force,
        }) => {
            run::run(
                &cfg,
                &run::RunOptions {
                    corpus: corpus.map(Into::into),
                    repo,
                    full,
                    source,
                    force,
                },
            )
            .await
        }
        Some(Command::Query { text, limit }) => query::query(&cfg, &text, limit).await,
        Some(Command::ReconcileLedger) => ledger_reconcile::run(&cfg).await,
        Some(Command::ReconcileTracker) => tracker_reconcile::run(&cfg).await,
        None => {
            tracing::info!(
                code_root = %cfg.corpus.code_root.display(),
                wiki_root = %cfg.corpus.wiki_root.display(),
                qdrant = %cfg.qdrant.url,
                collection = %cfg.qdrant.collection,
                "rag-ingest ready (try `init` or `scan`)"
            );
            Ok(())
        }
    }
}

async fn init(cfg: &Config) -> anyhow::Result<()> {
    let store = VectorStore::from_env(&cfg.qdrant)?;
    store.health().await?;
    tracing::info!(qdrant = %cfg.qdrant.url, "connected to Qdrant");

    let created = store
        .bootstrap_collection(cfg.voyage.dimensions as u64)
        .await?;
    if created {
        tracing::info!(
            collection = %cfg.qdrant.collection,
            dim = cfg.voyage.dimensions,
            "collection created — cosine, int8 quantization, keyword payload indexes"
        );
    } else {
        // Existing collection: ensure any newly-added keyword indexes exist
        // (e.g. the ledger `type`/`status`/`topic_id` fields). Idempotent.
        store.ensure_field_indexes().await?;
        tracing::info!(
            collection = %cfg.qdrant.collection,
            "collection already exists — ensured payload indexes are present"
        );
    }

    let points = store.points_count().await?;
    tracing::info!(collection = %cfg.qdrant.collection, points, "collection ready");
    Ok(())
}
