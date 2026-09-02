//! The saved system-prompt library: plain Markdown files in one directory.
//!
//! The Summarise drawer sends an instruction with every run, and one
//! instruction is not enough — *summarise this* and *list only what changed*
//! are different questions of the same entry. So the operator can keep a small
//! library of them and pick one before pressing Go.
//!
//! **A prompt is a file.** `~/rag/prompts/Terse.md` is the prompt named
//! "Terse", and there is no index, no database and no metadata: the file *is*
//! the record, so an operator with a text editor and no browser can add,
//! rename or delete one, and the UI shows the result on its next read. That is
//! the whole storage design and it is the reason for the strict name rules
//! below — a name has to survive a round trip through a filename.
//!
//! # Why `~/rag/prompts` and not `~/.config/rag/prompts`
//!
//! The obvious home for operator configuration is `~/.config/rag/`, and that
//! was the first suggestion. It is **deliberately not used**, for one reason:
//! `rag-serve` runs in a container, so a prompts directory has to be
//! bind-mounted into it — and `~/.config/rag/` is where the *secrets* env file
//! lives (`VOYAGE_API_KEY`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`). Mounting that
//! directory would put the secrets file on the container filesystem to gain
//! nothing. `~/rag/` is where every other bind mount already lives (the ledger
//! DB, the corpus clones, the trigger files), so the prompts join them there.
//! Please do not "correct" this back.
//!
//! # The built-in default is not a file, and never becomes one
//!
//! [`rag_core::anthropic::DEFAULT_SYSTEM_PROMPT`] is a Rust constant served to
//! the UI through `/info`. Nothing here writes it to disk on first run: an
//! empty directory means the library is empty and the built-in is the only
//! thing on offer, which is a *fallback*, not a seed. A default that had been
//! copied to a file would be a second copy free to drift from the constant, and
//! would be deletable — which the built-in is not.
//!
//! # Security posture
//!
//! **This is a write-to-disk endpoint on a service with no authentication.**
//! Anything on the network can call it. Three things bound that:
//!
//! * A name is checked against a restricted allow-list ([`validate_name`]) and
//!   is then the *whole* filename, minus a fixed `.md`. It cannot hold a path
//!   separator, a dot, or a percent sign, so it cannot name anything but a file
//!   in this one directory — and [`PromptLibrary::path_for`] re-checks that the
//!   resolved path's parent really is that directory before any write.
//! * The body is capped ([`MAX_BODY_BYTES`]) and the library's size is capped
//!   ([`MAX_PROMPTS`]), so the endpoint is not a way to fill the disk.
//! * Nothing follows a symlink out: a write refuses a path that already exists
//!   as a link, and the listing skips anything that is not a regular file.
//!
//! And the part that is not about the filesystem at all: **a saved prompt is
//! operator-authored, but it arrives over an unauthenticated endpoint**, so in
//! truth it is authored by whoever is on the network. It is sent as the
//! `system` field of a billed API call. That is precisely why the ledger
//! *entry* content is never concatenated into the system prompt and travels as
//! a user message instead (see `core::anthropic`): the system field is the
//! privileged half of the conversation, and only text that reached the server
//! through this deliberate, validated, operator-facing route is allowed to sit
//! in it.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// The longest a prompt name may be, in characters.
///
/// A name is a label in a dropdown, not prose. Sixty-four is generous for that
/// and leaves the filename far short of any filesystem limit.
pub const MAX_NAME_CHARS: usize = 64;

/// The largest a prompt body may be, in bytes.
///
/// A system prompt is a few paragraphs; the built-in default is under 700
/// bytes. 32 KiB is two orders of magnitude of headroom and still small enough
/// that an unauthenticated caller cannot use this endpoint as storage.
pub const MAX_BODY_BYTES: usize = 32 * 1024;

/// How many prompts the library will hold.
///
/// Not asked for, and here for the same reason as the body cap: without it, an
/// unwelcome caller can mint files until the disk is full. An *upsert* of a
/// name that already exists is always allowed — the cap refuses new names only,
/// so hitting it cannot lock the operator out of editing what they have.
pub const MAX_PROMPTS: usize = 200;

/// The one extension the library reads or writes. Not configurable: a prompt is
/// Markdown, and a directory this endpoint can write arbitrary extensions into
/// is a directory that can hold a `.sh`.
const EXTENSION: &str = "md";

/// One saved prompt: its name and its whole body.
///
/// The listing carries the bodies rather than just the names, so the chooser
/// needs one round trip and switching between prompts costs nothing. They are
/// small, and there are at most [`MAX_PROMPTS`] of them.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SavedPrompt {
    pub name: String,
    pub body: String,
}

