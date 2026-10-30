//! The tracker data layer: a SQLite store for a project's development queue, its
//! specs with their milestones, its concept documents and their attachments.
//!
//! The design is `specs/tracker/master.md` (D1–D11); this module is milestone m01.
//! It sits beside [`crate::ledger`] in style and is deliberately a **separate
//! database** (`tracker.db`), so a fault in or a restore of one never touches the
//! other.
//!
//! The rules the store enforces, so no caller has to remember them:
//!
//! * **Typed at the boundary.** Every type, status, state, reason, intensity,
//!   approval, surface and event kind is an enum here; a bad value is refused by
//!   its `FromStr`, never written as free text.
//! * **State changes only by appending an event** (D7). Each write is one
//!   transaction that changes the record and appends the event explaining it, so
//!   the history always explains the state. A note is optional on every change
//!   (owner, 2026-10-27): without one the event's body is generated from the
//!   change (`Status: pending → done.`). Only a bare note (a write that changes
//!   nothing else) needs a non-blank note, since the note is all it records.
//! * **The queue is a doubly linked list** (D5, `list.rs`). Every list change is
//!   one transaction relinking at most four rows; [`TrackerStore::check`] proves
//!   the list sound.
//! * **Documents are revisioned** (D9, `docs.rs`). An edit names the revision it
//!   read; an edit against an older one is refused with [`TrackerError::Stale`].
//!
//! Writes open `BEGIN IMMEDIATE` transactions: a deferred transaction that reads
//! and then writes can fail with `SQLITE_BUSY` when another connection wrote in
//! between, which `busy_timeout` cannot wait out. Taking the write lock up front
//! makes concurrent writers queue instead.

mod attachments;
mod docs;
mod feed;
mod index;
mod items;
mod labels;
mod list;
mod records;

#[cfg(test)]
mod tests;

use std::fmt;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{SqliteConnection, SqlitePool};

pub use attachments::{
    sniff_image_type, Attachment, AttachmentContent, NewAttachment, MAX_ATTACHMENT_BYTES,
    REFERENCE_LEN,
};
pub use docs::{
    apply_replacements, unified_diff, validate_path, Document, DocumentView, Edit, NewDocument,
    Replacement, Revision, RevisionDiff, MAX_DOCUMENT_BYTES,
};
pub use feed::{
    burst_line, describe_changes, joins_burst, FeedEvent, FeedFilter, BURST_WINDOW_SECS,
    DEFAULT_FEED_KINDS, FEED_CAPACITY,
};
pub use index::{DocForIndex, IndexSnapshot, ItemForIndex};
pub use items::{
    default_approval, queued_status, transition_allowed, Item, ItemRecord, ItemUpdate, NewItem,
    ProjectSummary, QueueView,
};
pub use labels::{clean_labels, label_key, LabelCount, MAX_LABELS, MAX_LABEL_CHARS};
pub use list::{IntegrityReport, Place};
pub use records::{
    Concept, ConceptRecord, ConceptUpdate, Milestone, MilestoneRecord, MilestoneUpdate, NewConcept,
    NewMilestone, NewSpec, Spec, SpecRecord, SpecUpdate,
};

// ---- Errors -----------------------------------------------------------------

/// Why a tracker call did not do what it was asked.
///
/// The variants map one-to-one onto HTTP statuses in `rag-serve` (400, 404, 409,
/// 500), so the distinction is made here, where the reason is known, rather than
/// guessed from a message later.
#[derive(Debug, thiserror::Error)]
pub enum TrackerError {
    /// The request was understood and refused: a bad value, a disallowed
    /// transition, a missing note, a taken path. The message is written for the
    /// caller to read.
    #[error("{0}")]
    Refused(String),
    /// The named record does not exist.
    #[error("{0}")]
    NotFound(String),
    /// A document edit named a base revision older than the current one (D9).
    /// Never merged: the caller re-reads and edits against `current_revision`.
    #[error("{message}")]
    Stale {
        message: String,
        current_revision: i64,
    },
    /// The store itself failed (SQLite, the filesystem). Not the caller's fault.
    #[error("tracker storage error: {0}")]
    Internal(String),
}

impl From<sqlx::Error> for TrackerError {
    fn from(e: sqlx::Error) -> Self {
        TrackerError::Internal(e.to_string())
    }
}

impl From<std::io::Error> for TrackerError {
    fn from(e: std::io::Error) -> Self {
        TrackerError::Internal(e.to_string())
    }
}

impl From<serde_json::Error> for TrackerError {
    fn from(e: serde_json::Error) -> Self {
        TrackerError::Internal(e.to_string())
    }
}

pub type TResult<T> = std::result::Result<T, TrackerError>;

fn refused<T>(msg: impl Into<String>) -> TResult<T> {
    Err(TrackerError::Refused(msg.into()))
}

// ---- Enums (validated at the boundary) --------------------------------------

