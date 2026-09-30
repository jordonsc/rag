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
    /// Skip a file whose *estimated* characters per token fall below this — the
    /// signature of generated data (SVG path strings, base64, number tables),
    /// which is useless to retrieve and costs three times as much to embed as
    /// prose. `0` disables the guard. See `discovery::estimate_tokens`.
    #[serde(default = "default_min_chars_per_token")]
    pub min_chars_per_token: f64,
    /// The density guard ignores files smaller than this many bytes: a small file
    /// costs little whatever its density.
    #[serde(default = "default_density_min_bytes")]
    pub density_min_bytes: u64,
    /// Consecutive identical failed runs (same pending work, same error) after
    /// which the indexer stops attempting that work until its inputs change.
    /// `0` disables the breaker.
    #[serde(default = "default_breaker_threshold")]
    pub breaker_threshold: u32,
    /// Where the breaker's state is kept between runs. Empty (the default) means
    /// `<github.work_dir>/.rag-ingest-breaker.json`, which is on the volume the
    /// sync container mounts, so it survives the container.
    #[serde(default)]
    pub breaker_path: String,
}

fn default_min_chars_per_token() -> f64 {
    1.7
}

fn default_density_min_bytes() -> u64 {
    4096
}

fn default_breaker_threshold() -> u32 {
    3
}

impl Config {
    /// The resolved breaker state file (see [`IngestConfig::breaker_path`]).
    pub fn breaker_path(&self) -> PathBuf {
        if self.ingest.breaker_path.trim().is_empty() {
            self.github.work_dir.join(".rag-ingest-breaker.json")
        } else {
            PathBuf::from(&self.ingest.breaker_path)
        }
    }
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
    /// Directory holding the built ledger web UI (a `dist/` with `index.html` at
    /// its root). Empty disables static serving entirely — the default, and what
    /// keeps a JSON-only deployment behaving exactly as it always has.
    #[serde(default)]
    pub web_root: String,
    /// Directory of saved Summarise system prompts — one Markdown file per
    /// prompt, which an operator can also manage with a text editor. Empty (the
    /// default) means no library: the UI then offers only the built-in default
    /// prompt, and the save/delete endpoints answer 503. A configured directory
    /// that does not exist is an empty library, created on the first save.
    ///
    /// **`~/rag/prompts`, not `~/.config/rag/prompts`.** `rag-serve` runs in a
    /// container, so this has to be bind-mounted in, and `~/.config/rag/` is
    /// where the secrets env file lives — mounting that directory would put the
    /// secrets on the container filesystem for no gain. `~/rag/` is where the
    /// ledger DB, the corpus clones and the trigger files already live.
    #[serde(default)]
    pub prompts_dir: String,
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
                min_chars_per_token: default_min_chars_per_token(),
                density_min_bytes: default_density_min_bytes(),
                breaker_threshold: default_breaker_threshold(),
                breaker_path: String::new(),
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
                web_root: String::new(),
                prompts_dir: String::new(),
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
        // The optional paths are absent by default, and absence is a valid
        // configuration for every one of them rather than a broken one.
        assert_eq!(cfg.server.web_root, "");
        assert_eq!(cfg.server.prompts_dir, "");
        assert_eq!(cfg.server.reindex_trigger, "");
        // The cost guards are on by default.
        assert_eq!(cfg.ingest.breaker_threshold, 3);
        assert!(cfg.ingest.min_chars_per_token > 1.0);
        assert!(cfg
            .breaker_path()
            .ends_with("rag/corpus/.rag-ingest-breaker.json"));
    }

    #[test]
    fn a_toml_without_the_new_ingest_keys_still_loads() {
        // Existing rag.toml files predate the guards and must keep loading.
        let dir = std::env::temp_dir().join(format!("rag-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rag.toml");
        std::fs::write(
            &path,
            "[ingest]\nmax_file_bytes = 5\n[github]\nwork_dir = \"/w\"\n",
        )
        .unwrap();
        let cfg = Config::load_from(&path).expect("loads");
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(cfg.ingest.max_file_bytes, 5);
        assert_eq!(cfg.ingest.breaker_threshold, 3);
        assert_eq!(cfg.ingest.density_min_bytes, 4096);
        assert_eq!(
            cfg.breaker_path(),
            PathBuf::from("/w/.rag-ingest-breaker.json")
        );
    }
}