/// Why a prompt operation did not happen.
///
/// Mapped to `ApiError` by the handlers rather than being an `ApiError` itself,
/// so this module stays testable without axum in the way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromptError {
    /// The name or the body is not acceptable — a 400. The message is written
    /// to be shown to a person, because it will be.
    Rejected(String),
    /// No prompt of that name — a 404.
    NotFound(String),
    /// The filesystem said no — a 500.
    Io(String),
}

impl std::fmt::Display for PromptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PromptError::Rejected(m) | PromptError::NotFound(m) | PromptError::Io(m) => {
                f.write_str(m)
            }
        }
    }
}

/// Check a prompt name and return it trimmed, or say why not.
///
/// The name becomes a filename, so this is the traversal guard and it is an
/// **allow-list**: letters, digits, spaces, `-` and `_`, and nothing else.
/// Everything the explicit rejections below look for is already impossible
/// because the character it needs is not in that set — `..` needs a dot, a
/// traversal needs a separator, a percent-encoded form needs a `%`. They are
/// kept anyway, and tested, so that widening the charset one day cannot quietly
/// re-open the hole; the same posture as the static file server's refusal in
/// `web.rs`, which declines a path rather than normalising it.
pub fn validate_name(raw: &str) -> Result<String, PromptError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(PromptError::Rejected(
            "a prompt needs a name (letters, digits, spaces, - and _)".into(),
        ));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(PromptError::Rejected(format!(
            "a prompt name may be at most {MAX_NAME_CHARS} characters"
        )));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ')
    {
        return Err(PromptError::Rejected(format!(
            "a prompt name may hold only letters, digits, spaces, - and _ (got {name:?})"
        )));
    }
    // Unreachable given the allow-list above, and deliberately so: this is the
    // assertion that the allow-list is doing its job, not a second-chance
    // filter. If a future edit lets a dot or a separator through, these fire.
    if name.starts_with('.')
        || name.contains("..")
        || name.contains('/')
        || name.contains('\\')
        || name.contains('%')
        || name.contains('\0')
    {
        return Err(PromptError::Rejected(format!(
            "a prompt name may not be a path (got {name:?})"
        )));
    }
    Ok(name.to_string())
}

/// A directory of saved prompts.
#[derive(Debug, Clone)]
pub struct PromptLibrary {
    dir: PathBuf,
}

impl PromptLibrary {
    /// A library rooted at `dir`. The directory is **not** required to exist:
    /// it is created on the first save, and until then the library is empty.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// From the configured path — `None` when it is blank, which is the default
    /// and means "no library on this server". Same shape as the reindex trigger
    /// and the web root: an unset optional path disables a feature and fails
    /// nothing.
    pub fn from_config(configured: &str) -> Option<Self> {
        let dir = configured.trim();
        (!dir.is_empty()).then(|| Self::new(dir))
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The file a name maps to, with the containment re-checked.
    ///
    /// [`validate_name`] has already made it impossible for the join to escape;
    /// this asserts the result anyway, because "the input could not have done
    /// that" is a claim about a function somebody may later edit, and the cost
    /// of checking is one comparison on a path we already hold.
    fn path_for(&self, name: &str) -> Result<(String, PathBuf), PromptError> {
        let name = validate_name(name)?;
        let file = format!("{name}.{EXTENSION}");
        let path = self.dir.join(&file);
        let inside = path.parent() == Some(self.dir.as_path());
        let named = path.file_name().and_then(|f| f.to_str()) == Some(file.as_str());
        let markdown = path.extension().and_then(|e| e.to_str()) == Some(EXTENSION);
        if !(inside && named && markdown) {
            return Err(PromptError::Rejected(format!(
                "a prompt name may not be a path (got {name:?})"
            )));
        }
        Ok((name, path))
    }

    /// Every saved prompt, ordered by name.
    ///
    /// A directory that does not exist is an **empty library**, not a failure —
    /// the same posture as every other optional path in this service. Nothing
    /// here is fatal: a file that cannot be read, is not valid UTF-8, is over
    /// the size cap or carries a name this endpoint could not write back is
    /// skipped with a warning rather than failing the listing. Offering a
    /// prompt that cannot be saved would be offering an edit that always 400s.
    pub async fn list(&self) -> Result<Vec<SavedPrompt>, PromptError> {
        let mut dir = match tokio::fs::read_dir(&self.dir).await {
            Ok(dir) => dir,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => {
                return Err(PromptError::Io(format!(
                    "could not read the prompts directory: {e}"
                )))
            }
        };

        let mut found = Vec::new();
        while let Some(entry) = dir
            .next_entry()
            .await
            .map_err(|e| PromptError::Io(format!("could not read the prompts directory: {e}")))?
        {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some(EXTENSION) {
                continue;
            }
            // `symlink_metadata` does not follow the link, so a symlink is not a
            // regular file here and is skipped — which is how a link pointing at
            // something outside the directory never gets read.
            match tokio::fs::symlink_metadata(&path).await {
                Ok(meta) if meta.is_file() => {
                    if meta.len() > MAX_BODY_BYTES as u64 {
                        tracing::warn!(path = %path.display(), "prompt file is over the size cap — skipped");
                        continue;
                    }
                }
                _ => continue,
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let Ok(name) = validate_name(stem) else {
                tracing::warn!(path = %path.display(), "prompt file name is not a valid prompt name — skipped");
                continue;
            };
            // The stem must be *exactly* the name, not merely something that
            // trims to it: "Terse .md" and "Terse.md" would otherwise be one
            // prompt in the chooser and two files on disk.
            if name != stem {
                tracing::warn!(path = %path.display(), "prompt file name has surrounding space — skipped");
                continue;
            }
            match tokio::fs::read_to_string(&path).await {
                Ok(body) => found.push(SavedPrompt { name, body }),
                Err(e) => {
                    tracing::warn!(path = %path.display(), error = %e, "prompt file could not be read — skipped");
                }
            }
        }

        // Case-insensitively, so a list a person reads is in the order a person
        // would put it in; the tie-break keeps it deterministic.
        found.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then_with(|| a.name.cmp(&b.name))
        });
        Ok(found)
    }

