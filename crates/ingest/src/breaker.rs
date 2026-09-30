//! Circuit breaker for paid work that keeps failing the same way.
//!
//! The sync timer re-runs the indexer every 15 minutes. A failure that the next run
//! will simply repeat — the same pending work refused with the same error — used to
//! be re-attempted, and re-paid for, for as long as nobody looked (29 times in one
//! night, ledger `rag-0032`). The breaker remembers, across runs, the *fingerprint*
//! of the work a failed run attempted and a digit-free *signature* of its error.
//! After `threshold` consecutive runs fail identically it opens, and the indexer
//! refuses to spend on that work again until its inputs change — a new commit, a
//! changed config — which yields a different fingerprint and closes it.
//!
//! State is a small JSON file (see `IngestConfig::breaker_path`). A missing or
//! unreadable file is a closed breaker: the breaker can only ever stop spending,
//! never be the reason a healthy run is refused.

use std::path::{Path, PathBuf};

use rag_core::hashing::hash_str;
use serde::{Deserialize, Serialize};

/// Longest error signature kept; the start of a message is what identifies it.
const SIGNATURE_CHARS: usize = 400;

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BreakerState {
    /// Fingerprint of the work the failing runs attempted.
    pub fingerprint: String,
    /// Signature of their error (digits collapsed — see [`signature`]).
    pub error: String,
    /// Consecutive runs that failed with this fingerprint and signature.
    pub consecutive: u32,
    /// Unix seconds of the last recorded failure.
    pub updated_unix: u64,
}

pub struct Breaker {
    path: PathBuf,
    threshold: u32,
    state: BreakerState,
}

impl Breaker {
    /// Load the breaker kept at `path`. `threshold == 0` disables it.
    pub fn load(path: impl Into<PathBuf>, threshold: u32) -> Self {
        let path = path.into();
        let state = match std::fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|e| {
                tracing::warn!(path = %path.display(), error = %e, "unreadable breaker state; treating the breaker as closed");
                BreakerState::default()
            }),
            Err(_) => BreakerState::default(),
        };
        Self {
            path,
            threshold,
            state,
        }
    }

    pub fn state(&self) -> &BreakerState {
        &self.state
    }

    pub fn threshold(&self) -> u32 {
        self.threshold
    }

    /// Whether the breaker refuses to attempt the work named by `fingerprint`.
    pub fn is_open(&self, fingerprint: &str) -> bool {
        self.threshold > 0
            && self.state.fingerprint == fingerprint
            && self.state.consecutive >= self.threshold
    }

    /// Record a failed attempt at `fingerprint`; returns the consecutive count.
    /// Only a repeat of the *same* work failing the *same* way extends the count.
    pub fn record_failure(&mut self, fingerprint: &str, error: &str) -> u32 {
        let sig = signature(error);
        if self.state.fingerprint == fingerprint && self.state.error == sig {
            self.state.consecutive = self.state.consecutive.saturating_add(1);
        } else {
            self.state = BreakerState {
                fingerprint: fingerprint.to_string(),
                error: sig,
                consecutive: 1,
                updated_unix: 0,
            };
        }
        self.state.updated_unix = now_unix();
        self.save();
        self.state.consecutive
    }

    /// Record a successful run: the breaker closes and forgets.
    pub fn record_success(&mut self) {
        if self.state != BreakerState::default() || self.path.exists() {
            self.state = BreakerState::default();
            if let Err(e) = std::fs::remove_file(&self.path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(path = %self.path.display(), error = %e, "could not clear breaker state");
                }
            }
        }
    }

    fn save(&self) {
        let write = || -> std::io::Result<()> {
            if let Some(dir) = self.path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let tmp = tmp_path(&self.path);
            std::fs::write(&tmp, serde_json::to_vec_pretty(&self.state)?)?;
            std::fs::rename(&tmp, &self.path)
        };
        if let Err(e) = write() {
            // Not fatal — but without state the breaker cannot count, so say so.
            tracing::error!(path = %self.path.display(), error = %e, "could not save breaker state; repeated failures will not be stopped");
        }
    }
}

