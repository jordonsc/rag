//! Thin wrapper around the official `qdrant-client` crate.
//!
//! Phase 01 covers construction and basic health/existence checks. Collection
//! bootstrap and upsert/search land in Phases 02 and 04/05.

use std::collections::HashMap;

use qdrant_client::qdrant::value::Kind;
use qdrant_client::qdrant::with_payload_selector::SelectorOptions;
use qdrant_client::qdrant::{
    Condition, CreateCollectionBuilder, CreateFieldIndexCollectionBuilder, DeletePointsBuilder,
    Distance, FieldType, Filter, PayloadIncludeSelector, PointStruct, QuantizationType,
    ScalarQuantizationBuilder, ScrollPointsBuilder, SearchPointsBuilder, UpsertPointsBuilder,
    Value, VectorParamsBuilder,
};
use qdrant_client::{Payload, Qdrant};

use crate::config::QdrantConfig;
use crate::error::{Error, Result};
use crate::model::{Chunk, Corpus, LedgerPoint, SearchFilters, SearchHit, TrackerPoint};

/// Payload fields that get a keyword index (the ⛁ fields in the data model).
/// `type`/`status` filter ledger topics and tracker items; `topic_id` backs the
/// per-topic delete of the ledger reconcile and `tracker_id` the per-unit delete
/// of the tracker reconcile. `rag-ingest init` adds a missing one to an existing
/// collection (deploy step 4).
const INDEXED_FIELDS: &[&str] = &[
    "corpus",
    "repo",
    "path",
    "language",
    "content_hash",
    "type",
    "status",
    "topic_id",
    "tracker_id",
];

/// The corpora whose points come from files (`path` + `file_hash`), i.e. the
/// ones the corpus sync owns. The ledger and the tracker are reconciled from
/// their own SQLite stores and must never be purged by the sync.
const FILE_CORPORA: &[Corpus] = &[Corpus::Code, Corpus::Wiki];

const API_KEY_ENV: &str = "QDRANT_API_KEY";

/// Stands in for a hash in [`VectorStore::index_file_hashes`] /
/// [`VectorStore::ledger_topic_hashes`] when one path (or topic) carries points of
/// more than one hash. That happens only when a run stopped between writing a
/// file's new points and deleting its old ones; no real hash equals it, so the next
/// diff sees the file as changed and finishes the job.
pub const MIXED_HASH: &str = "<mixed>";

/// Record `hash` for `key`, collapsing to [`MIXED_HASH`] on disagreement.
fn note_hash(map: &mut HashMap<String, String>, key: String, hash: String) {
    match map.get_mut(&key) {
        Some(existing) if *existing != hash => *existing = MIXED_HASH.to_string(),
        Some(_) => {}
        None => {
            map.insert(key, hash);
        }
    }
}

pub struct VectorStore {
    client: Qdrant,
    collection: String,
}

impl VectorStore {
    /// Connect using config; picks up an optional `QDRANT_API_KEY` from the env.
    pub fn from_env(cfg: &QdrantConfig) -> Result<Self> {
        let api_key = std::env::var(API_KEY_ENV).ok();
        Self::connect(&cfg.url, &cfg.collection, api_key.as_deref())
    }

    /// Connect to Qdrant at `url`, targeting `collection`. `api_key` is optional
    /// (a trusted-LAN Qdrant may need none).
    pub fn connect(url: &str, collection: &str, api_key: Option<&str>) -> Result<Self> {
        let mut builder = Qdrant::from_url(url);
        if let Some(key) = api_key {
            builder = builder.api_key(key.to_string());
        }
        let client = builder.build().map_err(|e| Error::Qdrant(e.to_string()))?;
        Ok(Self {
            client,
            collection: collection.to_string(),
        })
    }

    /// The configured collection name.
    pub fn collection(&self) -> &str {
        &self.collection
    }

    /// Liveness check against the Qdrant instance.
    pub async fn health(&self) -> Result<()> {
        self.client
            .health_check()
            .await
            .map_err(|e| Error::Qdrant(e.to_string()))?;
        Ok(())
    }

    /// Whether the configured collection exists.
    pub async fn collection_exists(&self) -> Result<bool> {
        self.client
            .collection_exists(&self.collection)
            .await
            .map_err(|e| Error::Qdrant(e.to_string()))
    }

