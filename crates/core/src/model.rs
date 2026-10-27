//! The shared data model: one Qdrant point per chunk.
//!
//! This struct is the canonical definition of the Qdrant payload shape.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ids;

/// Which corpus a chunk belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Corpus {
    Code,
    Wiki,
    /// The decision/incident ledger (derived from the SQLite source of truth).
    Ledger,
    /// The tracker's documents and queue items (derived from `tracker.db`;
    /// `specs/tracker/master.md` D13).
    Tracker,
}

impl Corpus {
    pub fn as_str(self) -> &'static str {
        match self {
            Corpus::Code => "code",
            Corpus::Wiki => "wiki",
            Corpus::Ledger => "ledger",
            Corpus::Tracker => "tracker",
        }
    }

    /// Parse a corpus name; returns `None` for unknown values.
    pub fn from_name(s: &str) -> Option<Self> {
        match s {
            "code" => Some(Corpus::Code),
            "wiki" => Some(Corpus::Wiki),
            "ledger" => Some(Corpus::Ledger),
            "tracker" => Some(Corpus::Tracker),
            _ => None,
        }
    }
}

/// The payload stored alongside each vector in Qdrant. Every field here is
/// retrievable by the agent or usable as a filter; the ⛁ fields in the spec
/// get payload indexes (created in Phase 02).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkPayload {
    /// `code` | `wiki`.
    pub corpus: Corpus,
    /// Repository / top-level project name.
    pub repo: String,
    /// Absolute path to the source file.
    pub path: String,
    /// Path relative to the repo root.
    pub rel_path: String,
    /// Detected language (`rust`, `python`, `markdown`, …).
    pub language: String,
    /// Ordinal of this chunk within its source file.
    pub chunk_index: u32,
    /// 1-based inclusive line range in the source file (provenance).
    pub start_line: u32,
    pub end_line: u32,
    /// Hash of this chunk's text — change detection / idempotency.
    pub content_hash: String,
    /// Hash of the whole source file — fast skip of unchanged files.
    pub file_hash: String,
    /// The chunk content, returned to the agent.
    pub text: String,
    /// Source file modification time (unix seconds).
    pub mtime: i64,
}

/// A chunk paired with its deterministic Qdrant point ID.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub id: Uuid,
    pub payload: ChunkPayload,
}

/// Whether a ledger point represents the topic itself (title + summary + state)
/// or a single monologue event. Both share the topic's `topic_id`/`topic_hash`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LedgerPointKind {
    Topic,
    Event,
}

impl LedgerPointKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LedgerPointKind::Topic => "topic",
            LedgerPointKind::Event => "event",
        }
    }
}

/// The payload stored alongside a ledger vector in Qdrant. Lives in the same
/// `rag_corpus` collection as `ChunkPayload`, distinguished by `corpus = ledger`.
/// `topic_hash` is the whole-topic content hash used for incremental reconcile;
/// `content_hash` is this point's own text hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LedgerPayload {
    /// Always [`Corpus::Ledger`].
    pub corpus: Corpus,
    /// Project this topic belongs to (repo name).
    pub repo: String,
    /// Stable human-citable topic id, e.g. `rag-0042`.
    pub topic_id: String,
    /// Topic type: `decision` | `incident` | `defect` | `investigation`.
    #[serde(rename = "type")]
    pub topic_type: String,
    /// Lifecycle status (e.g. `open`, `accepted`, `superseded`).
    pub status: String,
    /// Topic title (same on every point of a topic).
    pub title: String,
    /// The embedded text: title+summary+state for a topic point, event body for an event point.
    pub text: String,
    /// `topic` | `event`.
    pub point_kind: String,
    /// Hash of this point's `text` (idempotency at point granularity).
    pub content_hash: String,
    /// Hash of the whole topic's content — drives the reconcile diff.
    pub topic_hash: String,
}

/// A ledger point paired with its deterministic Qdrant point ID.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerPoint {
    pub id: Uuid,
    pub payload: LedgerPayload,
}

/// Whether a tracker point is a chunk of a document or a whole queue item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackerPointKind {
    Document,
    Item,
}