/// Declares a string-valued enum: serde names, `as_str`, `Display`, a `FromStr`
/// that refuses anything else with the list of what it expected, and `ALL`.
///
/// An optional `retired { "old" => "why" }` list names values that were once
/// valid and are no longer: `FromStr` and deserialising refuse each with its
/// own message (pointing at what replaced it) instead of the generic one
/// (rag-t0024: the block reason `approval`).
macro_rules! str_enum {
    ($(#[$meta:meta])* $name:ident, $what:literal { $($(#[$vmeta:meta])* $variant:ident => $s:literal),+ $(,)? }
     $(retired { $($old:literal => $why:literal),+ $(,)? })?) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
        pub enum $name {
            $($(#[$vmeta])* #[serde(rename = $s)] $variant),+
        }

        impl $name {
            /// Every value, in declaration order.
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            pub fn as_str(self) -> &'static str {
                match self {
                    $($name::$variant => $s),+
                }
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl $name {
            /// The message refusing a retired value, if `s` is one.
            #[allow(unused_variables)]
            fn retired(s: &str) -> Option<&'static str> {
                $($(if s == $old {
                    return Some($why);
                })+)?
                None
            }
        }

        impl FromStr for $name {
            type Err = TrackerError;
            fn from_str(s: &str) -> TResult<Self> {
                if let Some(why) = Self::retired(s) {
                    return Err(TrackerError::Refused(why.to_string()));
                }
                match s {
                    $($s => Ok($name::$variant),)+
                    other => Err(TrackerError::Refused(format!(
                        "invalid {} {:?} (expected {})",
                        $what,
                        other,
                        [$($s),+].join("|")
                    ))),
                }
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                const VARIANTS: &[&str] = &[$($s),+];
                let s = String::deserialize(d)?;
                if let Some(why) = Self::retired(&s) {
                    return Err(serde::de::Error::custom(why));
                }
                match s.as_str() {
                    $($s => Ok($name::$variant),)+
                    other => Err(serde::de::Error::unknown_variant(other, VARIANTS)),
                }
            }
        }
    };
}

str_enum!(
    /// What kind of work a queue item is (R6).
    ItemType, "ticket type" {
        /// Implement a spec or a milestone.
        Dev => "dev",
        /// Artwork, image generation.
        Design => "design",
        /// Research, prep-work.
        Recon => "recon",
        /// Debugging.
        Analysis => "analysis",
        /// Gate and release; carries an [`Intensity`] and a release flag (D6).
        Gate => "gate",
        /// The owner's idea, with how to prioritise it (owner, 2026-10-27,
        /// rag-t0044). Never dispatched: the manager breaks it into tickets
        /// that link back to it (`from`), then marks it done. Queued in a
        /// section of its own ([`QueueView::requests`]), never in the queue a
        /// worker or a gate's batch reads.
        Request => "request",
    }
);

str_enum!(
    /// An item's status (D3). `pending`, `in_progress`, `failed`, `deferred`
    /// and `review` are **queued** (in the list); `done` and `cancelled` are not.
    /// `deferred` is work put aside on purpose (owner, 2026-10-27, rag-t0017):
    /// it keeps its place, so resuming it (`deferred` → `pending`) puts it back
    /// where it was. `review` is work waiting on the owner to confirm or review
    /// it (owner, 2026-10-27, rag-t0024): it keeps its place too, and is
    /// confirmed (`done`) or sent back (`in_progress`, `pending`).
    ItemStatus, "status" {
        Pending => "pending",
        InProgress => "in_progress",
        Done => "done",
        Failed => "failed",
        Cancelled => "cancelled",
        Deferred => "deferred",
        Review => "review",
    }
);

str_enum!(
    /// Why an item is blocked (R9). Independent of its status.
    ///
    /// `approval` was retired on 2026-10-27 (owner, rag-t0024): work waiting on
    /// the owner is the status `review` now. Opening an older database moves
    /// every item blocked with it to `review` ([`TrackerStore::open`]), and a
    /// write that still sends it is refused with a message saying so.
    BlockReason, "block reason" {
        Redesign => "redesign",
        Review => "review",
        /// It waits on other items of its project, named in its `depends_on`
        /// (rag-t0018). It unblocks itself when the last of them is done.
        Dependency => "dependency",
    }
    retired {
        "approval" => "the block reason approval was replaced by the status review (rag-t0024): \
                       set status review to put work in front of the owner",
    }
);

str_enum!(
    /// How heavy a gate is (R6).
    Intensity, "intensity" {
        Quick => "quick",
        Standard => "standard",
        Full => "full",
    }
);

str_enum!(
    /// Approval as a track record, not a lock (R10, D10).
    Approval, "approval" {
        /// Nobody has approved it.
        Unapproved => "unapproved",
        /// An agent approved it; the owner has not said.
        Agent => "agent",
        /// An agent approved it, then the owner did. Only reachable from `agent`.
        Ratified => "ratified",
        /// The owner approved it (in the web UI, or in conversation as an agent records).
        Owner => "owner",
    }
);

str_enum!(
    /// Which surface a write came through (D10): `web` is the owner at the
    /// keyboard, `mcp` is an agent.
    Surface, "surface" {
        Web => "web",
        Mcp => "mcp",
    }
);

str_enum!(
    /// The kind of a history event (D7).
    EventKind, "event kind" {
        Note => "note",
        Create => "create",
        Status => "status",
        Block => "block",
        Unblock => "unblock",
        Approve => "approve",
        Move => "move",
        Edit => "edit",
        Link => "link",
        Assign => "assign",
        Acknowledge => "acknowledge",
        Rename => "rename",
    }
);

str_enum!(
    /// A spec's state (D4).
    SpecState, "spec state" {
        Draft => "draft",
        Ready => "ready",
        InDevelopment => "in_development",
        Done => "done",
        Superseded => "superseded",
    }
);

str_enum!(
    /// A milestone's state (D4). Set by the manager; nothing derives it from tasks.
    MilestoneState, "milestone state" {
        NotStarted => "not_started",
        InProgress => "in_progress",
        Done => "done",
    }
);

str_enum!(
    /// A concept's state (D4). Archiving is a state, not a move.
    ConceptState, "concept state" {
        Open => "open",
        Refining => "refining",
        Refined => "refined",
        Archived => "archived",
    }
);

str_enum!(
    /// What a document belongs to.
    DocKind, "document kind" {
        /// A spec's master document, `specs/<slug>/master.md`.
        Spec => "spec",
        /// A milestone's document, `specs/<slug>/<code>-<name>.md`.
        Milestone => "milestone",
        /// A concept's document, `concepts/<slug>.md`.
        Concept => "concept",
        /// A free-standing document at any path.
        Doc => "doc",
    }
);

str_enum!(
    /// What a link from an item or a concept points at (D3, D4).
    LinkKind, "link kind" {
        /// A spec, by slug: `tracker`.
        Spec => "spec",
        /// A milestone, by `<spec slug>/<code>`: `tracker/m01`.
        Milestone => "milestone",
        /// A concept, by slug.
        Concept => "concept",
        /// A ledger topic, any project's, held as text: `ubu-l1652` (or a legacy
        /// `ubu-1592`, minted before rag-t0051).
        Ledger => "ledger",
        /// Another item, any project's: `ubu-t0042`.
        Item => "item",
        /// The request an item was broken out of (rag-t0044): an item of type
        /// `request` in the same project. Writing it writes the reverse,
        /// [`LinkKind::Became`], on the request; removing it removes that.
        From => "from",
        /// An item a request became (rag-t0044). Written and removed by the
        /// server only, as the reverse of a `from` link; a write naming it is
        /// refused.
        Became => "became",
    }
);

str_enum!(
    /// The kind of record an event belongs to.
    TargetKind, "target kind" {
        Item => "item",
        Spec => "spec",
        Milestone => "milestone",
        Concept => "concept",
        Document => "document",
    }
);

// ---- Shared records ---------------------------------------------------------

/// Who is writing (D10, D12). Every write takes one.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Actor {
    pub email: String,
    /// The acting agent's name. Blank or absent is recorded as [`OWNER_AGENT`]
    /// on the `web` surface (the owner at the keyboard, rag-t0038) and as
    /// [`UNKNOWN_AGENT`] on `mcp` (D12): a marker for an unattributed agent
    /// write rather than a guess.
    pub agent: Option<String>,
    pub surface: Surface,
}

impl Actor {
    pub fn new(email: impl Into<String>, agent: Option<&str>, surface: Surface) -> Self {
        Self {
            email: email.into(),
            agent: agent.map(str::to_string),
            surface,
        }
    }

    fn validated(&self) -> TResult<Who> {
        let email = self.email.trim();
        if email.is_empty() {
            return refused("author_email is required");
        }
        let agent = match (self.agent.as_deref().map(str::trim), self.surface) {
            (Some(a), _) if !a.is_empty() => a.to_string(),
            (_, Surface::Web) => OWNER_AGENT.to_string(),
            (_, Surface::Mcp) => UNKNOWN_AGENT.to_string(),
        };
        Ok((email.to_string(), agent, self.surface))
    }
}

/// A validated [`Actor`]: email, agent (never blank) and surface.
type Who = (String, String, Surface);

/// The agent a `web` write with no agent is recorded as (rag-t0038): the web UI
/// is the owner at the keyboard (D10) and never sends one. Stamped by the
/// server, so every web write is covered whatever the client sends; web events
/// written before it read `Unknown` and are rewritten to it on open
/// ([`TrackerStore::open`]).
pub const OWNER_AGENT: &str = "Owner";

/// The agent an `mcp` write with no agent is recorded as (D12).
pub const UNKNOWN_AGENT: &str = "Unknown";

/// A typed link (D3).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Link {
    pub kind: LinkKind,
    pub target: String,
}