    /// Idempotently create the corpus collection: `dim`-d cosine vectors with int8
    /// scalar quantization (kept in RAM, originals on disk) and keyword payload
    /// indexes on the filterable fields.
    ///
    /// Returns `true` if it created the collection, `false` if it already existed.
    pub async fn bootstrap_collection(&self, dim: u64) -> Result<bool> {
        if self.collection_exists().await? {
            return Ok(false);
        }

        let quantization = ScalarQuantizationBuilder::default()
            .r#type(QuantizationType::Int8.into())
            .quantile(0.99)
            .always_ram(true);

        let vectors = VectorParamsBuilder::new(dim, Distance::Cosine).on_disk(true);

        let create = CreateCollectionBuilder::new(&self.collection)
            .vectors_config(vectors)
            .quantization_config(quantization);

        self.client
            .create_collection(create)
            .await
            .map_err(|e| Error::Qdrant(e.to_string()))?;

        for field in INDEXED_FIELDS {
            self.client
                .create_field_index(CreateFieldIndexCollectionBuilder::new(
                    &self.collection,
                    *field,
                    FieldType::Keyword,
                ))
                .await
                .map_err(|e| Error::Qdrant(e.to_string()))?;
        }

        Ok(true)
    }

    /// Ensure every keyword payload index exists, even on a collection created
    /// before a field was added. Idempotent: an "already exists" error is ignored,
    /// so this is safe to call from `init` on the live collection.
    pub async fn ensure_field_indexes(&self) -> Result<()> {
        for field in INDEXED_FIELDS {
            let res = self
                .client
                .create_field_index(CreateFieldIndexCollectionBuilder::new(
                    &self.collection,
                    *field,
                    FieldType::Keyword,
                ))
                .await;
            if let Err(e) = res {
                let msg = e.to_string();
                // Qdrant returns an error when the index already exists; tolerate it.
                if !msg.contains("already exists") {
                    return Err(Error::Qdrant(msg));
                }
            }
        }
        Ok(())
    }

    /// Number of points currently in the collection (0 if unreported).
    pub async fn points_count(&self) -> Result<u64> {
        let info = self
            .client
            .collection_info(&self.collection)
            .await
            .map_err(|e| Error::Qdrant(e.to_string()))?;
        Ok(info.result.and_then(|r| r.points_count).unwrap_or(0))
    }

    /// Snapshot of the index for incremental diffing: a map of `path -> file_hash`
    /// for every point, optionally restricted to one corpus and/or repo. Only the
    /// `path` and `file_hash` payload fields are fetched — no vectors/text. A path
    /// whose points disagree maps to [`MIXED_HASH`].
    pub async fn index_file_hashes(
        &self,
        corpus: Option<Corpus>,
        repo: Option<&str>,
    ) -> Result<HashMap<String, String>> {
        let filter = scope_filter(corpus, repo);
        let mut map = HashMap::new();
        let mut offset = None;
        loop {
            let include = SelectorOptions::Include(PayloadIncludeSelector {
                fields: vec!["path".to_string(), "file_hash".to_string()],
            });
            let mut builder = ScrollPointsBuilder::new(&self.collection)
                .limit(2048)
                .with_payload(include)
                .with_vectors(false);
            if let Some(f) = &filter {
                builder = builder.filter(f.clone());
            }
            if let Some(o) = offset.take() {
                builder = builder.offset(o);
            }
            let resp = self
                .client
                .scroll(builder)
                .await
                .map_err(|e| Error::Qdrant(e.to_string()))?;
            for point in resp.result {
                let path = payload_str(&point.payload, "path");
                let hash = payload_str(&point.payload, "file_hash");
                if let (Some(p), Some(h)) = (path, hash) {
                    note_hash(&mut map, p, h);
                }
            }
            match resp.next_page_offset {
                Some(o) => offset = Some(o),
                None => break,
            }
        }
        Ok(map)
    }

    /// Delete all points for a given source file path. Returns once committed.
    pub async fn delete_by_path(&self, path: &str) -> Result<()> {
        self.delete_by_field("path", path).await
    }

    /// Delete a file's points that do **not** carry `keep_hash` — the stale points
    /// of an earlier version, removed only after the new version's points are
    /// written. Point ids are `path#chunk_index`, so the new points have already
    /// overwritten the old ones at the same indices; this removes the old tail and
    /// any leftovers from an interrupted run.
    pub async fn delete_path_except_hash(&self, path: &str, keep_hash: &str) -> Result<()> {
        self.delete_except("path", path, "file_hash", keep_hash)
            .await
    }