    /// Write a prompt, creating it or replacing it.
    ///
    /// An upsert rather than separate create/update verbs: the UI's Save is one
    /// button, and a "this already exists" error on it would be a dialog asking
    /// the operator to confirm what they just asked for.
    pub async fn save(&self, name: &str, body: &str) -> Result<SavedPrompt, PromptError> {
        let (name, path) = self.path_for(name)?;
        if body.trim().is_empty() {
            return Err(PromptError::Rejected(
                "a prompt needs a body — an empty instruction is not a prompt".into(),
            ));
        }
        if body.len() > MAX_BODY_BYTES {
            return Err(PromptError::Rejected(format!(
                "a prompt may be at most {MAX_BODY_BYTES} bytes (this one is {})",
                body.len()
            )));
        }

        // Refuse to write through a symlink. A regular file is replaced; a link
        // is not followed, because following one is how a write to
        // `~/rag/prompts/x.md` becomes a write to somewhere else entirely.
        if let Ok(meta) = tokio::fs::symlink_metadata(&path).await {
            if meta.file_type().is_symlink() {
                return Err(PromptError::Rejected(format!(
                    "{name:?} is a symlink on disk and will not be written through"
                )));
            }
            if !meta.is_file() {
                return Err(PromptError::Rejected(format!(
                    "{name:?} is not a regular file on disk"
                )));
            }
        } else {
            // A name that is not already on disk is a new file, and new files
            // are what the cap bounds.
            let held = self.list().await?.len();
            if held >= MAX_PROMPTS {
                return Err(PromptError::Rejected(format!(
                    "this server holds the maximum of {MAX_PROMPTS} saved prompts; delete one first"
                )));
            }
        }

        tokio::fs::create_dir_all(&self.dir)
            .await
            .map_err(|e| PromptError::Io(format!("could not create the prompts directory: {e}")))?;
        tokio::fs::write(&path, body)
            .await
            .map_err(|e| PromptError::Io(format!("could not write the prompt: {e}")))?;

        tracing::info!(prompt = %name, path = %path.display(), bytes = body.len(), "prompt saved");
        Ok(SavedPrompt {
            name,
            body: body.to_string(),
        })
    }

