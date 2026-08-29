//! The ledger data layer: a SQLite store for the decision/incident record.
//!
//! This is the **source of truth** for the ledger (the Qdrant `corpus = ledger`
//! points are a derived, rebuildable search index — see `ingest::ledger_reconcile`).
//! A topic is the root node: an immutable `summary`, a mutable `current_state`, a
//! lifecycle `status`, and an append-only monologue of `events`. State and status
//! change **only** by appending an event, so the log always explains the state.
//!
//! Strong typing is the enforcement mechanism: the public API takes typed enums
//! (`TopicType`/`Status`/`EventKind`), so a malformed type or status is rejected at
//! the boundary rather than written as freeform text.

use std::path::Path;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;

use crate::error::{Error, Result};
use crate::hashing::hash_str;

// ---- Enums (validated at the boundary) --------------------------------------

/// What question a topic answers for a future agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TopicType {
    /// A deliberate choice + rationale + rejected alternatives (ADR-style).
    Decision,
    /// A live-system failure + root-cause postmortem.
    Incident,
    /// A dev-caught code bug + its fix.
    Defect,
    /// A spike/exploration whose value is the finding, even with no change.
    Investigation,
}

impl TopicType {
    pub fn as_str(self) -> &'static str {
        match self {
            TopicType::Decision => "decision",
            TopicType::Incident => "incident",
            TopicType::Defect => "defect",
            TopicType::Investigation => "investigation",
        }
    }

    /// The lifecycle status a freshly-created topic of this type starts in.
    pub fn default_status(self) -> Status {
        match self {
            TopicType::Decision => Status::Proposed,
            _ => Status::Open,
        }
    }
}

impl FromStr for TopicType {
    type Err = Error;
    fn from_str(s: &str) -> Result<Self> {
        match s {
            "decision" => Ok(TopicType::Decision),
            "incident" => Ok(TopicType::Incident),
            "defect" => Ok(TopicType::Defect),
            "investigation" => Ok(TopicType::Investigation),
            other => Err(Error::Ledger(format!(
                "invalid topic type {other:?} (expected decision|incident|defect|investigation)"
            ))),
        }
    }
}

/// A topic's lifecycle status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Open,
    Resolved,
    Proposed,
    Accepted,
    Superseded,
    Reverted,
    Wontfix,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Open => "open",
            Status::Resolved => "resolved",
            Status::Proposed => "proposed",
            Status::Accepted => "accepted",
            Status::Superseded => "superseded",
            Status::Reverted => "reverted",
            Status::Wontfix => "wontfix",
        }
    }
}

impl FromStr for Status {
    type Err = Error;
    fn from_str(s: &str) -> Result<Self> {
        match s {
            "open" => Ok(Status::Open),
            "resolved" => Ok(Status::Resolved),
            "proposed" => Ok(Status::Proposed),
            "accepted" => Ok(Status::Accepted),
            "superseded" => Ok(Status::Superseded),
            "reverted" => Ok(Status::Reverted),
            "wontfix" => Ok(Status::Wontfix),
            other => Err(Error::Ledger(format!(
                "invalid status {other:?} (expected open|resolved|proposed|accepted|superseded|reverted|wontfix)"
            ))),
        }
    }
}

/// The kind of a monologue event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Note,
    StateChange,
    StatusChange,
    Correction,
    Link,
}

impl EventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EventKind::Note => "note",
            EventKind::StateChange => "state_change",
            EventKind::StatusChange => "status_change",
            EventKind::Correction => "correction",
            EventKind::Link => "link",
        }
    }
}

impl FromStr for EventKind {
    type Err = Error;
    fn from_str(s: &str) -> Result<Self> {
        match s {
            "note" => Ok(EventKind::Note),
            "state_change" => Ok(EventKind::StateChange),
            "status_change" => Ok(EventKind::StatusChange),
            "correction" => Ok(EventKind::Correction),
            "link" => Ok(EventKind::Link),
            other => Err(Error::Ledger(format!(
                "invalid event kind {other:?} (expected note|state_change|status_change|correction|link)"
            ))),
        }
    }
}

/// A typed relationship between two topics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkRel {
    Supersedes,
    SupersededBy,
    Related,
    CausedBy,
}

impl LinkRel {
    pub fn as_str(self) -> &'static str {
        match self {
            LinkRel::Supersedes => "supersedes",
            LinkRel::SupersededBy => "superseded_by",
            LinkRel::Related => "related",
            LinkRel::CausedBy => "caused_by",
        }
    }
}

impl FromStr for LinkRel {
    type Err = Error;
    fn from_str(s: &str) -> Result<Self> {
        match s {
            "supersedes" => Ok(LinkRel::Supersedes),
            "superseded_by" => Ok(LinkRel::SupersededBy),
            "related" => Ok(LinkRel::Related),
            "caused_by" => Ok(LinkRel::CausedBy),
            other => Err(Error::Ledger(format!("invalid link rel {other:?}"))),
        }
    }
}

// ---- Public records ---------------------------------------------------------

/// A topic: the root node of the ledger.
#[derive(Debug, Clone, Serialize)]
pub struct Topic {
    pub topic_id: String,
    #[serde(rename = "type")]
    pub topic_type: TopicType,
    pub repo: String,
    /// Amendable handle — changed only via [`LedgerStore::append_event`]'s
    /// `set_title`, which records the new value on the event that made the
    /// change. References between topics are by `topic_id`, never by title, so
    /// a retitle breaks nothing.
    pub title: String,
    /// **Immutable** original framing, set at creation and never revised.
    ///
    /// This is the one field that records what the problem looked like *before*
    /// the answer was known, which is the thing a later reader most needs and a
    /// present author is most tempted to tidy away. It has no setter by design.
    pub summary: String,
    /// Current understanding — mutated only via [`LedgerStore::append_event`].
    pub current_state: String,
    pub status: Status,
    pub created_at: String,
    pub updated_at: String,
    pub creator_email: String,
    pub creator_agent: Option<String>,
    /// Amendable retrieval affordance — changed via `set_tags`. Not part of the
    /// indexed payload or the embedded text, so a tag change does not by itself
    /// force a re-embed (the event it is recorded on does).
    pub tags: Vec<String>,
    /// Soft-delete flag. An archived topic is retained in the source of truth but
    /// hidden from a normal `ledger_search` and purged from the RAG index (the
    /// reconciler excludes it from [`LedgerStore::all_for_index`]).
    pub archived: bool,
    /// When it was archived (RFC3339), or `None` while live.
    pub archived_at: Option<String>,
}