    /// Delete a ledger topic's points that do not carry `keep_hash` (its
    /// `topic_hash`) — the same write-then-prune order as
    /// [`Self::delete_path_except_hash`].
    pub async fn delete_topic_except_hash(&self, topic_id: &str, keep_hash: &str) -> Result<()> {
        self.delete_except("topic_id", topic_id, "topic_hash", keep_hash)
            .await
    }

    async fn delete_except(
        &self,
        field: &str,
        value: &str,
        hash_field: &str,
        keep_hash: &str,
    ) -> Result<()> {
        let filter = except_filter(field, value, hash_field, keep_hash);
        self.client
            .delete_points(
                DeletePointsBuilder::new(&self.collection)
                    .points(filter)
                    .wait(true),
            )
            .await
            .map_err(|e| Error::Qdrant(e.to_string()))?;
        Ok(())
    }

    /// Delete a repo's **file** points (`code`/`wiki`), used by the corpus sync to
    /// purge archived/removed repos. The ledger's and the tracker's points for a
    /// project of the same name are left alone: they come from their own stores,
    /// and purging them here would only make their reconcile re-embed them on its
    /// next run, every run.
    pub async fn delete_by_repo(&self, repo: &str) -> Result<()> {
        self.client
            .delete_points(
                DeletePointsBuilder::new(&self.collection)
                    .points(repo_files_filter(repo))
                    .wait(true),
            )
            .await
            .map_err(|e| Error::Qdrant(e.to_string()))?;
        Ok(())
    }

    async fn delete_by_field(&self, field: &str, value: &str) -> Result<()> {
        let filter = Filter::must([Condition::matches(field, value.to_string())]);
        self.client
            .delete_points(
                DeletePointsBuilder::new(&self.collection)
                    .points(filter)
                    .wait(true),
            )
            .await
            .map_err(|e| Error::Qdrant(e.to_string()))?;
        Ok(())
    }

    /// Upsert chunks with their embeddings. `chunks[i]` pairs with `vectors[i]`.
    pub async fn upsert_chunks(&self, chunks: &[Chunk], vectors: &[Vec<f32>]) -> Result<()> {
        let mut points = Vec::with_capacity(chunks.len());
        for (chunk, vector) in chunks.iter().zip(vectors) {
            let value = serde_json::to_value(&chunk.payload)?;
            let payload = Payload::try_from(value)
                .map_err(|e| Error::Qdrant(format!("payload conversion: {e}")))?;
            points.push(PointStruct::new(
                chunk.id.to_string(),
                vector.clone(),
                payload,
            ));
        }
        self.client
            .upsert_points(UpsertPointsBuilder::new(&self.collection, points).wait(true))
            .await
            .map_err(|e| Error::Qdrant(e.to_string()))?;
        Ok(())
    }

    /// Upsert ledger points with their embeddings. `points[i]` pairs with `vectors[i]`.
    pub async fn upsert_ledger_points(
        &self,
        points: &[LedgerPoint],
        vectors: &[Vec<f32>],
    ) -> Result<()> {
        let mut out = Vec::with_capacity(points.len());
        for (point, vector) in points.iter().zip(vectors) {
            let value = serde_json::to_value(&point.payload)?;
            let payload = Payload::try_from(value)
                .map_err(|e| Error::Qdrant(format!("payload conversion: {e}")))?;
            out.push(PointStruct::new(
                point.id.to_string(),
                vector.clone(),
                payload,
            ));
        }
        self.client
            .upsert_points(UpsertPointsBuilder::new(&self.collection, out).wait(true))
            .await
            .map_err(|e| Error::Qdrant(e.to_string()))?;
        Ok(())
    }

