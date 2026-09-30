//! Corpus discovery: walk the code repos and the wiki, applying ignore rules,
//! and yield the source files worth chunking.
//!
//! Each top-level directory under the code root is a `repo`; the wiki root is a
//! single `wiki` repo. `.gitignore` is honoured (via the `ignore` crate), plus a
//! hard skip-list for build/vendor dirs that plain (non-git) repos won't gitignore.
//!
//! A repo can also exclude paths from the index **without** excluding them from
//! git: a `.ragignore` file (gitignore syntax, at the root or in any directory)
//! is honoured like a `.gitignore` — the place for generated data, recorded
//! fixtures and anything else that is committed but not worth retrieving.
//!
//! Independently of any ignore file, a **density guard** skips a file whose
//! estimated characters per token are pathologically low ([`estimate_tokens`]):
//! generated SVG path data tokenises at ~1.3 chars/token against ~4 for code, so it
//! costs three times as much to embed and is useless to search.

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
    /// Estimated characters per token below `ingest.min_chars_per_token` —
    /// generated/encoded data (see [`estimate_tokens`]).
    Dense,
}

/// Name of the per-directory ignore file that excludes paths from the index only.
pub const RAGIGNORE: &str = ".ragignore";

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
        .add_custom_ignore_filename(RAGIGNORE)
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
        let rel_path = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .into_owned();
        match classify_skip(path, &Limits::from(cfg)) {
            Some((SkipReason::Dense, ratio)) => {
                tracing::info!(
                    repo,
                    rel_path,
                    chars_per_token = format!("{ratio:.2}"),
                    min = cfg.ingest.min_chars_per_token,
                    "skipping token-dense file (generated data?); add it to a .ragignore to silence this"
                );
                skips.add(SkipReason::Dense);
            }
            Some((reason, _)) => skips.add(reason),
            None => {
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

/// The discovery thresholds, lifted out of the config so the classifier is
/// testable on its own.
struct Limits {
    max_bytes: u64,
    min_chars_per_token: f64,
    density_min_bytes: u64,
}

impl From<&Config> for Limits {
    fn from(cfg: &Config) -> Self {
        Limits {
            max_bytes: cfg.ingest.max_file_bytes,
            min_chars_per_token: cfg.ingest.min_chars_per_token,
            density_min_bytes: cfg.ingest.density_min_bytes,
        }
    }
}

/// Returns `Some((reason, chars_per_token))` if the file should be skipped (the
/// ratio is meaningful only for [`SkipReason::Dense`]), `None` if it's ingestable.
fn classify_skip(path: &Path, limits: &Limits) -> Option<(SkipReason, f64)> {
    let skip = |r| Some((r, 0.0));
    let name = path.file_name()?.to_string_lossy();
    if LOCKFILES.contains(&name.as_ref()) || name.ends_with(".lock") {
        return skip(SkipReason::Lockfile);
    }
    if name.ends_with(".min.js") || name.ends_with(".min.css") {
        return skip(SkipReason::Minified);
    }
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() == 0 {
        return skip(SkipReason::Empty);
    }
    if meta.len() > limits.max_bytes {
        return skip(SkipReason::TooLarge);
    }
    // Binary sniff: NUL byte in the first 8 KiB.
    let bytes = std::fs::read(path).ok();
    match bytes {
        None => skip(SkipReason::Unreadable),
        Some(b) => {
            let head = &b[..b.len().min(8192)];
            let Ok(text) = std::str::from_utf8(&b) else {
                return skip(SkipReason::Binary);
            };
            if head.contains(&0) {
                return skip(SkipReason::Binary);
            }
            // Longest run of bytes between newlines.
            let longest = b.split(|&c| c == b'\n').map(<[u8]>::len).max().unwrap_or(0);
            if longest > MAX_LINE_BYTES {
                return skip(SkipReason::Generated);
            }
            if limits.min_chars_per_token > 0.0 && meta.len() >= limits.density_min_bytes {
                let ratio = chars_per_token(text);
                if ratio < limits.min_chars_per_token {
                    return Some((SkipReason::Dense, ratio));
                }
            }
            None
        }
    }
}

/// Estimated characters per token for `text` (`f64::INFINITY` for text with no
/// estimated tokens, e.g. only spaces).
pub fn chars_per_token(text: &str) -> f64 {
    let tokens = estimate_tokens(text);
    if tokens == 0 {
        return f64::INFINITY;
    }
    text.chars().count() as f64 / tokens as f64
}

/// A cheap, tokenizer-free **estimate** of how many tokens `text` costs. It is a
/// density signal, not a bill: it only has to rank generated data below source.
///
/// Rules, modelled on how BPE tokenizers treat each character class: a run of
/// ASCII letters costs one token per five letters (at least one); a run of digits
/// one per three; a run of whitespace one if it contains a newline and nothing
/// otherwise (a space merges into the next word); every other character — ASCII
/// punctuation or anything non-ASCII — one each. On real repositories this puts
/// generated icon path data at 1.3–1.6 and hand-written source, prose and JSON at
/// 1.8 and above, which is what the default `min_chars_per_token` of 1.7 sits
/// between.
pub fn estimate_tokens(text: &str) -> usize {
    #[derive(PartialEq, Clone, Copy)]
    enum Class {
        Alpha,
        Digit,
        Space,
        Other,
    }
    fn class(c: char) -> Class {
        if c.is_ascii_alphabetic() {
            Class::Alpha
        } else if c.is_ascii_digit() {
            Class::Digit
        } else if c.is_whitespace() {
            Class::Space
        } else {
            Class::Other
        }
    }

    let mut tokens = 0usize;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match class(c) {
            Class::Other => tokens += 1,
            k => {
                let mut len = 1usize;
                let mut newline = c == '\n';
                while let Some(&n) = chars.peek() {
                    if class(n) != k {
                        break;
                    }
                    newline |= n == '\n';
                    len += 1;
                    chars.next();
                }
                tokens += match k {
                    Class::Alpha => len.div_ceil(5),
                    Class::Digit => len.div_ceil(3),
                    _ => usize::from(newline),
                };
            }
        }
    }
    tokens
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
    dense: u64,
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
            SkipReason::Dense => self.dense += 1,
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
            (SkipReason::Dense, self.dense),
        ]
        .into_iter()
        .filter(|(_, n)| *n > 0)
        .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch repo under the system temp dir, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "rag-discovery-{name}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }

        fn write(&self, rel: &str, body: &str) {
            let p = self.0.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }

        fn walk(&self, cfg: &Config) -> (Vec<String>, Vec<(SkipReason, u64)>) {
            let mut out = Vec::new();
            let mut skips = SkipTally::default();
            walk_repo(cfg, Corpus::Code, "r", &self.0, &mut out, &mut skips);
            let mut rels: Vec<String> = out.into_iter().map(|f| f.rel_path).collect();
            rels.sort();
            (rels, skips.into_vec())
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Generated icon path data, shaped like argus-v2's `MdiData*.kt`.
    fn icon_data(bytes: usize) -> String {
        let line =
            "    \"M12,2C6.48,2 2,6.48 2,12s4.48,10 10,10 10,-4.48 10,-10S17.52,2 12,2z\",\n";
        line.repeat(bytes / line.len() + 1)
    }

    /// Ordinary source code.
    fn source(bytes: usize) -> String {
        let block = "fn render(panel: &Panel, entities: &[Entity]) -> Result<Frame> {\n    \
                     let mut frame = Frame::new(panel.width, panel.height);\n    \
                     for entity in entities.iter().filter(|e| e.visible) {\n        \
                     frame.draw(entity.card())?;\n    }\n    Ok(frame)\n}\n\n";
        block.repeat(bytes / block.len() + 1)
    }

    #[test]
    fn estimator_ranks_generated_path_data_below_source_and_prose() {
        let icons = chars_per_token(&icon_data(20_000));
        let code = chars_per_token(&source(20_000));
        let prose = chars_per_token(
            &"The indexer embeds each changed file once and keeps its progress.\n".repeat(300),
        );
        assert!(icons < 1.7, "icon data estimated at {icons:.2}");
        assert!(code > 1.7, "source estimated at {code:.2}");
        assert!(prose > 3.0, "prose estimated at {prose:.2}");
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(chars_per_token("   "), f64::INFINITY);
        // Runs: "abcdefghij" = 2, "1234" = 2, "," = 1, "\n" = 1.
        assert_eq!(estimate_tokens("abcdefghij 1234,\n"), 6);
    }

    #[test]
    fn density_guard_skips_generated_data_and_keeps_source() {
        let repo = Scratch::new("dense");
        repo.write("mobile/icons/generated/MdiData0.kt", &icon_data(20_000));
        repo.write("src/render.rs", &source(20_000));
        // Small files are exempt however dense: they cost little.
        repo.write("src/tiny_icon.kt", &icon_data(500));
        let (files, skips) = repo.walk(&Config::default());
        assert_eq!(files, vec!["src/render.rs", "src/tiny_icon.kt"]);
        assert_eq!(skips, vec![(SkipReason::Dense, 1)]);
    }

    #[test]
    fn density_guard_can_be_disabled() {
        let repo = Scratch::new("dense-off");
        repo.write("gen/MdiData0.kt", &icon_data(20_000));
        let mut cfg = Config::default();
        cfg.ingest.min_chars_per_token = 0.0;
        let (files, skips) = repo.walk(&cfg);
        assert_eq!(files, vec!["gen/MdiData0.kt"]);
        assert!(skips.is_empty());
    }

    #[test]
    fn ragignore_excludes_paths_from_the_index_only() {
        let repo = Scratch::new("ragignore");
        repo.write(RAGIGNORE, "**/icons/generated/\ntests/recorded/*.json\n");
        repo.write("mobile/shared/icons/generated/Small.kt", "val a = 1\n");
        repo.write("tests/recorded/fixture.json", "{\"a\": 1}\n");
        repo.write("tests/recorded/README.md", "# recorded\n");
        repo.write("src/lib.rs", "pub fn f() {}\n");
        let (files, _) = repo.walk(&Config::default());
        assert_eq!(files, vec!["src/lib.rs", "tests/recorded/README.md"]);
    }

    #[test]
    fn without_a_ragignore_nothing_is_excluded() {
        let repo = Scratch::new("no-ragignore");
        repo.write("mobile/shared/icons/generated/Small.kt", "val a = 1\n");
        repo.write("src/lib.rs", "pub fn f() {}\n");
        let (files, _) = repo.walk(&Config::default());
        assert_eq!(
            files,
            vec!["mobile/shared/icons/generated/Small.kt", "src/lib.rs"]
        );
    }
}