impl TrackerPointKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TrackerPointKind::Document => "document",
            TrackerPointKind::Item => "item",
        }
    }
}

/// The payload stored alongside a tracker vector in Qdrant, in the same
/// `rag_corpus` collection, distinguished by `corpus = tracker`.
///
/// A *unit* is what is replaced together: one document (all its chunks) or one
/// item (one point). `tracker_id` names the unit (`ubu-d0007`, `ubu-t0042`) and
/// `tracker_hash` is its whole content hash, which drives the reconcile diff, as
/// `topic_id`/`topic_hash` do for the ledger. There is deliberately **no `path` or
/// `file_hash`**: those are the corpus sync's keys, and a point carrying them would
/// look like a deleted file to an unscoped `rag-ingest run`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackerPayload {
    /// Always [`Corpus::Tracker`].
    pub corpus: Corpus,
    /// The project (a repository name), so `repo` filters work across corpora.
    pub repo: String,
    /// The document's path within its project (`specs/tracker/master.md`), or an
    /// item's id. Cited, and what `path_prefix` filters on.
    pub rel_path: String,
    /// Always `markdown`: documents and item bodies are markdown.
    pub language: String,
    /// The unit: a document id (`ubu-d0007`) or an item id (`ubu-t0042`).
    pub tracker_id: String,
    /// `document` | `item`.
    pub point_kind: String,
    /// A document's kind (`spec`, `milestone`, `concept`, `doc`), or `item`.
    pub kind: String,
    /// An item's type (`dev`, `design`, …); absent on documents.
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub item_type: Option<String>,
    /// An item's status; absent on documents.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// The document's or item's title.
    pub title: String,
    /// The document revision this chunk is from; absent on items.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,
    /// `<project>:<path>@r<revision>` for a document, the item id for an item.
    pub citation: String,
    /// Ordinal of this chunk within its unit.
    pub chunk_index: u32,
    /// 1-based inclusive line range within the document body (`0` on items).
    pub start_line: u32,
    pub end_line: u32,
    /// The embedded text.
    pub text: String,
    /// Hash of this point's `text`.
    pub content_hash: String,
    /// Hash of the whole unit's content — drives the reconcile diff.
    pub tracker_hash: String,
}

/// A tracker point paired with its deterministic Qdrant point ID.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackerPoint {
    pub id: Uuid,
    pub payload: TrackerPayload,
}

/// A retrieval result: a chunk with its similarity score and provenance.
///
/// The `topic_*` fields are populated only for `corpus = ledger` hits; `status`
/// and `title` for ledger and tracker hits; `citation`, `tracker_id`, `kind` and
/// `revision` for tracker hits. They are `None`/empty for code and wiki hits.
#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub score: f32,
    pub corpus: String,
    pub repo: String,
    pub path: String,
    pub rel_path: String,
    pub language: String,
    pub start_line: u32,
    pub end_line: u32,
    pub text: String,
    /// Ledger topic id (ledger hits only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic_id: Option<String>,
    /// Ledger topic type (ledger hits only). Serialised as `type` to match the input.
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub topic_type: Option<String>,
    /// Ledger topic status (ledger hits only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Ledger topic title (ledger hits only). Present on every point of a topic,
    /// including its event points, so a hit can always be labelled — `text` can't
    /// serve that purpose (an event hit is mid-monologue prose, not a heading).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// How to cite a tracker hit (tracker hits only): `<project>:<path>@r<revision>`
    /// for a document chunk, the item id for an item.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citation: Option<String>,
    /// The tracker document or item id (tracker hits only): what `tracker_get`
    /// and `tracker_doc_get` take.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracker_id: Option<String>,
    /// A tracker document's kind (`spec`, `milestone`, `concept`, `doc`) or `item`
    /// (tracker hits only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// The tracker document revision the chunk is from (document hits only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,
}

/// Payload filters narrowing a search. `corpus`/`repo`/`language` map to Qdrant
/// keyword filters (indexed fields); `path_prefix` is applied as a post-filter on
/// `rel_path` (there is no keyword index on it).
#[derive(Debug, Clone, Default)]
pub struct SearchFilters {
    pub corpus: Option<Corpus>,
    pub repo: Option<String>,
    pub language: Option<String>,
    pub path_prefix: Option<String>,
    /// The `type` payload filter: a ledger topic's type or a tracker item's type.
    pub topic_type: Option<String>,
    /// The `status` payload filter: a ledger topic's or a tracker item's status.
    pub status: Option<String>,
}