    /// Snapshot of indexed ledger topics: `topic_id -> topic_hash` (one entry per
    /// topic, deduped across its topic/event points). Drives the reconcile diff.
    pub async fn ledger_topic_hashes(&self) -> Result<HashMap<String, String>> {
        let filter = scope_filter(Some(Corpus::Ledger), None);
        let mut map = HashMap::new();
        let mut offset = None;
        loop {
            let include = SelectorOptions::Include(PayloadIncludeSelector {
                fields: vec!["topic_id".to_string(), "topic_hash".to_string()],
            });
            let mut builder = ScrollPointsBuilder::new(&self.collection)
                .limit(2048)
                .with_payload(include)
                .with_vectors(false);
            if let Some(f) = &filter {
                builder = builder.filter(f.clone());
            }
            if let Some(o) = offset.take() {
                builder = builder.offset(o);
            }
            let resp = self
                .client
                .scroll(builder)
                .await
                .map_err(|e| Error::Qdrant(e.to_string()))?;
            for point in resp.result {
                let topic_id = payload_str(&point.payload, "topic_id");
                let hash = payload_str(&point.payload, "topic_hash");
                if let (Some(t), Some(h)) = (topic_id, hash) {
                    note_hash(&mut map, t, h);
                }
            }
            match resp.next_page_offset {
                Some(o) => offset = Some(o),
                None => break,
            }
        }
        Ok(map)
    }

    /// Delete all points (topic + events) for one ledger topic.
    pub async fn delete_by_topic(&self, topic_id: &str) -> Result<()> {
        self.delete_by_field("topic_id", topic_id).await
    }

    /// Upsert tracker points with their embeddings. `points[i]` pairs with `vectors[i]`.
    pub async fn upsert_tracker_points(
        &self,
        points: &[TrackerPoint],
        vectors: &[Vec<f32>],
    ) -> Result<()> {
        let mut out = Vec::with_capacity(points.len());
        for (point, vector) in points.iter().zip(vectors) {
            let value = serde_json::to_value(&point.payload)?;
            let payload = Payload::try_from(value)
                .map_err(|e| Error::Qdrant(format!("payload conversion: {e}")))?;
            out.push(PointStruct::new(
                point.id.to_string(),
                vector.clone(),
                payload,
            ));
        }
        self.client
            .upsert_points(UpsertPointsBuilder::new(&self.collection, out).wait(true))
            .await
            .map_err(|e| Error::Qdrant(e.to_string()))?;
        Ok(())
    }

    /// Snapshot of indexed tracker units: `tracker_id -> tracker_hash` (one entry
    /// per document or item, deduped across a document's chunks; a unit whose
    /// points disagree maps to [`MIXED_HASH`]). Drives the tracker reconcile diff.
    pub async fn tracker_unit_hashes(&self) -> Result<HashMap<String, String>> {
        let filter = Filter::must([Condition::matches(
            "corpus",
            Corpus::Tracker.as_str().to_string(),
        )]);
        let mut map = HashMap::new();
        let mut offset = None;
        loop {
            let include = SelectorOptions::Include(PayloadIncludeSelector {
                fields: vec!["tracker_id".to_string(), "tracker_hash".to_string()],
            });
            let mut builder = ScrollPointsBuilder::new(&self.collection)
                .limit(2048)
                .with_payload(include)
                .with_vectors(false)
                .filter(filter.clone());
            if let Some(o) = offset.take() {
                builder = builder.offset(o);
            }
            let resp = self
                .client
                .scroll(builder)
                .await
                .map_err(|e| Error::Qdrant(e.to_string()))?;
            for point in resp.result {
                let id = payload_str(&point.payload, "tracker_id");
                let hash = payload_str(&point.payload, "tracker_hash");
                if let (Some(i), Some(h)) = (id, hash) {
                    note_hash(&mut map, i, h);
                }
            }
            match resp.next_page_offset {
                Some(o) => offset = Some(o),
                None => break,
            }
        }
        Ok(map)
    }

    /// Delete a tracker unit's points that do not carry `keep_hash` — the stale
    /// chunks of an earlier revision, removed only after the new points are
    /// written (the same write-then-prune order as the corpus and the ledger).
    pub async fn delete_tracker_except_hash(
        &self,
        tracker_id: &str,
        keep_hash: &str,
    ) -> Result<()> {
        self.delete_except("tracker_id", tracker_id, "tracker_hash", keep_hash)
            .await
    }

    /// Delete every point of one tracker unit.
    pub async fn delete_by_tracker_id(&self, tracker_id: &str) -> Result<()> {
        self.delete_by_field("tracker_id", tracker_id).await
    }

    /// Unfiltered vector search returning the top `limit` hits with provenance.
    pub async fn search(&self, vector: Vec<f32>, limit: u64) -> Result<Vec<SearchHit>> {
        self.search_filtered(vector, limit, &SearchFilters::default())
            .await
    }