impl PartialOrd for LinkKind {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for LinkKind {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.as_str().cmp(other.as_str())
    }
}

/// One history entry (D7).
#[derive(Debug, Clone, Serialize)]
pub struct Event {
    pub event_id: i64,
    pub ts: String,
    pub author_email: String,
    pub agent: String,
    pub surface: Surface,
    pub kind: EventKind,
    /// The note, or a generated description when the write carried none.
    pub body: String,
    /// The fields this event set, with their new values (`{}` for a bare note).
    pub fields: serde_json::Value,
    /// The values those fields held before the write (rag-t0038), keyed as in
    /// `fields`: the "from" of a from → to. Recorded for every change made
    /// since; `null` on a create (nothing came before) and on an event written
    /// before it was recorded, which shows its new values only. A field with no
    /// prior value to give (`links_added`, `unblocked_by`) is absent from it.
    pub before: Option<serde_json::Value>,
    /// Written while its record was a draft (rag, owner 2026-10-30): the feed
    /// leaves it out unless asked for drafts. See [`event_is_draft`].
    pub draft: bool,
}

// ---- Store ------------------------------------------------------------------

/// Handle to the tracker SQLite database and its attachments directory. Cheap to
/// clone (wraps a pool).
#[derive(Clone)]
pub struct TrackerStore {
    pool: SqlitePool,
    attachments_dir: PathBuf,
    /// The live event feed (rag-t0036, `feed.rs`), shared by every clone.
    feed: std::sync::Arc<feed::Feed>,
}