    /// Remove a prompt. An unknown name is a 404, not a silent success — the
    /// chooser it came from is a read of this directory, so a name it offers
    /// and this cannot find means the two have diverged and the operator should
    /// be told rather than shown a cheerful nothing.
    pub async fn delete(&self, name: &str) -> Result<String, PromptError> {
        let (name, path) = self.path_for(name)?;
        match tokio::fs::symlink_metadata(&path).await {
            Ok(meta) if meta.is_file() => {}
            _ => return Err(PromptError::NotFound(format!("no saved prompt {name:?}"))),
        }
        tokio::fs::remove_file(&path)
            .await
            .map_err(|e| PromptError::Io(format!("could not delete the prompt: {e}")))?;
        tracing::info!(prompt = %name, "prompt deleted");
        Ok(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway directory that removes itself. No `tempfile` dependency for
    /// the sake of six tests.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let mut path = std::env::temp_dir();
            path.push(format!(
                "rag-prompts-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("temp dir");
            Self(path)
        }
        fn library(&self) -> PromptLibrary {
            PromptLibrary::new(&self.0)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // ---- names ------------------------------------------------------------

    #[test]
    fn ordinary_names_are_accepted_and_trimmed() {
        for (given, expected) in [
            ("Terse", "Terse"),
            ("  Terse  ", "Terse"),
            ("what changed", "what changed"),
            ("terse-2", "terse-2"),
            ("terse_2", "terse_2"),
            ("2026 review", "2026 review"),
            ("a", "a"),
        ] {
            assert_eq!(validate_name(given).unwrap(), expected, "{given:?}");
        }
    }

    /// **The traversal cases.** This endpoint writes files, on a service with
    /// no authentication, so the hostile inputs are asserted individually
    /// rather than left to a single "it uses an allow-list" claim.
    #[test]
    fn a_name_that_could_be_a_path_is_refused() {
        for hostile in [
            "..",
            "../secret",
            "../../etc/shadow",
            "/etc/shadow",
            "/absolute",
            "sub/dir",
            "back\\slash",
            "..\\..\\windows",
            ".hidden",
            ".",
            "./x",
            "x/../y",
            // Percent-encoded forms, in case something upstream ever stops
            // decoding: the `%` is not in the allow-list either way.
            "%2e%2e",
            "%2e%2e%2fsecret",
            "%2Fetc%2Fshadow",
            "..%2f..%2fetc",
            // A NUL truncates a C string, which is how "x\0.md" becomes "x".
            "nul\0byte",
            // Not a path, but not a name this can round-trip through a file.
            "name.md",
            "name.with.dots",
            "quote\"mark",
            "semi;colon",
            "pipe|char",
            "star*",
            "tilde~",
            "new\nline",
            "tab\there",
            "unicode-ütf",
            "emoji-🐟",
        ] {
            let err = validate_name(hostile).unwrap_err();
            assert!(
                matches!(err, PromptError::Rejected(_)),
                "{hostile:?} was accepted"
            );
        }
    }

    #[test]
    fn a_blank_name_is_refused() {
        for blank in ["", "   ", "\t", "\n"] {
            assert!(validate_name(blank).is_err(), "{blank:?} was accepted");
        }
    }

    #[test]
    fn an_overlong_name_is_refused() {
        let ok = "a".repeat(MAX_NAME_CHARS);
        assert_eq!(validate_name(&ok).unwrap(), ok);
        assert!(validate_name(&"a".repeat(MAX_NAME_CHARS + 1)).is_err());
    }

    /// The containment re-check, on a library rooted somewhere that does not
    /// exist — nothing here touches the filesystem.
    #[test]
    fn a_resolved_path_stays_in_the_directory() {
        let library = PromptLibrary::new("/nonexistent/rag-prompts");
        let (name, path) = library.path_for("  Terse  ").unwrap();
        assert_eq!(name, "Terse");
        assert_eq!(path, Path::new("/nonexistent/rag-prompts/Terse.md"));
        assert_eq!(path.parent(), Some(Path::new("/nonexistent/rag-prompts")));

        for hostile in ["../escape", "/etc/shadow", "sub/dir", ".."] {
            assert!(library.path_for(hostile).is_err(), "{hostile:?}");
        }
    }

    // ---- the directory ----------------------------------------------------

    #[tokio::test]
    async fn a_missing_directory_is_an_empty_library_rather_than_a_failure() {
        let library = PromptLibrary::new("/nonexistent/rag-prompts");
        assert_eq!(library.list().await.unwrap(), Vec::new());
    }

    #[tokio::test]
    async fn a_saved_prompt_comes_back_from_the_listing() {
        let dir = TempDir::new("roundtrip");
        let library = dir.library();

        library.save("Terse", "Be brief.").await.unwrap();
        library
            .save("What changed", "List the changes.")
            .await
            .unwrap();

        assert_eq!(
            library.list().await.unwrap(),
            vec![
                SavedPrompt {
                    name: "Terse".into(),
                    body: "Be brief.".into()
                },
                SavedPrompt {
                    name: "What changed".into(),
                    body: "List the changes.".into()
                },
            ]
        );
        // Sorted case-insensitively: "Terse" before "What changed".
        assert!(dir.0.join("Terse.md").is_file());
    }

    #[tokio::test]
    async fn saving_the_same_name_replaces_it_rather_than_adding_a_second() {
        let dir = TempDir::new("upsert");
        let library = dir.library();
        library.save("Terse", "first").await.unwrap();
        library.save("Terse", "second").await.unwrap();
        let all = library.list().await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].body, "second");
    }

    #[tokio::test]
    async fn the_directory_is_created_on_the_first_save() {
        let dir = TempDir::new("create");
        let nested = dir.0.join("not-yet");
        let library = PromptLibrary::new(&nested);
        assert_eq!(library.list().await.unwrap(), Vec::new());
        library.save("Terse", "Be brief.").await.unwrap();
        assert!(nested.join("Terse.md").is_file());
    }

    #[tokio::test]
    async fn a_blank_or_oversized_body_is_refused() {
        let dir = TempDir::new("body");
        let library = dir.library();
        for blank in ["", "   ", "\n\t "] {
            assert!(library.save("Terse", blank).await.is_err(), "{blank:?}");
        }
        let huge = "x".repeat(MAX_BODY_BYTES + 1);
        assert!(library.save("Terse", &huge).await.is_err());
        // The cap itself is fine.
        assert!(library
            .save("Terse", &"x".repeat(MAX_BODY_BYTES))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn a_hostile_name_never_reaches_the_filesystem() {
        let dir = TempDir::new("hostile");
        let library = dir.library();
        for hostile in ["../escape", "/etc/rag-owned", "sub/dir", "..", ".ssh"] {
            assert!(library.save(hostile, "pwned").await.is_err(), "{hostile:?}");
            assert!(library.delete(hostile).await.is_err(), "{hostile:?}");
        }
        // And nothing was written anywhere: the directory is still empty, and
        // the parent it would have escaped into holds no `escape.md`.
        assert_eq!(library.list().await.unwrap(), Vec::new());
        assert!(!dir.0.parent().unwrap().join("escape.md").exists());
    }

    #[tokio::test]
    async fn deleting_removes_the_file_and_an_unknown_name_is_a_not_found() {
        let dir = TempDir::new("delete");
        let library = dir.library();
        library.save("Terse", "Be brief.").await.unwrap();
        assert_eq!(library.delete("Terse").await.unwrap(), "Terse");
        assert!(!dir.0.join("Terse.md").exists());
        assert!(matches!(
            library.delete("Terse").await.unwrap_err(),
            PromptError::NotFound(_)
        ));
    }

    /// A directory an operator has been editing by hand. Everything that is not
    /// a prompt this endpoint could write back is skipped, and skipping is
    /// silent to the caller — the listing still succeeds.
    #[tokio::test]
    async fn files_the_library_could_not_write_back_are_ignored() {
        let dir = TempDir::new("junk");
        let library = dir.library();
        library.save("Terse", "Be brief.").await.unwrap();

        std::fs::write(dir.0.join("notes.txt"), "not a prompt").unwrap();
        std::fs::write(dir.0.join("run.sh"), "#!/bin/sh").unwrap();
        std::fs::write(dir.0.join("has.dots.md"), "unwritable name").unwrap();
        std::fs::write(dir.0.join(".hidden.md"), "unwritable name").unwrap();
        std::fs::create_dir(dir.0.join("subdir.md")).unwrap();
        std::fs::write(dir.0.join("huge.md"), "x".repeat(MAX_BODY_BYTES + 1)).unwrap();

        let all = library.list().await.unwrap();
        assert_eq!(all.len(), 1, "{all:?}");
        assert_eq!(all[0].name, "Terse");
    }

    /// A symlink in the directory is neither listed nor written through — it is
    /// the one way a validated name could still reach a file somewhere else.
    #[cfg(unix)]
    #[tokio::test]
    async fn symlinks_are_not_followed() {
        let dir = TempDir::new("symlink");
        let library = dir.library();
        let outside = dir.0.parent().unwrap().join("rag-prompts-outside-target");
        std::fs::write(&outside, "secrets").unwrap();
        std::os::unix::fs::symlink(&outside, dir.0.join("Sneaky.md")).unwrap();

        assert_eq!(library.list().await.unwrap(), Vec::new());
        assert!(library.save("Sneaky", "overwritten").await.is_err());
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "secrets");
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn the_configured_path_is_optional() {
        assert!(PromptLibrary::from_config("").is_none());
        assert!(PromptLibrary::from_config("   ").is_none());
        assert_eq!(
            PromptLibrary::from_config(" /prompts ").unwrap().dir(),
            Path::new("/prompts")
        );
    }
}