    /// Vector search with payload filters. `corpus`/`repo`/`language` are applied
    /// as Qdrant keyword filters (indexed fields); `path_prefix` is *not* handled
    /// here — apply it as a post-filter on `rel_path` (no index exists for it).
    pub async fn search_filtered(
        &self,
        vector: Vec<f32>,
        limit: u64,
        filters: &SearchFilters,
    ) -> Result<Vec<SearchHit>> {
        let mut builder =
            SearchPointsBuilder::new(&self.collection, vector, limit).with_payload(true);
        if let Some(f) = payload_filter(filters) {
            builder = builder.filter(f);
        }
        let resp = self
            .client
            .search_points(builder)
            .await
            .map_err(|e| Error::Qdrant(e.to_string()))?;
        Ok(resp
            .result
            .into_iter()
            .map(|p| hit_from_payload(p.score, &p.payload))
            .collect())
    }
}

/// Map one search result's payload to a hit. Every corpus's fields are read by
/// name; a field a corpus does not carry comes back `None` (or empty), so one
/// mapping serves code, wiki, ledger and tracker points.
fn hit_from_payload(score: f32, p: &HashMap<String, Value>) -> SearchHit {
    SearchHit {
        score,
        corpus: payload_str(p, "corpus").unwrap_or_default(),
        repo: payload_str(p, "repo").unwrap_or_default(),
        path: payload_str(p, "path").unwrap_or_default(),
        rel_path: payload_str(p, "rel_path").unwrap_or_default(),
        language: payload_str(p, "language").unwrap_or_default(),
        start_line: payload_int(p, "start_line") as u32,
        end_line: payload_int(p, "end_line") as u32,
        text: payload_str(p, "text").unwrap_or_default(),
        topic_id: payload_str(p, "topic_id"),
        topic_type: payload_str(p, "type"),
        status: payload_str(p, "status"),
        title: payload_str(p, "title"),
        citation: payload_str(p, "citation"),
        tracker_id: payload_str(p, "tracker_id"),
        kind: payload_str(p, "kind"),
        revision: p.get("revision").and_then(|v| match v.kind.as_ref() {
            Some(Kind::IntegerValue(i)) => Some(*i),
            _ => None,
        }),
    }
}

/// `repo == repo AND corpus IN (code, wiki)`: a repo's file points only.
fn repo_files_filter(repo: &str) -> Filter {
    let corpora: Vec<String> = FILE_CORPORA
        .iter()
        .map(|c| c.as_str().to_string())
        .collect();
    Filter::must([
        Condition::matches("repo", repo.to_string()),
        Condition::matches("corpus", corpora),
    ])
}

/// Build an optional Qdrant filter from search filters (the indexed fields only;
/// `path_prefix` is handled by the caller as a post-filter).
fn payload_filter(f: &SearchFilters) -> Option<Filter> {
    let mut conds = Vec::new();
    if let Some(c) = f.corpus {
        conds.push(Condition::matches("corpus", c.as_str().to_string()));
    }
    if let Some(r) = &f.repo {
        conds.push(Condition::matches("repo", r.clone()));
    }
    if let Some(l) = &f.language {
        conds.push(Condition::matches("language", l.clone()));
    }
    if let Some(t) = &f.topic_type {
        conds.push(Condition::matches("type", t.clone()));
    }
    if let Some(s) = &f.status {
        conds.push(Condition::matches("status", s.clone()));
    }
    if conds.is_empty() {
        None
    } else {
        Some(Filter::must(conds))
    }
}

/// `field == value AND hash_field != keep_hash`.
fn except_filter(field: &str, value: &str, hash_field: &str, keep_hash: &str) -> Filter {
    Filter {
        must: vec![Condition::matches(field, value.to_string())],
        must_not: vec![Condition::matches(hash_field, keep_hash.to_string())],
        ..Default::default()
    }
}

/// Build an optional Qdrant filter scoping to a corpus and/or repo.
fn scope_filter(corpus: Option<Corpus>, repo: Option<&str>) -> Option<Filter> {
    let mut conds = Vec::new();
    if let Some(c) = corpus {
        conds.push(Condition::matches("corpus", c.as_str().to_string()));
    }
    if let Some(r) = repo {
        conds.push(Condition::matches("repo", r.to_string()));
    }
    if conds.is_empty() {
        None
    } else {
        Some(Filter::must(conds))
    }
}