impl TrackerStore {
    /// Open (creating if missing) the tracker DB at `db_path` in WAL mode, ensure
    /// the schema exists, and create `attachments_dir` if it is missing.
    pub async fn open(
        db_path: impl AsRef<Path>,
        attachments_dir: impl AsRef<Path>,
    ) -> TResult<Self> {
        let path = db_path.as_ref();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        std::fs::create_dir_all(attachments_dir.as_ref())?;
        let opts = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true)
            .busy_timeout(std::time::Duration::from_secs(10));
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(opts)
            .await?;
        let store = Self {
            pool,
            attachments_dir: attachments_dir.as_ref().to_path_buf(),
            feed: std::sync::Arc::new(feed::Feed::new(0, FEED_CAPACITY)),
        };
        store.init_schema().await?;
        // The feed starts after everything already in the table (the open-time
        // migrations' events included): a subscriber replays those by `since`.
        store.feed.start_at(store.latest_event_id().await?).await;
        Ok(store)
    }

    /// The directory attachments are stored under.
    pub fn attachments_dir(&self) -> &Path {
        &self.attachments_dir
    }

    async fn init_schema(&self) -> TResult<()> {
        sqlx::query(SCHEMA_SQL).execute(&self.pool).await?;
        for (table, column, decl) in ADDED_COLUMNS {
            let have: Option<i64> =
                sqlx::query_scalar("SELECT 1 FROM pragma_table_info(?) WHERE name = ?")
                    .bind(table)
                    .bind(column)
                    .fetch_optional(&self.pool)
                    .await?;
            if have.is_some() {
                continue;
            }
            match sqlx::query(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"))
                .execute(&self.pool)
                .await
            {
                Ok(_) => {}
                // Another connection opening the same file added it first.
                Err(e) if e.to_string().contains("duplicate column") => {}
                Err(e) => return Err(e.into()),
            }
        }
        self.migrate_retired_approval_blocks().await?;
        self.migrate_web_agent_to_owner().await?;
        Ok(())
    }

    /// The data migration for rag-t0038 (owner, 2026-10-27): web writes are
    /// stamped [`OWNER_AGENT`] when they carry no agent, and the web UI never
    /// sends one, so every web event, revision and attachment recorded before
    /// that reads [`UNKNOWN_AGENT`]. They are rewritten to `Owner`, so every
    /// reader (the API, the web UI, the MCP tools, the feed, the search index, a
    /// hand-run `sqlite3`) sees one value rather than each applying a display
    /// rule. Only the `agent` column of a `web` row that reads exactly
    /// `Unknown` changes; no event is appended (nothing about the record
    /// changed, only who it names). Idempotent: a second open finds nothing.
    async fn migrate_web_agent_to_owner(&self) -> TResult<()> {
        let mut tx = self.write_tx().await?;
        for table in ["events", "revisions", "attachments"] {
            sqlx::query(&format!(
                "UPDATE {table} SET agent = ? WHERE surface = 'web' AND agent = ?"
            ))
            .bind(OWNER_AGENT)
            .bind(UNKNOWN_AGENT)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// The data migration for rag-t0024 (owner, 2026-10-27): the block reason
    /// `approval` is retired in favour of the status `review`. Every queued item
    /// blocked with it becomes `review`, unblocked, keeping its place, with a
    /// `status` event saying so (the old block note, when there was one, is kept
    /// in the event's body). An item not queued cannot hold a block (leaving the
    /// queue clears it); one that somehow does is only unblocked. Idempotent: a
    /// second open finds nothing to move. Other reasons are untouched.
    ///
    /// The events are authored by [`MIGRATION_ACTOR`]: email `system`, agent
    /// `Tracker migration (rag-t0024)`, surface `mcp` (written by the server's
    /// code, not by the owner at the keyboard, which `web` would claim).
    async fn migrate_retired_approval_blocks(&self) -> TResult<()> {
        let mut tx = self.write_tx().await?;
        let rows: Vec<(String, String, String, Option<String>)> = sqlx::query_as(
            "SELECT id, project, status, block_note FROM items \
             WHERE blocked = 1 AND block_reason = 'approval' ORDER BY project, seq",
        )
        .fetch_all(&mut *tx)
        .await?;
        if rows.is_empty() {
            return Ok(());
        }
        let now = now_iso();
        let who: Who = (
            MIGRATION_ACTOR.0.to_string(),
            MIGRATION_ACTOR.1.to_string(),
            Surface::Mcp,
        );
        for (id, project, status, note) in rows {
            let queued = ItemStatus::from_str(&status).is_ok_and(queued_status);
            let note_said = note
                .as_deref()
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .map(|n| format!(" The block note was: {n}"))
                .unwrap_or_default();
            let (kind, body, fields, before) = if queued {
                sqlx::query(
                    "UPDATE items SET status = 'review', blocked = 0, block_reason = NULL, \
                     block_note = NULL, updated_at = ? WHERE id = ?",
                )
                .bind(&now)
                .bind(&id)
                .execute(&mut *tx)
                .await?;
                (
                    EventKind::Status,
                    format!("{MIGRATED_TO_REVIEW}{note_said}"),
                    serde_json::json!({ "status": "review", "blocked": false }),
                    serde_json::json!({ "status": status, "blocked": true, "block_reason": "approval" }),
                )
            } else {
                sqlx::query(
                    "UPDATE items SET blocked = 0, block_reason = NULL, block_note = NULL, \
                     updated_at = ? WHERE id = ?",
                )
                .bind(&now)
                .bind(&id)
                .execute(&mut *tx)
                .await?;
                (
                    EventKind::Unblock,
                    format!("Unblocked: the block reason approval was retired.{note_said}"),
                    serde_json::json!({ "blocked": false }),
                    serde_json::json!({ "blocked": true, "block_reason": "approval" }),
                )
            };
            append_event(
                &mut tx,
                &project,
                TargetKind::Item,
                &id,
                &who,
                kind,
                &body,
                &fields,
                Some(&before),
                &now,
            )
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// A write transaction holding SQLite's write lock from its first statement.
    async fn write_tx(&self) -> TResult<sqlx::Transaction<'static, sqlx::Sqlite>> {
        Ok(self.pool.begin_with("BEGIN IMMEDIATE").await?)
    }
}

// ---- Helpers shared by the submodules ---------------------------------------

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Names that cannot be projects because they are route segments under
/// `/tracker/` in `rag-serve` (`/tracker/items/{id}` and friends).
pub const RESERVED_PROJECT_NAMES: &[&str] = &["items", "docs", "attachments", "projects"];

/// A project is named as its repository is (D2): letters, digits, `.`, `_`, `-`,
/// starting with a letter or digit, at most 64 characters.
pub fn validate_project(name: &str) -> TResult<()> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !ok {
        return refused(format!(
            "invalid project name {name:?} (a repository name: letters, digits, '.', '_', '-')"
        ));
    }
    if RESERVED_PROJECT_NAMES.contains(&name) {
        return refused(format!("{name:?} is reserved and cannot be a project name"));
    }
    Ok(())
}

/// A slug: lowercase letters, digits and `-`, starting with a letter or digit,
/// at most 80 characters. Used for spec and concept slugs and milestone codes.
fn validate_slug(what: &str, slug: &str) -> TResult<()> {
    let ok = !slug.is_empty()
        && slug.len() <= 80
        && slug
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(())
    } else {
        refused(format!(
            "invalid {what} {slug:?} (lowercase letters, digits and '-', starting with a letter or digit)"
        ))
    }
}

/// Turn a title into a file-name slug: `"The store and the HTTP API"` →
/// `"the-store-and-the-http-api"`.
pub fn slugify(title: &str) -> String {
    let mut out = String::new();
    for c in title.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out.truncate(80);
    while out.ends_with('-') {
        out.pop();
    }
    out
}

fn require_title(title: &str) -> TResult<String> {
    let t = title.trim();
    if t.is_empty() {
        return refused("title must not be blank");
    }
    Ok(t.to_string())
}

/// The note a write carried, trimmed; `None` when absent or blank. A note is
/// optional on every change (D7, amended 2026-10-27); a blank one is no note.
fn given_note(note: Option<&str>) -> Option<String> {
    note.map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
}

/// Create the project row on first write (D2).
async fn ensure_project(conn: &mut SqliteConnection, project: &str, now: &str) -> TResult<()> {
    validate_project(project)?;
    sqlx::query("INSERT OR IGNORE INTO projects (name, created_at) VALUES (?, ?)")
        .bind(project)
        .bind(now)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Append one event. Every write calls this exactly once per record it changes.
/// `before` is what the changed fields held before the write (rag-t0038), keyed
/// as `fields` is; `None` on a create, where nothing came before.
#[allow(clippy::too_many_arguments)]
async fn append_event(
    conn: &mut SqliteConnection,
    project: &str,
    target_kind: TargetKind,
    target_id: &str,
    actor: &Who,
    kind: EventKind,
    body: &str,
    fields: &serde_json::Value,
    before: Option<&serde_json::Value>,
    now: &str,
) -> TResult<i64> {
    let draft = event_is_draft(conn, project, target_kind, target_id, fields, before).await?;
    let before = before.map(serde_json::to_string).transpose()?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO events (project, target_kind, target_id, ts, author_email, agent, surface, \
         kind, body, fields, fields_before, draft) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) \
         RETURNING event_id",
    )
    .bind(project)
    .bind(target_kind.as_str())
    .bind(target_id)
    .bind(now)
    .bind(&actor.0)
    .bind(&actor.1)
    .bind(actor.2.as_str())
    .bind(kind.as_str())
    .bind(body)
    .bind(serde_json::to_string(fields)?)
    .bind(before)
    .bind(draft as i64)
    .fetch_one(&mut *conn)
    .await?;
    Ok(id)
}

