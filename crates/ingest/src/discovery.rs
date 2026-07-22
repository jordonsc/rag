//! Corpus discovery: walk the code repos and the wiki, applying ignore rules,
//! and yield the source files worth chunking.
//!
//! Each top-level directory under the code root is a `repo`; the wiki root is a
//! single `wiki` repo. `.gitignore` is honoured (via the `ignore` crate), plus a
//! hard skip-list for build/vendor dirs that plain (non-git) repos won't gitignore.

use std::path::{Path, PathBuf};

use ignore::WalkBuilder;
use rag_core::config::Config;
use rag_core::model::Corpus;

/// A file selected for ingestion.
pub struct DiscoveredFile {
    pub corpus: Corpus,
    pub repo: String,
    pub path: PathBuf,
    pub rel_path: String,
}

/// Why a candidate file was skipped (for reporting).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    TooLarge,
    Lockfile,
    Minified,
    Binary,
    /// A line longer than `MAX_LINE_BYTES` — minified/generated/data blob that
    /// chokes the AST and recursive splitters. Skipped to keep ingest bounded.
    Generated,
    Empty,
    Unreadable,
}

/// Files with any line longer than this are treated as generated/minified.
const MAX_LINE_BYTES: usize = 50_000;

/// Directory names pruned during the walk regardless of `.gitignore`.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "target",
    "node_modules",
    ".venv",
    "venv",
    "dist",
    "build",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".next",
    ".turbo",
    ".cache",
    "vendor",
];

const LOCKFILES: &[&str] = &[
    "Cargo.lock",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "poetry.lock",
    "Gemfile.lock",
    "composer.lock",
    "uv.lock",
];

/// One repository root to walk: its name, corpus, and on-disk path.
pub struct RepoRoot {
    pub name: String,
    pub corpus: Corpus,
    pub root: PathBuf,
}

/// Discover files across the **local** corpus (the configured code root + wiki).
/// Each top-level dir under the code root is a repo; the wiki root is the `wiki` repo.
pub fn discover(
    cfg: &Config,
    only_corpus: Option<Corpus>,
    only_repo: Option<&str>,
) -> (Vec<DiscoveredFile>, Vec<(SkipReason, u64)>) {
    let wiki_root = cfg.corpus.wiki_root.as_path();
    let mut roots = Vec::new();

    if let Ok(entries) = std::fs::read_dir(&cfg.corpus.code_root) {
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .filter(|p| p != wiki_root)
            .collect();
        dirs.sort();
        for dir in dirs {
            let name = dir
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            roots.push(RepoRoot {
                name,
                corpus: Corpus::Code,
                root: dir,
            });
        }
    }
    if wiki_root.is_dir() {
        roots.push(RepoRoot {
            name: "wiki".to_string(),
            corpus: Corpus::Wiki,
            root: wiki_root.to_path_buf(),
        });
    }

    discover_roots(cfg, &roots, only_corpus, only_repo)
}

/// Discover files across an explicit set of repo roots (used by the GitHub
/// source, which clones repos into a work dir). Honours the corpus/repo filters.
pub fn discover_roots(
    cfg: &Config,
    roots: &[RepoRoot],
    only_corpus: Option<Corpus>,
    only_repo: Option<&str>,
) -> (Vec<DiscoveredFile>, Vec<(SkipReason, u64)>) {
    let mut files = Vec::new();
    let mut skips = SkipTally::default();
    for r in roots {
        if only_corpus.is_some_and(|c| c != r.corpus) {
            continue;
        }
        if only_repo.is_some_and(|want| want != r.name) {
            continue;
        }
        walk_repo(cfg, r.corpus, &r.name, &r.root, &mut files, &mut skips);
    }
    (files, skips.into_vec())
}

fn walk_repo(
    cfg: &Config,
    corpus: Corpus,
    repo: &str,
    root: &Path,
    out: &mut Vec<DiscoveredFile>,
    skips: &mut SkipTally,
) {
    let walker = WalkBuilder::new(root)
        .hidden(true) // skip dotfiles/dotdirs
        .git_ignore(true)
        .git_global(false)
        .parents(false)
        .filter_entry(|entry| {
            // Prune skip-listed directories by name.
            let name = entry.file_name().to_string_lossy();
            !(entry.file_type().is_some_and(|t| t.is_dir()) && SKIP_DIRS.contains(&name.as_ref()))
        })
        .build();

    for entry in walker.flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let path = entry.path();
        match classify_skip(path, cfg.ingest.max_file_bytes) {
            Some(reason) => skips.add(reason),
            None => {
                let rel_path = path
                    .strip_prefix(root)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .into_owned();
                out.push(DiscoveredFile {
                    corpus,
                    repo: repo.to_string(),
                    path: path.to_path_buf(),
                    rel_path,
                });
            }
        }
    }
}

/// Returns `Some(reason)` if the file should be skipped, `None` if it's ingestable.
fn classify_skip(path: &Path, max_bytes: u64) -> Option<SkipReason> {
    let name = path.file_name()?.to_string_lossy();
    if LOCKFILES.contains(&name.as_ref()) || name.ends_with(".lock") {
        return Some(SkipReason::Lockfile);
    }
    if name.ends_with(".min.js") || name.ends_with(".min.css") {
        return Some(SkipReason::Minified);
    }
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() == 0 {
        return Some(SkipReason::Empty);
    }
    if meta.len() > max_bytes {
        return Some(SkipReason::TooLarge);
    }
    // Binary sniff: NUL byte in the first 8 KiB.
    let bytes = std::fs::read(path).ok();
    match bytes {
        None => Some(SkipReason::Unreadable),
        Some(b) => {
            let head = &b[..b.len().min(8192)];
            if head.contains(&0) || std::str::from_utf8(&b).is_err() {
                return Some(SkipReason::Binary);
            }
            // Longest run of bytes between newlines.
            let longest = b.split(|&c| c == b'\n').map(<[u8]>::len).max().unwrap_or(0);
            if longest > MAX_LINE_BYTES {
                return Some(SkipReason::Generated);
            }
            None
        }
    }
}

#[derive(Default)]
struct SkipTally {
    too_large: u64,
    lockfile: u64,
    minified: u64,
    binary: u64,
    generated: u64,
    empty: u64,
    unreadable: u64,
}

impl SkipTally {
    fn add(&mut self, r: SkipReason) {
        match r {
            SkipReason::TooLarge => self.too_large += 1,
            SkipReason::Lockfile => self.lockfile += 1,
            SkipReason::Minified => self.minified += 1,
            SkipReason::Binary => self.binary += 1,
            SkipReason::Generated => self.generated += 1,
            SkipReason::Empty => self.empty += 1,
            SkipReason::Unreadable => self.unreadable += 1,
        }
    }

    fn into_vec(self) -> Vec<(SkipReason, u64)> {
        [
            (SkipReason::TooLarge, self.too_large),
            (SkipReason::Lockfile, self.lockfile),
            (SkipReason::Minified, self.minified),
            (SkipReason::Binary, self.binary),
            (SkipReason::Generated, self.generated),
            (SkipReason::Empty, self.empty),
            (SkipReason::Unreadable, self.unreadable),
        ]
        .into_iter()
        .filter(|(_, n)| *n > 0)
        .collect()
    }
}