fn payload_str(p: &HashMap<String, Value>, key: &str) -> Option<String> {
    match p.get(key).and_then(|v| v.kind.as_ref()) {
        Some(Kind::StringValue(s)) => Some(s.clone()),
        _ => None,
    }
}

fn payload_int(p: &HashMap<String, Value>, key: &str) -> i64 {
    match p.get(key).and_then(|v| v.kind.as_ref()) {
        Some(Kind::IntegerValue(i)) => *i,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disagreeing_hashes_for_one_path_collapse_to_mixed() {
        let mut map = HashMap::new();
        note_hash(&mut map, "a".into(), "h1".into());
        note_hash(&mut map, "a".into(), "h1".into());
        note_hash(&mut map, "b".into(), "h2".into());
        assert_eq!(map["a"], "h1");
        note_hash(&mut map, "a".into(), "h9".into());
        assert_eq!(map["a"], MIXED_HASH);
        // Once mixed, a later agreeing point does not un-mix it.
        note_hash(&mut map, "a".into(), "h1".into());
        assert_eq!(map["a"], MIXED_HASH);
        assert_eq!(map["b"], "h2");
    }

    #[test]
    fn a_repo_purge_never_reaches_the_ledger_or_the_tracker() {
        let dbg = format!("{:?}", repo_files_filter("ubu"));
        assert!(dbg.contains("\"ubu\""));
        assert!(dbg.contains("\"code\"") && dbg.contains("\"wiki\""));
        assert!(!dbg.contains("ledger") && !dbg.contains("tracker"));
    }

    /// A tracker payload, written as `upsert_tracker_points` writes it, reads back
    /// as a hit carrying its citation, id, kind, revision, title and line range.
    #[test]
    fn a_tracker_payload_maps_to_a_cited_hit() {
        use crate::model::TrackerPayload;
        let payload = TrackerPayload {
            corpus: Corpus::Tracker,
            repo: "ubu".into(),
            rel_path: "concepts/power.md".into(),
            language: "markdown".into(),
            tracker_id: "ubu-d0003".into(),
            point_kind: "document".into(),
            kind: "concept".into(),
            item_type: None,
            status: None,
            title: "Power".into(),
            revision: Some(4),
            citation: "ubu:concepts/power.md@r4".into(),
            chunk_index: 1,
            start_line: 12,
            end_line: 30,
            text: "a solar film on the roof".into(),
            content_hash: "c".into(),
            tracker_hash: "h".into(),
        };
        let qp = Payload::try_from(serde_json::to_value(&payload).unwrap()).unwrap();
        let map: HashMap<String, Value> = qp.into();
        let hit = hit_from_payload(0.5, &map);
        assert_eq!(hit.corpus, "tracker");
        assert_eq!(hit.repo, "ubu");
        assert_eq!(hit.rel_path, "concepts/power.md");
        assert_eq!(hit.citation.as_deref(), Some("ubu:concepts/power.md@r4"));
        assert_eq!(hit.tracker_id.as_deref(), Some("ubu-d0003"));
        assert_eq!(hit.kind.as_deref(), Some("concept"));
        assert_eq!(hit.revision, Some(4));
        assert_eq!(hit.title.as_deref(), Some("Power"));
        assert_eq!((hit.start_line, hit.end_line), (12, 30));
        assert_eq!(hit.path, "", "a tracker point has no file path");
        assert_eq!(hit.topic_type, None);
        // A code payload carries none of the tracker fields.
        let code = Payload::try_from(serde_json::json!({
            "corpus": "code", "repo": "r", "path": "/p", "rel_path": "p", "text": "x"
        }))
        .unwrap();
        let hit = hit_from_payload(0.1, &code.into());
        assert!(hit.citation.is_none() && hit.tracker_id.is_none() && hit.revision.is_none());
    }

    #[test]
    fn except_filter_keeps_the_new_hash() {
        let f = except_filter("path", "/r/x.rs", "file_hash", "new");
        assert_eq!(f.must.len(), 1);
        assert_eq!(f.must_not.len(), 1);
        assert!(f.should.is_empty());
        let dbg = format!("{f:?}");
        assert!(dbg.contains("/r/x.rs") && dbg.contains("new") && dbg.contains("file_hash"));
    }
}