/// A ranked, citable result. `ann_score` is the vector similarity; `rerank_score`
/// is present only when reranking ran. The portable citation is
/// `repo` + `rel_path` + `start_line`/`end_line` — `path` is the indexer's
/// internal (container) view and is included only for completeness.
#[derive(Debug, Clone, Serialize)]
pub struct RankedHit {
    pub corpus: String,
    pub repo: String,
    pub rel_path: String,
    pub path: String,
    pub language: String,
    pub start_line: u32,
    pub end_line: u32,
    pub text: String,
    pub ann_score: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rerank_score: Option<f32>,
    /// Ledger topic id (ledger hits only) — the portable citation for ledger results.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic_id: Option<String>,
    /// Ledger topic type (ledger hits only). Serialised as `type` to match the input.
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub topic_type: Option<String>,
    /// Ledger topic status (ledger hits only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Ledger topic title (ledger hits only) — the display label for the hit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// How to cite a tracker hit (tracker hits only): `<project>:<path>@r<revision>`
    /// for a document chunk, the item id for an item.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citation: Option<String>,
    /// The tracker document or item id (tracker hits only): what `tracker_get`
    /// and `tracker_doc_get` take.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracker_id: Option<String>,
    /// A tracker document's kind (`spec`, `milestone`, `concept`, `doc`) or `item`
    /// (tracker hits only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// The tracker document revision the chunk is from (document hits only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,
}

impl RankedHit {
    /// Build a ranked hit from a search hit, attaching an optional rerank score.
    pub fn from_hit(h: &SearchHit, rerank_score: Option<f32>) -> Self {
        Self {
            corpus: h.corpus.clone(),
            repo: h.repo.clone(),
            rel_path: h.rel_path.clone(),
            path: h.path.clone(),
            language: h.language.clone(),
            start_line: h.start_line,
            end_line: h.end_line,
            text: h.text.clone(),
            ann_score: h.score,
            rerank_score,
            topic_id: h.topic_id.clone(),
            topic_type: h.topic_type.clone(),
            status: h.status.clone(),
            title: h.title.clone(),
            citation: h.citation.clone(),
            tracker_id: h.tracker_id.clone(),
            kind: h.kind.clone(),
            revision: h.revision,
        }
    }
}

impl Chunk {
    /// Build a chunk, deriving the deterministic point ID from `path#chunk_index`.
    pub fn new(payload: ChunkPayload) -> Self {
        let id = ids::chunk_id(&payload.path, payload.chunk_index);
        Self { id, payload }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_payload() -> ChunkPayload {
        ChunkPayload {
            corpus: Corpus::Code,
            repo: "rag".to_string(),
            path: "/work/corpus/rag/crates/core/src/model.rs".to_string(),
            rel_path: "crates/core/src/model.rs".to_string(),
            language: "rust".to_string(),
            chunk_index: 3,
            start_line: 10,
            end_line: 42,
            content_hash: "abc123".to_string(),
            file_hash: "def456".to_string(),
            text: "fn main() {}".to_string(),
            mtime: 1_700_000_000,
        }
    }

    #[test]
    fn payload_serde_round_trips() {
        let payload = sample_payload();
        let value = serde_json::to_value(&payload).expect("serialize");
        // Corpus serialises to its lowercase string form.
        assert_eq!(value["corpus"], "code");
        let back: ChunkPayload = serde_json::from_value(value).expect("deserialize");
        assert_eq!(payload, back);
    }

    #[test]
    fn chunk_id_is_deterministic() {
        let a = Chunk::new(sample_payload());
        let b = Chunk::new(sample_payload());
        assert_eq!(a.id, b.id, "same path + index must yield the same point ID");

        let mut other = sample_payload();
        other.chunk_index = 4;
        let c = Chunk::new(other);
        assert_ne!(
            a.id, c.id,
            "different chunk index must yield a different ID"
        );
    }
}