/// A single monologue event.
#[derive(Debug, Clone, Serialize)]
pub struct Event {
    pub event_id: i64,
    pub ts: String,
    pub author_email: String,
    pub author_agent: Option<String>,
    pub kind: EventKind,
    pub body: String,
    pub new_state: Option<String>,
    pub new_status: Option<String>,
    /// The title this event set, if it amended one.
    pub new_title: Option<String>,
    /// The tag set this event installed, if it amended one. Wholesale
    /// replacement, not a delta — see [`NewEvent::set_tags`].
    pub new_tags: Option<Vec<String>>,
}

/// A typed link from a topic to another topic.
#[derive(Debug, Clone, Serialize)]
pub struct Link {
    pub rel: LinkRel,
    pub other_topic_id: String,
}

/// The full record returned by [`LedgerStore::get_topic`].
#[derive(Debug, Clone, Serialize)]
pub struct TopicRecord {
    #[serde(flatten)]
    pub topic: Topic,
    pub events: Vec<Event>,
    pub links: Vec<Link>,
}

/// A redirect tombstone: where a moved topic's content now lives.
#[derive(Debug, Clone, Serialize)]
pub struct MovePointer {
    pub old_topic_id: String,
    pub new_topic_id: String,
    pub moved_at: String,
}

/// A topic plus its events and the whole-topic content hash, for the reconciler.
#[derive(Debug, Clone)]
pub struct TopicForIndex {
    pub topic: Topic,
    pub events: Vec<Event>,
    pub topic_hash: String,
}

// ---- Inputs -----------------------------------------------------------------

/// Input to [`LedgerStore::create_topic`].
#[derive(Debug, Clone)]
pub struct NewTopic {
    pub topic_type: TopicType,
    pub repo: String,
    pub title: String,
    pub summary: String,
    pub initial_state: String,
    pub status: Option<Status>,
    pub tags: Vec<String>,
    pub creator_email: String,
    pub creator_agent: Option<String>,
}

/// Input to [`LedgerStore::append_event`].
#[derive(Debug, Clone)]
pub struct NewEvent {
    pub topic_id: String,
    pub body: String,
    pub kind: EventKind,
    pub set_state: Option<String>,
    pub set_status: Option<Status>,
    /// Amend the topic's title. Rejected when blank: a topic with no handle is
    /// worse than one with a stale handle.
    pub set_title: Option<String>,
    /// Replace the topic's tag set **wholesale** — this is not an add or a
    /// remove, so a caller adding one tag sends the full list. An empty vec is
    /// a legitimate value (clear every tag); `None` leaves them untouched.
    pub set_tags: Option<Vec<String>>,
    /// If set, this topic supersedes `other`: a bidirectional link is written and
    /// `other`'s status is flipped to `superseded`.
    pub supersedes: Option<String>,
    pub author_email: String,
    pub author_agent: Option<String>,
}

// ---- Store ------------------------------------------------------------------

/// Handle to the ledger SQLite database. Cheap to clone (wraps a pool).
#[derive(Clone)]
pub struct LedgerStore {
    pool: SqlitePool,
}