/// Whether an event is a **draft event** (owner, 2026-10-30): one the feed
/// leaves out unless asked for drafts, so the owner can write and rework a
/// ticket or a document without waking a monitoring agent.
///
/// It is a draft event when its record is a draft **after** the write, except
/// the write that turned a published record into a draft (`draft: no → yes`),
/// which is announced so whoever was working from it knows to stop. Publishing
/// (`draft: yes → no`) is never a draft event: it is the record's arrival.
///
/// The record's draft flag is read in the writing transaction, after the
/// change, so every write path is covered without saying so. An item holds its
/// own flag; a document holds its own, and a concept is a draft while **its
/// document** is (it has exactly one). Specs and milestones are never drafts
/// (owner, 2026-10-30): a spec has its own `draft` state and is the agents'
/// work, so every change to one, or to its documents, is sent. A record that
/// is gone or was never a draft reads as published. The flag is stamped on the event
/// at write time, so a replay after the record is published still leaves its
/// draft history out.
pub(crate) async fn event_is_draft(
    conn: &mut SqliteConnection,
    project: &str,
    target_kind: TargetKind,
    target_id: &str,
    fields: &serde_json::Value,
    before: Option<&serde_json::Value>,
) -> TResult<bool> {
    let flag = |v: Option<&serde_json::Value>| v.and_then(|v| v.get("draft")?.as_bool());
    if flag(Some(fields)) == Some(true) && flag(before) == Some(false) {
        return Ok(false);
    }
    record_is_draft(conn, project, target_kind, target_id).await
}