fn tmp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    path.with_file_name(name)
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// An error message with every run of digits collapsed to `#`, truncated. Two runs
/// that fail the same way rarely fail with the same numbers — Voyage's refusal
/// quotes the batch's token count, which varied between otherwise identical runs.
pub fn signature(error: &str) -> String {
    let mut out = String::with_capacity(error.len().min(SIGNATURE_CHARS));
    let mut in_digits = false;
    for c in error.chars() {
        if c.is_ascii_digit() {
            if !in_digits {
                out.push('#');
            }
            in_digits = true;
        } else {
            out.push(c);
            in_digits = false;
        }
        if out.chars().count() >= SIGNATURE_CHARS {
            break;
        }
    }
    out
}

/// A stable fingerprint of a list of work items (order-insensitive).
pub fn fingerprint<I, S>(items: I) -> String
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut items: Vec<String> = items.into_iter().map(|s| s.as_ref().to_string()).collect();
    items.sort();
    hash_str(&items.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rag-breaker-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("state.json")
    }

    const REFUSAL: &str = "voyage API error: 400 Bad Request: The max allowed tokens per submitted batch is 120000. Your batch has 240495 tokens";

    #[test]
    fn opens_after_threshold_identical_failures_and_persists_across_runs() {
        let path = scratch("open");
        for run in 1..=3u32 {
            // A fresh load each time: the count must survive the process.
            let mut b = Breaker::load(&path, 3);
            assert!(!b.is_open("fp"), "run {run} must still be attempted");
            // The token count differs run to run; the failure is still identical.
            let n = b.record_failure("fp", &REFUSAL.replace("240495", &format!("24{run}538")));
            assert_eq!(n, run);
        }
        let b = Breaker::load(&path, 3);
        assert!(b.is_open("fp"));
        // Changed inputs are new work: attempted.
        assert!(!b.is_open("fp-after-a-new-commit"));
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn a_different_error_or_different_work_restarts_the_count() {
        let path = scratch("restart");
        let mut b = Breaker::load(&path, 3);
        b.record_failure("fp", REFUSAL);
        b.record_failure("fp", REFUSAL);
        assert_eq!(
            b.record_failure("fp", "qdrant error: connection refused"),
            1
        );
        assert_eq!(
            b.record_failure("other", "qdrant error: connection refused"),
            1
        );
        assert!(!b.is_open("other"));
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn success_closes_and_forgets() {
        let path = scratch("success");
        let mut b = Breaker::load(&path, 1);
        b.record_failure("fp", REFUSAL);
        assert!(Breaker::load(&path, 1).is_open("fp"));
        b.record_success();
        assert!(!path.exists());
        assert!(!Breaker::load(&path, 1).is_open("fp"));
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn threshold_zero_never_opens() {
        let path = scratch("disabled");
        let mut b = Breaker::load(&path, 0);
        for _ in 0..5 {
            b.record_failure("fp", REFUSAL);
        }
        assert!(!b.is_open("fp"));
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn corrupt_state_is_a_closed_breaker() {
        let path = scratch("corrupt");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{not json").unwrap();
        let b = Breaker::load(&path, 1);
        assert_eq!(b.state(), &BreakerState::default());
        assert!(!b.is_open(""));
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn signature_collapses_numbers_and_fingerprint_ignores_order() {
        assert_eq!(
            signature("batch has 240495 tokens, max 120000"),
            "batch has # tokens, max #"
        );
        assert_eq!(signature(&"x".repeat(5000)).len(), SIGNATURE_CHARS);
        assert_eq!(fingerprint(["b", "a"]), fingerprint(["a", "b"]));
        assert_ne!(fingerprint(["a"]), fingerprint(["a", "b"]));
    }
}