impl LedgerStore {
    /// Open (creating if missing) the ledger DB at `path` in WAL mode and ensure
    /// the schema exists. Safe for concurrent readers + a writer (WAL).
    pub async fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let opts = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true)
            .busy_timeout(std::time::Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(opts)
            .await?;
        let store = Self { pool };
        store.init_schema().await?;
        Ok(store)
    }

    async fn init_schema(&self) -> Result<()> {
        // Statements are idempotent; run them on every open so a fresh DB is
        // handled without a separate migration step.
        sqlx::query(SCHEMA_SQL).execute(&self.pool).await?;
        // Column adds for DBs created before these columns existed. SQLite has no
        // `ADD COLUMN IF NOT EXISTS`, so run the ALTER and tolerate the
        // "duplicate column name" error a fresh DB (already has them) returns.
        for stmt in [
            "ALTER TABLE topics ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE topics ADD COLUMN archived_at TEXT",
            // `old_repo`/`old_seq` let next-seq allocation see retired ids so a moved
            // id is never handed out again (see `next_seq`).
            "ALTER TABLE moves ADD COLUMN old_repo TEXT",
            "ALTER TABLE moves ADD COLUMN old_seq INTEGER",
            // Amendable metadata (title/tags): the new value is recorded on the
            // event that made the change, so an amendment is never silent.
            "ALTER TABLE events ADD COLUMN new_title TEXT",
            "ALTER TABLE events ADD COLUMN new_tags TEXT",
        ] {
            if let Err(e) = sqlx::query(stmt).execute(&self.pool).await {
                if !e.to_string().contains("duplicate column name") {
                    return Err(e.into());
                }
            }
        }
        Ok(())
    }

    /// Create a new topic. Allocates `{repo}-{seq}` atomically and records the
    /// initial state as the first monologue event.
    pub async fn create_topic(&self, new: NewTopic) -> Result<Topic> {
        let now = now_iso();
        let status = new
            .status
            .unwrap_or_else(|| new.topic_type.default_status());
        let tags_json = serde_json::to_string(&new.tags)?;

        let mut tx = self.pool.begin().await?;
        let seq = next_seq(&mut tx, &new.repo).await?;
        let topic_id = format!("{}-{:04}", new.repo, seq);

        sqlx::query(
            "INSERT INTO topics (topic_id, seq, type, repo, title, summary, current_state, \
             status, created_at, updated_at, creator_email, creator_agent, tags) \
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(&topic_id)
        .bind(seq)
        .bind(new.topic_type.as_str())
        .bind(&new.repo)
        .bind(&new.title)
        .bind(&new.summary)
        .bind(&new.initial_state)
        .bind(status.as_str())
        .bind(&now)
        .bind(&now)
        .bind(&new.creator_email)
        .bind(&new.creator_agent)
        .bind(&tags_json)
        .execute(&mut *tx)
        .await?;

        // Seed the monologue with the initial state so the log is never empty.
        sqlx::query(
            "INSERT INTO events (topic_id, ts, author_email, author_agent, kind, body, \
             new_state, new_status) VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(&topic_id)
        .bind(&now)
        .bind(&new.creator_email)
        .bind(&new.creator_agent)
        .bind(EventKind::Note.as_str())
        .bind(&new.initial_state)
        .bind(Option::<String>::None)
        .bind(Option::<String>::None)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;

        self.get_topic(&topic_id)
            .await?
            .map(|r| r.topic)
            .ok_or_else(|| Error::Ledger("topic vanished after create".into()))
    }

    /// Append a monologue event, atomically applying any state/status/metadata/link
    /// change.
    ///
    /// Every mutable field of a topic moves through here and nowhere else, so the
    /// log always explains the change: `set_state` and `set_status` for where the
    /// topic stands, `set_title` and `set_tags` for its handle and its filing.
    /// The value each one installed is recorded on the event that installed it,
    /// which is what keeps an amendment from being a silent rewrite.
    ///
    /// `summary` is deliberately absent from that list — see [`Topic::summary`].
    pub async fn append_event(&self, new: NewEvent) -> Result<Event> {
        let now = now_iso();
        let mut tx = self.pool.begin().await?;

        // Topic must exist.
        let exists: Option<String> =
            sqlx::query_scalar("SELECT topic_id FROM topics WHERE topic_id = ?")
                .bind(&new.topic_id)
                .fetch_optional(&mut *tx)
                .await?;
        if exists.is_none() {
            return Err(Error::Ledger(format!("unknown topic {:?}", new.topic_id)));
        }

        let new_state = new.set_state.clone();
        let new_status = new.set_status.map(|s| s.as_str().to_string());

        // A blank title would leave the topic with no handle at all, which is
        // worse than the stale one the caller is trying to replace. Tags carry
        // no such floor: clearing every tag is a legitimate amendment.
        let new_title = match new.set_title.as_deref().map(str::trim) {
            Some("") => return Err(Error::Ledger("set_title must not be blank".into())),
            Some(title) => Some(title.to_string()),
            None => None,
        };
        let new_tags = new.set_tags.clone();
        let new_tags_json = match &new_tags {
            Some(tags) => Some(serde_json::to_string(tags)?),
            None => None,
        };

        let event_id: i64 = sqlx::query_scalar(
            "INSERT INTO events (topic_id, ts, author_email, author_agent, kind, body, \
             new_state, new_status, new_title, new_tags) \
             VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING event_id",
        )
        .bind(&new.topic_id)
        .bind(&now)
        .bind(&new.author_email)
        .bind(&new.author_agent)
        .bind(new.kind.as_str())
        .bind(&new.body)
        .bind(&new_state)
        .bind(&new_status)
        .bind(&new_title)
        .bind(&new_tags_json)
        .fetch_one(&mut *tx)
        .await?;

        if let Some(state) = &new_state {
            sqlx::query("UPDATE topics SET current_state = ?, updated_at = ? WHERE topic_id = ?")
                .bind(state)
                .bind(&now)
                .bind(&new.topic_id)
                .execute(&mut *tx)
                .await?;
        }
        if let Some(status) = &new_status {
            sqlx::query("UPDATE topics SET status = ?, updated_at = ? WHERE topic_id = ?")
                .bind(status)
                .bind(&now)
                .bind(&new.topic_id)
                .execute(&mut *tx)
                .await?;
        }
        if let Some(title) = &new_title {
            sqlx::query("UPDATE topics SET title = ?, updated_at = ? WHERE topic_id = ?")
                .bind(title)
                .bind(&now)
                .bind(&new.topic_id)
                .execute(&mut *tx)
                .await?;
        }
        if let Some(tags) = &new_tags_json {
            sqlx::query("UPDATE topics SET tags = ?, updated_at = ? WHERE topic_id = ?")
                .bind(tags)
                .bind(&now)
                .bind(&new.topic_id)
                .execute(&mut *tx)
                .await?;
        }
        if let Some(other) = &new.supersedes {
            let other_exists: Option<String> =
                sqlx::query_scalar("SELECT topic_id FROM topics WHERE topic_id = ?")
                    .bind(other)
                    .fetch_optional(&mut *tx)
                    .await?;
            if other_exists.is_none() {
                return Err(Error::Ledger(format!(
                    "cannot supersede unknown topic {other:?}"
                )));
            }
            insert_link(&mut tx, &new.topic_id, LinkRel::Supersedes, other).await?;
            insert_link(&mut tx, other, LinkRel::SupersededBy, &new.topic_id).await?;
            // The superseded topic is, by definition, no longer the way forward.
            sqlx::query("UPDATE topics SET status = ?, updated_at = ? WHERE topic_id = ?")
                .bind(Status::Superseded.as_str())
                .bind(&now)
                .bind(other)
                .execute(&mut *tx)
                .await?;
        }

        // Any append counts as activity.
        sqlx::query("UPDATE topics SET updated_at = ? WHERE topic_id = ?")
            .bind(&now)
            .bind(&new.topic_id)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;

        Ok(Event {
            event_id,
            ts: now,
            author_email: new.author_email,
            author_agent: new.author_agent,
            kind: new.kind,
            body: new.body,
            new_state,
            new_status,
            new_title,
            new_tags,
        })
    }

    /// Fetch the full record (topic + monologue + links) for `topic_id`.
    pub async fn get_topic(&self, topic_id: &str) -> Result<Option<TopicRecord>> {
        let Some(row) =
            sqlx::query_as::<_, TopicRowRaw>(&format!("SELECT {TOPIC_COLS} WHERE topic_id = ?"))
                .bind(topic_id)
                .fetch_optional(&self.pool)
                .await?
        else {
            return Ok(None);
        };
        let topic = row.into_topic()?;
        let events = self.events_for(topic_id).await?;
        let links = self.links_for(topic_id).await?;
        Ok(Some(TopicRecord {
            topic,
            events,
            links,
        }))
    }

    async fn events_for(&self, topic_id: &str) -> Result<Vec<Event>> {
        let rows = sqlx::query_as::<_, EventRowRaw>(
            "SELECT event_id, ts, author_email, author_agent, kind, body, new_state, new_status, \
             new_title, new_tags FROM events WHERE topic_id = ? ORDER BY event_id",
        )
        .bind(topic_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(EventRowRaw::into_event).collect()
    }

    async fn links_for(&self, topic_id: &str) -> Result<Vec<Link>> {
        let rows = sqlx::query_as::<_, LinkRowRaw>(
            "SELECT rel, other_topic_id FROM links WHERE topic_id = ? ORDER BY rel, other_topic_id",
        )
        .bind(topic_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(LinkRowRaw::into_link).collect()
    }

    /// Every **live** topic with its events and computed whole-topic hash — the
    /// reconciler's view of the source of truth. Archived topics are deliberately
    /// excluded: the reconciler then sees them as "gone from SQLite" and purges
    /// their points from the RAG index, while the SQLite row is retained.
    pub async fn all_for_index(&self) -> Result<Vec<TopicForIndex>> {
        let rows = sqlx::query_as::<_, TopicRowRaw>(&format!(
            "SELECT {TOPIC_COLS} WHERE archived = 0 ORDER BY topic_id"
        ))
        .fetch_all(&self.pool)
        .await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let topic = row.into_topic()?;
            let events = self.events_for(&topic.topic_id).await?;
            let topic_hash = compute_topic_hash(&topic, &events);
            out.push(TopicForIndex {
                topic,
                events,
                topic_hash,
            });
        }
        Ok(out)
    }

    /// Move a topic to another project, minting a **brand-new id** (a fresh
    /// `{target_repo}-{seq}`) and rewriting the topic, its whole monologue, and
    /// every link (in both directions) onto it. The old id is deleted, so the
    /// reconciler purges its old RAG points and indexes the new id. A provenance
    /// note recording the move is appended to the relocated topic.
    pub async fn move_topic(
        &self,
        topic_id: &str,
        target_repo: &str,
        author_email: &str,
        author_agent: Option<&str>,
    ) -> Result<Topic> {
        let target_repo = target_repo.trim();
        if target_repo.is_empty() {
            return Err(Error::Ledger("target repo must not be empty".into()));
        }
        let now = now_iso();
        let mut tx = self.pool.begin().await?;

        let Some(row) =
            sqlx::query_as::<_, TopicRowRaw>(&format!("SELECT {TOPIC_COLS} WHERE topic_id = ?"))
                .bind(topic_id)
                .fetch_optional(&mut *tx)
                .await?
        else {
            return Err(Error::Ledger(format!("unknown topic {topic_id:?}")));
        };
        if row.repo == target_repo {
            return Err(Error::Ledger(format!(
                "topic {topic_id:?} is already in repo {target_repo:?}"
            )));
        }
        let old_repo = row.repo.clone();
        let old_seq: i64 = sqlx::query_scalar("SELECT seq FROM topics WHERE topic_id = ?")
            .bind(topic_id)
            .fetch_one(&mut *tx)
            .await?;

        // Allocate the next id in the destination repo (same rule as create).
        let seq = next_seq(&mut tx, target_repo).await?;
        let new_id = format!("{target_repo}-{seq:04}");

        // Insert the relocated topic first so the events/links FK to it is valid.
        // created_at is preserved (origin time); updated_at bumps to the move.
        sqlx::query(
            "INSERT INTO topics (topic_id, seq, type, repo, title, summary, current_state, \
             status, created_at, updated_at, creator_email, creator_agent, tags, archived, \
             archived_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(&new_id)
        .bind(seq)
        .bind(&row.topic_type)
        .bind(target_repo)
        .bind(&row.title)
        .bind(&row.summary)
        .bind(&row.current_state)
        .bind(&row.status)
        .bind(&row.created_at)
        .bind(&now)
        .bind(&row.creator_email)
        .bind(&row.creator_agent)
        .bind(&row.tags)
        .bind(row.archived)
        .bind(&row.archived_at)
        .execute(&mut *tx)
        .await?;

        // Repoint the monologue and both link directions onto the new id.
        sqlx::query("UPDATE events SET topic_id = ? WHERE topic_id = ?")
            .bind(&new_id)
            .bind(topic_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE links SET topic_id = ? WHERE topic_id = ?")
            .bind(&new_id)
            .bind(topic_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE links SET other_topic_id = ? WHERE other_topic_id = ?")
            .bind(&new_id)
            .bind(topic_id)
            .execute(&mut *tx)
            .await?;

        // Provenance: record the move on the relocated topic.
        sqlx::query(
            "INSERT INTO events (topic_id, ts, author_email, author_agent, kind, body, \
             new_state, new_status) VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(&new_id)
        .bind(&now)
        .bind(author_email)
        .bind(author_agent)
        .bind(EventKind::Note.as_str())
        .bind(format!(
            "Moved from {topic_id} (repo {old_repo}) to {new_id} (repo {target_repo}); id reassigned."
        ))
        .bind(Option::<String>::None)
        .bind(Option::<String>::None)
        .execute(&mut *tx)
        .await?;

        // Now nothing references the old id; drop the old topic row.
        sqlx::query("DELETE FROM topics WHERE topic_id = ?")
            .bind(topic_id)
            .execute(&mut *tx)
            .await?;

        // Leave a redirect tombstone (old id → new id). Collapse any chain first:
        // an older tombstone that pointed at the old id is repointed straight at the
        // new id, so a lookup is always a single hop even after repeated moves.
        sqlx::query("UPDATE moves SET new_topic_id = ?, moved_at = ? WHERE new_topic_id = ?")
            .bind(&new_id)
            .bind(&now)
            .bind(topic_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO moves (old_topic_id, new_topic_id, moved_at, old_repo, old_seq) \
             VALUES (?,?,?,?,?)",
        )
        .bind(topic_id)
        .bind(&new_id)
        .bind(&now)
        .bind(&old_repo)
        .bind(old_seq)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;

        self.get_topic(&new_id)
            .await?
            .map(|r| r.topic)
            .ok_or_else(|| Error::Ledger("topic vanished after move".into()))
    }

    /// Resolve a retired (moved) `old_topic_id` to where its content now lives, or
    /// `None` if the id was never moved. Single-hop: move chains are collapsed on
    /// write, so the pointer always targets the current id.
    pub async fn lookup_move(&self, old_topic_id: &str) -> Result<Option<MovePointer>> {
        let row = sqlx::query_as::<_, MoveRowRaw>(
            "SELECT new_topic_id, moved_at FROM moves WHERE old_topic_id = ?",
        )
        .bind(old_topic_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| MovePointer {
            old_topic_id: old_topic_id.to_string(),
            new_topic_id: r.new_topic_id,
            moved_at: r.moved_at,
        }))
    }

    /// Archive (soft-delete) or restore a topic. Archiving retains the SQLite row
    /// but excludes it from [`all_for_index`] (so the reconciler purges it from the
    /// RAG index) and from a normal `ledger_search`. Restoring (`archived = false`)
    /// re-indexes it. A provenance note is appended either way.
    pub async fn set_archived(
        &self,
        topic_id: &str,
        archived: bool,
        author_email: &str,
        author_agent: Option<&str>,
    ) -> Result<Topic> {
        let now = now_iso();
        let mut tx = self.pool.begin().await?;

        let exists: Option<String> =
            sqlx::query_scalar("SELECT topic_id FROM topics WHERE topic_id = ?")
                .bind(topic_id)
                .fetch_optional(&mut *tx)
                .await?;
        if exists.is_none() {
            return Err(Error::Ledger(format!("unknown topic {topic_id:?}")));
        }

        let archived_at = archived.then(|| now.clone());
        sqlx::query(
            "UPDATE topics SET archived = ?, archived_at = ?, updated_at = ? WHERE topic_id = ?",
        )
        .bind(archived as i64)
        .bind(&archived_at)
        .bind(&now)
        .bind(topic_id)
        .execute(&mut *tx)
        .await?;

        let body = if archived {
            "Archived (soft-deleted): retained in the ledger, removed from the search index."
        } else {
            "Unarchived (restored): re-indexed for search."
        };
        sqlx::query(
            "INSERT INTO events (topic_id, ts, author_email, author_agent, kind, body, \
             new_state, new_status) VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(topic_id)
        .bind(&now)
        .bind(author_email)
        .bind(author_agent)
        .bind(EventKind::Note.as_str())
        .bind(body)
        .bind(Option::<String>::None)
        .bind(Option::<String>::None)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;

        self.get_topic(topic_id)
            .await?
            .map(|r| r.topic)
            .ok_or_else(|| Error::Ledger("topic vanished after archive".into()))
    }

    /// Substring search over **archived** topics — the path behind a
    /// `ledger_search` with `archived = true`. Archived topics are absent from the
    /// RAG index, so this is a plain SQL `LIKE` over title/summary/current_state
    /// (not semantic), with optional repo/type/status filters. An empty query
    /// lists the most recently archived topics.
    pub async fn search_archived(
        &self,
        query: &str,
        repo: Option<&str>,
        topic_type: Option<&str>,
        status: Option<&str>,
        limit: i64,
    ) -> Result<Vec<Topic>> {
        let q = query.trim();
        let like = format!("%{q}%");
        let mut sql = format!("SELECT {TOPIC_COLS} WHERE archived = 1");
        let mut binds: Vec<String> = Vec::new();
        if !q.is_empty() {
            sql.push_str(" AND (title LIKE ? OR summary LIKE ? OR current_state LIKE ?)");
            binds.push(like.clone());
            binds.push(like.clone());
            binds.push(like);
        }
        if let Some(r) = repo {
            sql.push_str(" AND repo = ?");
            binds.push(r.to_string());
        }
        if let Some(t) = topic_type {
            sql.push_str(" AND type = ?");
            binds.push(t.to_string());
        }
        if let Some(s) = status {
            sql.push_str(" AND status = ?");
            binds.push(s.to_string());
        }
        sql.push_str(" ORDER BY updated_at DESC LIMIT ?");

        let mut q_builder = sqlx::query_as::<_, TopicRowRaw>(&sql);
        for b in &binds {
            q_builder = q_builder.bind(b);
        }
        q_builder = q_builder.bind(limit.max(1));
        let rows = q_builder.fetch_all(&self.pool).await?;
        rows.into_iter().map(TopicRowRaw::into_topic).collect()
    }
}

/// Next sequence number for `repo`, never reusing a retired id. Takes the max
/// over both live topics **and** the `moves` tombstones (an id that was moved away
/// must not be handed out again — otherwise a new topic collides with the old id's
/// redirect and shadows it), so the per-repo high-water mark only ever increases.
async fn next_seq(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, repo: &str) -> Result<i64> {
    let seq: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(s), 0) + 1 FROM ( \
            SELECT seq AS s FROM topics WHERE repo = ? \
            UNION ALL \
            SELECT old_seq AS s FROM moves WHERE old_repo = ? )",
    )
    .bind(repo)
    .bind(repo)
    .fetch_one(&mut **tx)
    .await?;
    Ok(seq)
}

async fn insert_link(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    topic_id: &str,
    rel: LinkRel,
    other: &str,
) -> Result<()> {
    sqlx::query("INSERT OR IGNORE INTO links (topic_id, rel, other_topic_id) VALUES (?,?,?)")
        .bind(topic_id)
        .bind(rel.as_str())
        .bind(other)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Canonical whole-topic hash: title + summary + current_state + every event body,
/// in event order. Computed from content so it reflects reality regardless of who
/// wrote the row (MCP, a CLI, or a manual SQL edit).
pub fn compute_topic_hash(topic: &Topic, events: &[Event]) -> String {
    let mut buf = String::new();
    buf.push_str(&topic.title);
    buf.push('\n');
    buf.push_str(&topic.summary);
    buf.push('\n');
    buf.push_str(&topic.current_state);
    buf.push('\n');
    buf.push_str(topic.status.as_str());
    for e in events {
        buf.push('\n');
        buf.push_str(&e.body);
    }
    hash_str(&buf)
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

// ---- Raw row mapping --------------------------------------------------------

const TOPIC_COLS: &str = "topic_id, type AS topic_type, repo, title, summary, current_state, \
     status, created_at, updated_at, creator_email, creator_agent, tags, archived, archived_at \
     FROM topics";

#[derive(sqlx::FromRow)]
struct TopicRowRaw {
    topic_id: String,
    topic_type: String,
    repo: String,
    title: String,
    summary: String,
    current_state: String,
    status: String,
    created_at: String,
    updated_at: String,
    creator_email: String,
    creator_agent: Option<String>,
    tags: String,
    archived: i64,
    archived_at: Option<String>,
}

impl TopicRowRaw {
    fn into_topic(self) -> Result<Topic> {
        Ok(Topic {
            topic_id: self.topic_id,
            topic_type: self.topic_type.parse()?,
            repo: self.repo,
            title: self.title,
            summary: self.summary,
            current_state: self.current_state,
            status: self.status.parse()?,
            created_at: self.created_at,
            updated_at: self.updated_at,
            creator_email: self.creator_email,
            creator_agent: self.creator_agent,
            tags: serde_json::from_str(&self.tags).unwrap_or_default(),
            archived: self.archived != 0,
            archived_at: self.archived_at,
        })
    }
}

#[derive(sqlx::FromRow)]
struct EventRowRaw {
    event_id: i64,
    ts: String,
    author_email: String,
    author_agent: Option<String>,
    kind: String,
    body: String,
    new_state: Option<String>,
    new_status: Option<String>,
    new_title: Option<String>,
    new_tags: Option<String>,
}

impl EventRowRaw {
    fn into_event(self) -> Result<Event> {
        Ok(Event {
            event_id: self.event_id,
            ts: self.ts,
            author_email: self.author_email,
            author_agent: self.author_agent,
            kind: self.kind.parse()?,
            body: self.body,
            new_state: self.new_state,
            new_status: self.new_status,
            new_title: self.new_title,
            // A malformed tags blob is treated as "no amendment recorded"
            // rather than failing the read: the topic row is authoritative for
            // the current tags, and this column is provenance.
            new_tags: self
                .new_tags
                .as_deref()
                .and_then(|raw| serde_json::from_str(raw).ok()),
        })
    }
}

#[derive(sqlx::FromRow)]
struct MoveRowRaw {
    new_topic_id: String,
    moved_at: String,
}

#[derive(sqlx::FromRow)]
struct LinkRowRaw {
    rel: String,
    other_topic_id: String,
}

impl LinkRowRaw {
    fn into_link(self) -> Result<Link> {
        Ok(Link {
            rel: self.rel.parse()?,
            other_topic_id: self.other_topic_id,
        })
    }
}

const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS topics (
    topic_id      TEXT PRIMARY KEY,
    seq           INTEGER NOT NULL,
    type          TEXT NOT NULL,
    repo          TEXT NOT NULL,
    title         TEXT NOT NULL,
    summary       TEXT NOT NULL,
    current_state TEXT NOT NULL,
    status        TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    creator_email TEXT NOT NULL,
    creator_agent TEXT,
    tags          TEXT NOT NULL DEFAULT '[]',
    archived      INTEGER NOT NULL DEFAULT 0,
    archived_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_topics_repo ON topics(repo);

CREATE TABLE IF NOT EXISTS events (
    event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id     TEXT NOT NULL REFERENCES topics(topic_id),
    ts           TEXT NOT NULL,
    author_email TEXT NOT NULL,
    author_agent TEXT,
    kind         TEXT NOT NULL,
    body         TEXT NOT NULL,
    new_state    TEXT,
    new_status   TEXT,
    new_title    TEXT,
    new_tags     TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_topic ON events(topic_id);

CREATE TABLE IF NOT EXISTS links (
    topic_id       TEXT NOT NULL REFERENCES topics(topic_id),
    rel            TEXT NOT NULL,
    other_topic_id TEXT NOT NULL,
    PRIMARY KEY (topic_id, rel, other_topic_id)
);
CREATE INDEX IF NOT EXISTS idx_links_topic ON links(topic_id);

-- Redirect tombstones for moved topics: a fetch of a retired `old_topic_id`
-- points to where its content now lives. Retired ids are never reused (seq only
-- ever increases), so the mapping is permanent.
CREATE TABLE IF NOT EXISTS moves (
    old_topic_id TEXT PRIMARY KEY,
    new_topic_id TEXT NOT NULL,
    moved_at     TEXT NOT NULL,
    old_repo     TEXT,
    old_seq      INTEGER
);
";

#[cfg(test)]
mod tests {
    use super::*;

    async fn store() -> LedgerStore {
        // In-memory DB per test; each connection in the pool shares it via the URI.
        let opts = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        let s = LedgerStore { pool };
        s.init_schema().await.unwrap();
        s
    }

    fn sample_topic() -> NewTopic {
        NewTopic {
            topic_type: TopicType::Decision,
            repo: "rag".into(),
            title: "Char-based chunk sizing".into(),
            summary: "Why we size chunks by characters, not tokens.".into(),
            initial_state: "Adopted char sizing at ~4 chars/token.".into(),
            status: None,
            tags: vec!["chunking".into()],
            creator_email: "dev@example.com".into(),
            creator_agent: Some("Claude Opus 4.8".into()),
        }
    }

    #[tokio::test]
    async fn create_assigns_sequential_ids_and_default_status() {
        let s = store().await;
        let a = s.create_topic(sample_topic()).await.unwrap();
        let b = s.create_topic(sample_topic()).await.unwrap();
        assert_eq!(a.topic_id, "rag-0001");
        assert_eq!(b.topic_id, "rag-0002");
        // Decisions start "proposed".
        assert_eq!(a.status, Status::Proposed);
        // Creation seeds one monologue event.
        let rec = s.get_topic(&a.topic_id).await.unwrap().unwrap();
        assert_eq!(rec.events.len(), 1);
        assert_eq!(
            rec.topic.summary,
            "Why we size chunks by characters, not tokens."
        );
    }

    #[tokio::test]
    async fn append_updates_state_and_status_via_log() {
        let s = store().await;
        let t = s.create_topic(sample_topic()).await.unwrap();
        s.append_event(NewEvent {
            topic_id: t.topic_id.clone(),
            body: "Confirmed on the full corpus.".into(),
            kind: EventKind::StatusChange,
            set_state: Some("Locked: char sizing, calibrated to the token target.".into()),
            set_status: Some(Status::Accepted),
            set_title: None,
            set_tags: None,
            supersedes: None,
            author_email: "dev@example.com".into(),
            author_agent: None,
        })
        .await
        .unwrap();
        let rec = s.get_topic(&t.topic_id).await.unwrap().unwrap();
        assert_eq!(rec.topic.status, Status::Accepted);
        assert!(rec.topic.current_state.starts_with("Locked"));
        assert_eq!(rec.events.len(), 2);
    }

    #[tokio::test]
    async fn supersede_links_both_ways_and_flips_status() {
        let s = store().await;
        let bad = s.create_topic(sample_topic()).await.unwrap();
        let good = s.create_topic(sample_topic()).await.unwrap();
        s.append_event(NewEvent {
            topic_id: good.topic_id.clone(),
            body: "Replaces the earlier approach.".into(),
            kind: EventKind::Correction,
            set_state: None,
            set_status: Some(Status::Accepted),
            set_title: None,
            set_tags: None,
            supersedes: Some(bad.topic_id.clone()),
            author_email: "dev@example.com".into(),
            author_agent: None,
        })
        .await
        .unwrap();

        let bad_rec = s.get_topic(&bad.topic_id).await.unwrap().unwrap();
        assert_eq!(bad_rec.topic.status, Status::Superseded);
        assert_eq!(bad_rec.links[0].rel, LinkRel::SupersededBy);
        assert_eq!(bad_rec.links[0].other_topic_id, good.topic_id);

        let good_rec = s.get_topic(&good.topic_id).await.unwrap().unwrap();
        assert_eq!(good_rec.links[0].rel, LinkRel::Supersedes);
    }

    /// **An amendment is a logged change, not a silent rewrite** — the topic row
    /// carries the new value and the event that made the change carries it too,
    /// so replay reconstructs what the title and tags were at any point.
    #[tokio::test]
    async fn title_and_tags_are_amendable_and_the_event_records_it() {
        let s = store().await;
        let t = s.create_topic(sample_topic()).await.unwrap();
        let original = t.title.clone();

        s.append_event(NewEvent {
            topic_id: t.topic_id.clone(),
            body: "Retitled: the first handle described the symptom, not the cause.".into(),
            kind: EventKind::Correction,
            set_state: None,
            set_status: None,
            set_title: Some("The cause, named properly".into()),
            set_tags: Some(vec!["ledger".into(), "vocabulary".into()]),
            supersedes: None,
            author_email: "dev@example.com".into(),
            author_agent: None,
        })
        .await
        .unwrap();

        let rec = s.get_topic(&t.topic_id).await.unwrap().unwrap();
        assert_eq!(rec.topic.title, "The cause, named properly");
        assert_eq!(rec.topic.tags, vec!["ledger", "vocabulary"]);

        // The change is on the event, so history explains it.
        let amendment = rec.events.last().unwrap();
        assert_eq!(
            amendment.new_title.as_deref(),
            Some("The cause, named properly")
        );
        assert_eq!(
            amendment.new_tags.as_deref(),
            Some(["ledger".to_string(), "vocabulary".to_string()].as_slice())
        );
        // And the seed event is untouched, so the original handle is recoverable.
        assert_ne!(original, rec.topic.title);
        assert!(rec.events[0].new_title.is_none());
    }

    /// **Absent is not the same as empty.** Omitting a setter leaves the field
    /// alone; an empty tag list is a real amendment that clears them.
    #[tokio::test]
    async fn omitted_setters_leave_metadata_alone_and_empty_tags_clear_it() {
        let s = store().await;
        let t = s
            .create_topic(NewTopic {
                tags: vec!["keep".into()],
                ..sample_topic()
            })
            .await
            .unwrap();

        s.append_event(NewEvent {
            topic_id: t.topic_id.clone(),
            body: "An ordinary note.".into(),
            kind: EventKind::Note,
            set_state: None,
            set_status: None,
            set_title: None,
            set_tags: None,
            supersedes: None,
            author_email: "dev@example.com".into(),
            author_agent: None,
        })
        .await
        .unwrap();
        let rec = s.get_topic(&t.topic_id).await.unwrap().unwrap();
        assert_eq!(
            rec.topic.title, t.title,
            "an ordinary note must not retitle"
        );
        assert_eq!(rec.topic.tags, vec!["keep"]);

        s.append_event(NewEvent {
            topic_id: t.topic_id.clone(),
            body: "Refiled: the tag was wrong.".into(),
            kind: EventKind::Correction,
            set_state: None,
            set_status: None,
            set_title: None,
            set_tags: Some(vec![]),
            supersedes: None,
            author_email: "dev@example.com".into(),
            author_agent: None,
        })
        .await
        .unwrap();
        let rec = s.get_topic(&t.topic_id).await.unwrap().unwrap();
        assert!(rec.topic.tags.is_empty(), "an empty list clears the tags");
    }

    /// A blank title is refused: a topic with no handle at all is worse than one
    /// with a stale handle, and the amendment is otherwise irreversible.
    #[tokio::test]
    async fn a_blank_title_is_refused() {
        let s = store().await;
        let t = s.create_topic(sample_topic()).await.unwrap();
        let err = s
            .append_event(NewEvent {
                topic_id: t.topic_id.clone(),
                body: "Trying to clear the title.".into(),
                kind: EventKind::Correction,
                set_state: None,
                set_status: None,
                set_title: Some("   ".into()),
                set_tags: None,
                supersedes: None,
                author_email: "dev@example.com".into(),
                author_agent: None,
            })
            .await
            .unwrap_err();
        assert!(err.to_string().contains("set_title"), "{err}");

        let rec = s.get_topic(&t.topic_id).await.unwrap().unwrap();
        assert_eq!(rec.topic.title, t.title);
        assert_eq!(rec.events.len(), 1, "a refused amendment writes no event");
    }

    /// A retitle must reach the search index: `title` is part of the embedded
    /// topic point, so the reconciler has to see the hash move.
    #[tokio::test]
    async fn a_retitle_moves_the_topic_hash() {
        let s = store().await;
        let t = s.create_topic(sample_topic()).await.unwrap();
        let before = s.all_for_index().await.unwrap()[0].topic_hash.clone();
        s.append_event(NewEvent {
            topic_id: t.topic_id.clone(),
            body: "Retitled.".into(),
            kind: EventKind::Correction,
            set_state: None,
            set_status: None,
            set_title: Some("A better handle".into()),
            set_tags: None,
            supersedes: None,
            author_email: "dev@example.com".into(),
            author_agent: None,
        })
        .await
        .unwrap();
        assert_ne!(before, s.all_for_index().await.unwrap()[0].topic_hash);
    }

    #[tokio::test]
    async fn topic_hash_changes_with_content() {
        let s = store().await;
        let t = s.create_topic(sample_topic()).await.unwrap();
        let before = s.all_for_index().await.unwrap();
        let h1 = &before[0].topic_hash;
        s.append_event(NewEvent {
            topic_id: t.topic_id.clone(),
            body: "A new finding.".into(),
            kind: EventKind::Note,
            set_state: None,
            set_status: None,
            set_title: None,
            set_tags: None,
            supersedes: None,
            author_email: "dev@example.com".into(),
            author_agent: None,
        })
        .await
        .unwrap();
        let after = s.all_for_index().await.unwrap();
        assert_ne!(
            h1, &after[0].topic_hash,
            "hash must move when an event is added"
        );
    }

    #[tokio::test]
    async fn move_reassigns_id_and_repo_preserving_history() {
        let s = store().await;
        let t = s.create_topic(sample_topic()).await.unwrap();
        assert_eq!(t.topic_id, "rag-0001");
        // Pre-existing topic in the destination repo so the new id is -0002, proving
        // the number component is freshly allocated (not carried across).
        s.create_topic(NewTopic {
            repo: "webapp".into(),
            ..sample_topic()
        })
        .await
        .unwrap();

        let moved = s
            .move_topic(&t.topic_id, "webapp", "dev@example.com", Some("Tester"))
            .await
            .unwrap();
        assert_eq!(moved.topic_id, "webapp-0002");
        assert_eq!(moved.repo, "webapp");

        // Old id is gone; new id carries the seeded event + the move note.
        assert!(s.get_topic("rag-0001").await.unwrap().is_none());
        let rec = s.get_topic("webapp-0002").await.unwrap().unwrap();
        assert_eq!(rec.events.len(), 2);
        assert!(rec.events[1].body.contains("Moved from rag-0001"));

        // Moving within the same repo is rejected.
        assert!(s
            .move_topic("webapp-0002", "webapp", "dev@example.com", None)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn move_leaves_redirect_tombstone_and_collapses_chains() {
        let s = store().await;
        let t = s.create_topic(sample_topic()).await.unwrap();
        assert_eq!(t.topic_id, "rag-0001");

        // rag-0001 → alpha-0001
        s.move_topic("rag-0001", "alpha", "dev@example.com", None)
            .await
            .unwrap();
        let p = s.lookup_move("rag-0001").await.unwrap().unwrap();
        assert_eq!(p.new_topic_id, "alpha-0001");
        // A non-moved id resolves to nothing.
        assert!(s.lookup_move("rag-9999").await.unwrap().is_none());

        // alpha-0001 → beta-0001: the original rag-0001 pointer must collapse to beta.
        s.move_topic("alpha-0001", "beta", "dev@example.com", None)
            .await
            .unwrap();
        assert_eq!(
            s.lookup_move("rag-0001")
                .await
                .unwrap()
                .unwrap()
                .new_topic_id,
            "beta-0001",
            "chain must collapse so the original id points straight at the final id"
        );
        assert_eq!(
            s.lookup_move("alpha-0001")
                .await
                .unwrap()
                .unwrap()
                .new_topic_id,
            "beta-0001"
        );
    }

    #[tokio::test]
    async fn move_does_not_free_the_seq_for_reuse() {
        let s = store().await;
        let _a = s.create_topic(sample_topic()).await.unwrap(); // rag-0001
        let b = s.create_topic(sample_topic()).await.unwrap(); // rag-0002 (highest)
                                                               // Move the highest-seq topic out of `rag`, freeing seq 2 in the live table.
        s.move_topic(&b.topic_id, "elsewhere", "dev@example.com", None)
            .await
            .unwrap();
        // The next `rag` topic must NOT reuse 0002 (which would collide with the
        // tombstone and shadow rag-0002's redirect).
        let c = s.create_topic(sample_topic()).await.unwrap();
        assert_eq!(
            c.topic_id, "rag-0003",
            "a moved-away seq must never be reused"
        );
    }

    #[tokio::test]
    async fn move_repoints_inbound_supersede_links() {
        let s = store().await;
        let bad = s.create_topic(sample_topic()).await.unwrap();
        let good = s.create_topic(sample_topic()).await.unwrap();
        s.append_event(NewEvent {
            topic_id: good.topic_id.clone(),
            body: "Replaces it.".into(),
            kind: EventKind::Correction,
            set_state: None,
            set_status: None,
            set_title: None,
            set_tags: None,
            supersedes: Some(bad.topic_id.clone()),
            author_email: "dev@example.com".into(),
            author_agent: None,
        })
        .await
        .unwrap();

        // Move the superseded topic to another repo; the link from `good` must follow.
        let moved = s
            .move_topic(&bad.topic_id, "archive-repo", "dev@example.com", None)
            .await
            .unwrap();
        let good_rec = s.get_topic(&good.topic_id).await.unwrap().unwrap();
        assert_eq!(good_rec.links[0].other_topic_id, moved.topic_id);
        let moved_rec = s.get_topic(&moved.topic_id).await.unwrap().unwrap();
        assert_eq!(moved_rec.links[0].rel, LinkRel::SupersededBy);
        assert_eq!(moved_rec.links[0].other_topic_id, good.topic_id);
    }

    #[tokio::test]
    async fn archive_hides_from_index_and_is_reversible() {
        let s = store().await;
        let t = s.create_topic(sample_topic()).await.unwrap();
        assert_eq!(s.all_for_index().await.unwrap().len(), 1);

        let arch = s
            .set_archived(&t.topic_id, true, "dev@example.com", None)
            .await
            .unwrap();
        assert!(arch.archived);
        assert!(arch.archived_at.is_some());
        // Excluded from the reconciler's view → purged from RAG.
        assert!(s.all_for_index().await.unwrap().is_empty());
        // But still fetchable by id and via the archived search path.
        assert!(s.get_topic(&t.topic_id).await.unwrap().is_some());
        let hits = s
            .search_archived("chunk", None, None, None, 50)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].topic_id, t.topic_id);

        // Restore re-includes it.
        let restored = s
            .set_archived(&t.topic_id, false, "dev@example.com", None)
            .await
            .unwrap();
        assert!(!restored.archived);
        assert!(restored.archived_at.is_none());
        assert_eq!(s.all_for_index().await.unwrap().len(), 1);
        assert!(s
            .search_archived("", None, None, None, 50)
            .await
            .unwrap()
            .is_empty());
    }
}