/// Whether a record is a draft now (see [`event_is_draft`]).
pub(crate) async fn record_is_draft(
    conn: &mut SqliteConnection,
    project: &str,
    target_kind: TargetKind,
    target_id: &str,
) -> TResult<bool> {
    let draft: Option<i64> = match target_kind {
        TargetKind::Item => {
            sqlx::query_scalar("SELECT draft FROM items WHERE id = ?")
                .bind(target_id)
                .fetch_optional(&mut *conn)
                .await?
        }
        TargetKind::Document => {
            sqlx::query_scalar("SELECT draft FROM documents WHERE id = ?")
                .bind(target_id)
                .fetch_optional(&mut *conn)
                .await?
        }
        TargetKind::Concept => {
            sqlx::query_scalar(
                "SELECT draft FROM documents WHERE project = ? AND kind = 'concept' \
                 AND concept_slug = ?",
            )
            .bind(project)
            .bind(target_id)
            .fetch_optional(&mut *conn)
            .await?
        }
        TargetKind::Spec | TargetKind::Milestone => return Ok(false),
    };
    Ok(draft.unwrap_or(0) != 0)
}

#[derive(sqlx::FromRow)]
struct EventRow {
    event_id: i64,
    ts: String,
    author_email: String,
    agent: String,
    surface: String,
    kind: String,
    body: String,
    fields: String,
    fields_before: Option<String>,
    draft: i64,
}

impl EventRow {
    fn into_event(self) -> TResult<Event> {
        Ok(Event {
            event_id: self.event_id,
            ts: self.ts,
            author_email: self.author_email,
            agent: self.agent,
            surface: self.surface.parse()?,
            kind: self.kind.parse()?,
            body: self.body,
            fields: serde_json::from_str(&self.fields).unwrap_or(serde_json::Value::Null),
            before: self
                .fields_before
                .as_deref()
                .and_then(|b| serde_json::from_str(b).ok()),
            draft: self.draft != 0,
        })
    }
}

/// A record's history, oldest first.
async fn events_for(
    conn: &mut SqliteConnection,
    project: &str,
    target_kind: TargetKind,
    target_id: &str,
) -> TResult<Vec<Event>> {
    let rows = sqlx::query_as::<_, EventRow>(
        "SELECT event_id, ts, author_email, agent, surface, kind, body, fields, fields_before, \
         draft FROM events \
         WHERE project = ? AND target_kind = ? AND target_id = ? ORDER BY event_id",
    )
    .bind(project)
    .bind(target_kind.as_str())
    .bind(target_id)
    .fetch_all(&mut *conn)
    .await?;
    rows.into_iter().map(EventRow::into_event).collect()
}

