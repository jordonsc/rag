//! Layered configuration: built-in defaults → `rag.toml` → `RAG_`-prefixed env.
//!
//! Secrets are deliberately absent from this struct. API keys come from the
//! environment and are read only when a client is constructed (see `voyage` /
//! `qdrant` modules), so a missing key fails loudly at the point of use rather
//! than silently here.

use std::path::PathBuf;

use figment::{
    providers::{Env, Format, Serialized, Toml},
    Figment,
};
use serde::{Deserialize, Serialize};

/// Home directory from `$HOME`, falling back to the current dir.
fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub corpus: CorpusConfig,
    pub qdrant: QdrantConfig,
    pub voyage: VoyageConfig,
    pub chunk: ChunkConfig,
    pub ingest: IngestConfig,
    pub github: GithubConfig,
    pub server: ServerConfig,
    pub ledger: LedgerConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorpusConfig {
    pub code_root: PathBuf,
    pub wiki_root: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QdrantConfig {
    pub url: String,
    pub collection: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoyageConfig {
    pub embed_model: String,
    pub rerank_model: String,
    pub dimensions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkConfig {
    pub max_tokens: u32,
    pub overlap_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestConfig {
    /// Files larger than this (bytes) are skipped during discovery.
    pub max_file_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GithubConfig {
    /// GitHub account whose repos form the corpus.
    pub account: String,
    /// Where shallow clones live.
    pub work_dir: PathBuf,
    /// Repo name treated as the `wiki` corpus (everything else is `code`).
    pub wiki_repo: String,
    /// Include forked repos (some forks are active first-party projects).
    pub include_forks: bool,
    /// Repo names to skip entirely.
    pub exclude: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub bind: String,
    /// ANN candidate set size fetched before reranking (the over-fetch).
    pub over_fetch: usize,
    /// Default number of results returned when a request omits `top_k`.
    pub default_top_k: usize,
    /// Path to a file `POST /reindex` writes to trigger an immediate re-index.
    /// Empty disables the endpoint (the default; in deployment a systemd `.path`
    /// unit watches this file and starts `rag-sync.service`).
    #[serde(default)]
    pub reindex_trigger: String,
    /// Path to a file the ledger write endpoints touch after a commit to trigger
    /// an immediate ledger reconcile. Empty disables it (the default; in deployment
    /// a `.path` unit watches this file and starts `rag-ledger-sync.service`).
    #[serde(default)]
    pub ledger_reindex_trigger: String,
    /// Score multiplier applied to `corpus = ledger` hits before the top-k cut.
    /// 1.0 = neutral (default); < 1.0 demotes ledger results relative to code/wiki.
    #[serde(default = "default_ledger_weight")]
    pub ledger_weight: f32,
}

fn default_ledger_weight() -> f32 {
    1.0
}

/// Configuration for the decision/incident ledger (SQLite source of truth).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LedgerConfig {
    /// SQLite database file. Created if missing (WAL mode). In a container
    /// deployment this is a bind-mounted host path; in dev it defaults under
    /// `$HOME/rag/ledger`.
    pub db_path: PathBuf,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            corpus: CorpusConfig {
                code_root: home_dir().join("repos"),
                wiki_root: home_dir().join("repos/wiki"),
            },
            qdrant: QdrantConfig {
                url: "http://localhost:6334".to_string(),
                collection: "rag_corpus".to_string(),
            },
            voyage: VoyageConfig {
                embed_model: "voyage-4-large".to_string(),
                rerank_model: "rerank-2.5".to_string(),
                dimensions: 1024,
            },
            chunk: ChunkConfig {
                max_tokens: 512,
                overlap_tokens: 64,
            },
            ingest: IngestConfig {
                max_file_bytes: 1_000_000,
            },
            github: GithubConfig {
                account: String::new(),
                work_dir: home_dir().join("rag/corpus"),
                wiki_repo: "wiki".to_string(),
                include_forks: true,
                exclude: Vec::new(),
            },
            server: ServerConfig {
                bind: "0.0.0.0:17793".to_string(),
                over_fetch: 50,
                default_top_k: 8,
                reindex_trigger: String::new(),
                ledger_reindex_trigger: String::new(),
                ledger_weight: default_ledger_weight(),
            },
            ledger: LedgerConfig {
                db_path: home_dir().join("rag/ledger/ledger.db"),
            },
        }
    }
}

impl Config {
    /// Load config from defaults, then `rag.toml` (if present), then `RAG_`-prefixed
    /// env vars (nested via `__`, e.g. `RAG_QDRANT__URL`).
    pub fn load() -> crate::Result<Self> {
        Self::load_from("rag.toml")
    }

    /// As [`Config::load`] but reading the TOML layer from an explicit path. A
    /// missing file is not an error — defaults + env still apply.
    pub fn load_from(path: impl AsRef<std::path::Path>) -> crate::Result<Self> {
        let cfg = Figment::from(Serialized::defaults(Config::default()))
            .merge(Toml::file(path.as_ref()))
            .merge(Env::prefixed("RAG_").split("__"))
            .extract()?;
        Ok(cfg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_extract() {
        // No file, no env: defaults must produce a valid config.
        let cfg = Config::load_from("/nonexistent/rag.toml").expect("defaults load");
        assert_eq!(cfg.voyage.embed_model, "voyage-4-large");
        assert_eq!(cfg.voyage.dimensions, 1024);
        assert_eq!(cfg.qdrant.collection, "rag_corpus");
    }
}