/// Check one link's target exists (or, for a ledger topic, is plausibly an id).
async fn validate_link(
    conn: &mut SqliteConnection,
    project: &str,
    link: &Link,
    self_item: Option<&str>,
) -> TResult<()> {
    let target = link.target.trim();
    if target.is_empty() || target.chars().any(char::is_whitespace) {
        return refused(format!(
            "invalid {} link target {:?}",
            link.kind, link.target
        ));
    }
    let exists: Option<i64> = match link.kind {
        LinkKind::Ledger => return Ok(()),
        LinkKind::Became => return refused(BECAME_IS_THE_SERVERS),
        LinkKind::From => {
            let Some(me) = self_item else {
                return refused(
                    "a from link goes on a ticket: it names the request the ticket came from",
                );
            };
            if target == me {
                return refused("a ticket cannot come from itself");
            }
            let row: Option<(String, String)> =
                sqlx::query_as("SELECT project, type FROM items WHERE id = ?")
                    .bind(target)
                    .fetch_optional(&mut *conn)
                    .await?;
            return match row {
                None => refused(format!("no ticket {target:?} to come from")),
                Some((p, _)) if p != project => refused(format!(
                    "{target} is a ticket of project {p}; a from link names a request of the \
                     ticket's own project ({project})"
                )),
                Some((_, t)) if t != ItemType::Request.as_str() => refused(format!(
                    "{target} is a {t} ticket; a from link names a request"
                )),
                Some(_) => Ok(()),
            };
        }
        LinkKind::Item => {
            if Some(target) == self_item {
                return refused("a ticket cannot link to itself");
            }
            sqlx::query_scalar("SELECT 1 FROM items WHERE id = ?")
                .bind(target)
                .fetch_optional(&mut *conn)
                .await?
        }
        LinkKind::Spec => {
            sqlx::query_scalar("SELECT 1 FROM specs WHERE project = ? AND slug = ?")
                .bind(project)
                .bind(target)
                .fetch_optional(&mut *conn)
                .await?
        }
        LinkKind::Concept => {
            sqlx::query_scalar("SELECT 1 FROM concepts WHERE project = ? AND slug = ?")
                .bind(project)
                .bind(target)
                .fetch_optional(&mut *conn)
                .await?
        }
        LinkKind::Milestone => {
            let Some((spec, code)) = target.split_once('/') else {
                return refused(format!(
                    "a milestone link is <spec slug>/<code>, not {target:?}"
                ));
            };
            sqlx::query_scalar(
                "SELECT 1 FROM milestones WHERE project = ? AND spec_slug = ? AND code = ?",
            )
            .bind(project)
            .bind(spec)
            .bind(code)
            .fetch_optional(&mut *conn)
            .await?
        }
    };
    if exists.is_none() {
        let scope = if link.kind == LinkKind::Item {
            String::new()
        } else {
            format!(" in project {project}")
        };
        return refused(format!("no {} {:?}{scope} to link to", link.kind, target));
    }
    Ok(())
}

/// Why a write naming a `became` link is refused (rag-t0044).
pub const BECAME_IS_THE_SERVERS: &str = "became links are written by the server: give the ticket \
     from:<request id> (on create, or add_links on update) and the request's became link follows";

/// Who the open-time data migrations write as: `(email, agent)`, surface `mcp`.
pub const MIGRATION_ACTOR: (&str, &str) = ("system", "Tracker migration (rag-t0024)");

/// The body of the event that moves an item blocked with the retired reason
/// `approval` to the status `review` (rag-t0024).
pub const MIGRATED_TO_REVIEW: &str =
    "Moved to review: the block reason approval was replaced by the review status.";

/// Columns added to a table after databases were first created with it: `(table,
/// column, declaration)`. Each is additive with a default, so [`TrackerStore::open`]
/// adds it to an older `tracker.db` and every existing row reads the default
/// (the live database opens unchanged). `SCHEMA_SQL` already has them, for a new
/// database. A new table needs no entry: `CREATE TABLE IF NOT EXISTS` adds it
/// (as `item_depends`, rag-t0018, and `item_labels`, rag-t0027, were).
pub(crate) const ADDED_COLUMNS: &[(&str, &str, &str)] = &[
    // rag-t0013: may start before the gates above it clear.
    ("items", "parallel", "INTEGER NOT NULL DEFAULT 0"),
    // rag-t0038: the changed fields' values before the write (JSON); NULL on a
    // create and on every event written before it was recorded.
    ("events", "fields_before", "TEXT"),
    // Drafts (owner, 2026-10-30): an item or a document the owner is still
    // writing, and an event written while its record was one (the feed leaves
    // those out unless asked).
    ("items", "draft", "INTEGER NOT NULL DEFAULT 0"),
    ("documents", "draft", "INTEGER NOT NULL DEFAULT 0"),
    ("events", "draft", "INTEGER NOT NULL DEFAULT 0"),
];

pub(crate) const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS projects (
    name       TEXT PRIMARY KEY,
    head_id    TEXT,
    tail_id    TEXT,
    item_seq   INTEGER NOT NULL DEFAULT 0,
    doc_seq    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
    id              TEXT PRIMARY KEY,
    project         TEXT NOT NULL REFERENCES projects(name),
    seq             INTEGER NOT NULL,
    type            TEXT NOT NULL,
    title           TEXT NOT NULL,
    body            TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL,
    blocked         INTEGER NOT NULL DEFAULT 0,
    block_reason    TEXT,
    block_note      TEXT,
    approval        TEXT NOT NULL,
    assignee        TEXT,
    intensity       TEXT,
    release         INTEGER NOT NULL DEFAULT 0,
    parallel        INTEGER NOT NULL DEFAULT 0,
    draft           INTEGER NOT NULL DEFAULT 0,
    prev_id         TEXT,
    next_id         TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    done_at         TEXT,
    acknowledged_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_project ON items(project, status);

CREATE TABLE IF NOT EXISTS item_links (
    item_id TEXT NOT NULL REFERENCES items(id),
    kind    TEXT NOT NULL,
    target  TEXT NOT NULL,
    PRIMARY KEY (item_id, kind, target)
);

-- What an item blocked with reason `dependency` waits on (rag-t0018): items of
-- its own project. Held only while it is so blocked; cleared when it unblocks.
CREATE TABLE IF NOT EXISTS item_depends (
    item_id    TEXT NOT NULL REFERENCES items(id),
    depends_on TEXT NOT NULL REFERENCES items(id),
    PRIMARY KEY (item_id, depends_on)
);
CREATE INDEX IF NOT EXISTS idx_item_depends_on ON item_depends(depends_on);

-- An item's labels (rag-t0027): free text, matched case-insensitively within a
-- project by `label_key` (the label lowercased), the project's casing kept in
-- `label`. `project` is the item's, held here so a project's vocabulary is one
-- indexed query. A new table: CREATE IF NOT EXISTS adds it to an older database.
CREATE TABLE IF NOT EXISTS item_labels (
    item_id   TEXT NOT NULL REFERENCES items(id),
    project   TEXT NOT NULL,
    label     TEXT NOT NULL,
    label_key TEXT NOT NULL,
    PRIMARY KEY (item_id, label_key)
);
CREATE INDEX IF NOT EXISTS idx_item_labels_project ON item_labels(project, label_key);

CREATE TABLE IF NOT EXISTS specs (
    project    TEXT NOT NULL REFERENCES projects(name),
    slug       TEXT NOT NULL,
    title      TEXT NOT NULL,
    state      TEXT NOT NULL,
    approval   TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project, slug)
);

CREATE TABLE IF NOT EXISTS milestones (
    project    TEXT NOT NULL,
    spec_slug  TEXT NOT NULL,
    code       TEXT NOT NULL,
    title      TEXT NOT NULL,
    ord        INTEGER NOT NULL,
    state      TEXT NOT NULL,
    approval   TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project, spec_slug, code),
    FOREIGN KEY (project, spec_slug) REFERENCES specs(project, slug)
);

CREATE TABLE IF NOT EXISTS concepts (
    project    TEXT NOT NULL REFERENCES projects(name),
    slug       TEXT NOT NULL,
    title      TEXT NOT NULL,
    state      TEXT NOT NULL,
    approval   TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project, slug)
);

CREATE TABLE IF NOT EXISTS concept_links (
    project TEXT NOT NULL,
    slug    TEXT NOT NULL,
    kind    TEXT NOT NULL,
    target  TEXT NOT NULL,
    PRIMARY KEY (project, slug, kind, target),
    FOREIGN KEY (project, slug) REFERENCES concepts(project, slug)
);

-- The owner record of a document is (kind, spec_slug, milestone_code, concept_slug):
-- a spec's master has spec_slug; a milestone's has spec_slug and milestone_code; a
-- concept's has concept_slug; a free-standing doc has none.
CREATE TABLE IF NOT EXISTS documents (
    id             TEXT PRIMARY KEY,
    project        TEXT NOT NULL REFERENCES projects(name),
    path           TEXT NOT NULL,
    kind           TEXT NOT NULL,
    title          TEXT NOT NULL,
    revision       INTEGER NOT NULL,
    spec_slug      TEXT,
    milestone_code TEXT,
    concept_slug   TEXT,
    draft          INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    UNIQUE (project, path)
);

CREATE TABLE IF NOT EXISTS revisions (
    doc_id       TEXT NOT NULL REFERENCES documents(id),
    revision     INTEGER NOT NULL,
    body         TEXT NOT NULL,
    author_email TEXT NOT NULL,
    agent        TEXT NOT NULL,
    surface      TEXT NOT NULL,
    ts           TEXT NOT NULL,
    message      TEXT NOT NULL,
    PRIMARY KEY (doc_id, revision)
);

-- A renamed document's old path. Never reused by another document (D4).
CREATE TABLE IF NOT EXISTS redirects (
    project    TEXT NOT NULL,
    old_path   TEXT NOT NULL,
    doc_id     TEXT NOT NULL REFERENCES documents(id),
    renamed_at TEXT NOT NULL,
    PRIMARY KEY (project, old_path)
);

-- One row per upload; the bytes are stored once per sha256 (D8).
CREATE TABLE IF NOT EXISTS attachments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project      TEXT NOT NULL REFERENCES projects(name),
    sha256       TEXT NOT NULL,
    name         TEXT NOT NULL,
    media_type   TEXT NOT NULL,
    size         INTEGER NOT NULL,
    author_email TEXT NOT NULL,
    agent        TEXT NOT NULL,
    surface      TEXT NOT NULL,
    uploaded_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_sha ON attachments(sha256);
CREATE INDEX IF NOT EXISTS idx_attachments_project ON attachments(project);

CREATE TABLE IF NOT EXISTS events (
    event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    project      TEXT NOT NULL,
    target_kind  TEXT NOT NULL,
    target_id    TEXT NOT NULL,
    ts           TEXT NOT NULL,
    author_email TEXT NOT NULL,
    agent        TEXT NOT NULL,
    surface      TEXT NOT NULL,
    kind         TEXT NOT NULL,
    body         TEXT NOT NULL,
    fields       TEXT NOT NULL DEFAULT '{}',
    fields_before TEXT,
    draft        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_target ON events(project, target_kind, target_id);
";
