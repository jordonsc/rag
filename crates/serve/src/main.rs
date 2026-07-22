//! `rag-serve` — HTTP retrieval service (Phase 05).
//!
//! Exposes the shared retrieval pipeline (`rag_core::retrieval::Retriever`) over
//! HTTP: `POST /search` (embed → ANN search → rerank → ranked, cited results),
//! plus `GET /health` (liveness) and `GET /info` (collection stats + config echo,
//! no secrets). The pipeline itself lives in `core` so the MCP server (Phase 06)
//! reuses it rather than re-implementing it.

use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use clap::Parser;
use serde::{Deserialize, Serialize};

use rag_core::config::Config;
use rag_core::ledger::{EventKind, LedgerStore, NewEvent, NewTopic, Status, TopicType};
use rag_core::model::{Corpus, RankedHit, SearchFilters};
use rag_core::retrieval::{RetrievalRequest, Retriever, Timings};

#[derive(Parser)]
#[command(name = "rag-serve", about = "RAG HTTP retrieval service", version)]
struct Cli {
    #[arg(long, default_value = "rag.toml")]
    config: String,

    /// Bind, self-check `/health`, then exit 0 without serving. For CI / smoke
    /// tests — tolerates a missing Voyage key (the retrieval routes return 503).
    #[arg(long)]
    check: bool,
}

/// Shared handler state.
struct AppState {
    /// `None` only in `--check` mode without a Voyage key; the retrieval routes
    /// then answer 503 instead of panicking at startup.
    retriever: Option<Retriever>,
    cfg: Config,
    /// File to write on `POST /reindex`; `None` disables the endpoint.
    reindex_trigger: Option<PathBuf>,
    /// SQLite ledger store; `None` if it could not be opened (routes then 503).
    ledger: Option<LedgerStore>,
    /// File touched after a ledger write to trigger a reconcile; `None` disables it.
    ledger_trigger: Option<PathBuf>,
}

impl AppState {
    /// The ledger store, or a 503 if it failed to open at startup.
    fn ledger(&self) -> Result<&LedgerStore, ApiError> {
        self.ledger
            .as_ref()
            .ok_or_else(|| ApiError::Unavailable("ledger store unavailable".into()))
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Dev convenience: load `.env` if present (in deployment the systemd unit
    // delivers secrets via --env-file, so this is a no-op there).
    let _ = dotenvy::dotenv();
    rag_core::telemetry::init();
    let cli = Cli::parse();
    let cfg = Config::load_from(&cli.config)?;

    // Build the retrieval pipeline. Missing secrets are fatal in normal operation
    // but tolerated under --check so CI can smoke-test /health without keys.
    let retriever = match Retriever::from_env(&cfg) {
        Ok(r) => Some(r),
        Err(e) if cli.check => {
            tracing::warn!(error = %e, "retriever unavailable (check mode) — /search will 503");
            None
        }
        Err(e) => return Err(e.into()),
    };

    let reindex_trigger = {
        let t = cfg.server.reindex_trigger.trim();
        (!t.is_empty()).then(|| PathBuf::from(t))
    };
    let ledger_trigger = {
        let t = cfg.server.ledger_reindex_trigger.trim();
        (!t.is_empty()).then(|| PathBuf::from(t))
    };

    // The ledger is a local SQLite file; tolerate open failure (routes 503) so the
    // retrieval service stays up and `--check` works without a writable ledger dir.
    let ledger = match LedgerStore::open(&cfg.ledger.db_path).await {
        Ok(l) => Some(l),
        Err(e) => {
            tracing::warn!(error = %e, path = %cfg.ledger.db_path.display(), "ledger unavailable — /ledger routes will 503");
            None
        }
    };

    let state = Arc::new(AppState {
        retriever,
        cfg: cfg.clone(),
        reindex_trigger,
        ledger,
        ledger_trigger,
    });

    let app = Router::new()
        .route("/health", get(health))
        .route("/info", get(info))
        .route("/search", post(search))
        .route("/reindex", post(reindex))
        .route("/ledger", post(ledger_create))
        .route("/ledger/search", post(ledger_search))
        .route("/ledger/{id}", get(ledger_get))
        .route("/ledger/{id}/append", post(ledger_append))
        .route("/ledger/{id}/move", post(ledger_move))
        .route("/ledger/{id}/archive", post(ledger_archive))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&cfg.server.bind).await?;
    let addr = listener.local_addr()?;
    tracing::info!(%addr, over_fetch = cfg.server.over_fetch, default_top_k = cfg.server.default_top_k, "rag-serve listening");

    if cli.check {
        let server = tokio::spawn(async move { axum::serve(listener, app).await });
        let url = format!("http://{addr}/health");
        let body = reqwest::get(&url).await?.text().await?;
        tracing::info!(%url, %body, "self-check OK");
        server.abort();
        return Ok(());
    }

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

// ---- Handlers ---------------------------------------------------------------

async fn health() -> &'static str {
    "ok"
}

/// `POST /search` request body. `top_k`, `filters`, and `rerank` are optional.
#[derive(Deserialize)]
struct SearchBody {
    query: String,
    #[serde(default)]
    top_k: Option<usize>,
    #[serde(default)]
    filters: Option<FilterBody>,
    #[serde(default)]
    rerank: Option<bool>,
}

#[derive(Deserialize)]
struct FilterBody {
    corpus: Option<String>,
    repo: Option<String>,
    language: Option<String>,
    path_prefix: Option<String>,
}

/// `POST /search` response. `results` carry both the ANN score and (when reranked)
/// the rerank score; cite via `repo` + `rel_path` + line range.
#[derive(Serialize)]
struct SearchResponse {
    query: String,
    top_k: usize,
    reranked: bool,
    candidates: usize,
    timings: Timings,
    results: Vec<RankedHit>,
}

async fn search(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SearchBody>,
) -> Result<Json<SearchResponse>, ApiError> {
    let retriever = state
        .retriever
        .as_ref()
        .ok_or_else(|| ApiError::Unavailable("retrieval unavailable: no Voyage API key".into()))?;

    if body.query.trim().is_empty() {
        return Err(ApiError::BadRequest("query must not be empty".into()));
    }

    let filters = parse_filters(body.filters)?;
    let rerank = body.rerank.unwrap_or(true);
    let requested_top_k = body.top_k.unwrap_or(0);
    let query = body.query.clone();

    let req = RetrievalRequest {
        query: body.query,
        top_k: requested_top_k,
        filters,
        rerank,
    };

    let result = retriever
        .retrieve(&req)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    let top_k = if requested_top_k == 0 {
        retriever.default_top_k()
    } else {
        requested_top_k
    };

    tracing::info!(
        %query,
        top_k,
        candidates = result.candidates,
        returned = result.hits.len(),
        reranked = result.reranked,
        total_ms = result.timings.total_ms,
        "search"
    );

    Ok(Json(SearchResponse {
        query,
        top_k,
        reranked: result.reranked,
        candidates: result.candidates,
        timings: result.timings,
        results: result.hits,
    }))
}

/// `GET /info` response: collection stats, model ids, and non-secret config.
#[derive(Serialize)]
struct InfoResponse {
    collection: String,
    points: u64,
    embed_model: String,
    rerank_model: String,
    dimensions: u32,
    over_fetch: usize,
    default_top_k: usize,
    qdrant_url: String,
    retrieval_ready: bool,
}

async fn info(State(state): State<Arc<AppState>>) -> Result<Json<InfoResponse>, ApiError> {
    let cfg = &state.cfg;
    let points = match &state.retriever {
        Some(r) => r
            .store()
            .points_count()
            .await
            .map_err(|e| ApiError::Internal(e.to_string()))?,
        None => 0,
    };

    Ok(Json(InfoResponse {
        collection: cfg.qdrant.collection.clone(),
        points,
        embed_model: cfg.voyage.embed_model.clone(),
        rerank_model: cfg.voyage.rerank_model.clone(),
        dimensions: cfg.voyage.dimensions,
        over_fetch: cfg.server.over_fetch,
        default_top_k: cfg.server.default_top_k,
        qdrant_url: cfg.qdrant.url.clone(),
        retrieval_ready: state.retriever.is_some(),
    }))
}

/// `POST /reindex` — trigger an immediate corpus re-index by writing the trigger
/// file (a systemd `.path` unit watches it and starts `rag-sync.service`,
/// which serialises with the 15-min timer so two indexers never run at once).
/// Returns as soon as it's triggered; the run completes in the background.
async fn reindex(State(state): State<Arc<AppState>>) -> Result<Json<serde_json::Value>, ApiError> {
    let trigger = state
        .reindex_trigger
        .as_ref()
        .ok_or_else(|| ApiError::Unavailable("re-index is not configured on this server".into()))?;

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    tokio::fs::write(trigger, format!("{stamp}\n"))
        .await
        .map_err(|e| ApiError::Internal(format!("failed to write reindex trigger: {e}")))?;

    tracing::info!(trigger = %trigger.display(), "reindex triggered");
    Ok(Json(serde_json::json!({
        "status": "triggered",
        "detail": "corpus re-index started in the background (~30s–3min); re-search shortly"
    })))
}

// ---- Ledger handlers --------------------------------------------------------

/// `POST /ledger` body. `type`/`status` are validated against the enums by serde.
#[derive(Deserialize)]
struct LedgerCreateBody {
    // Enum fields arrive as strings and are parsed in-handler so an invalid value
    // yields a clean 400 with a descriptive message (not axum's generic 422).
    #[serde(rename = "type")]
    topic_type: String,
    repo: String,
    title: String,
    summary: String,
    initial_state: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    creator_email: String,
    #[serde(default)]
    creator_agent: Option<String>,
}

async fn ledger_create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LedgerCreateBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ledger = state.ledger()?;
    if body.title.trim().is_empty() || body.summary.trim().is_empty() {
        return Err(ApiError::BadRequest(
            "title and summary are required".into(),
        ));
    }
    let topic_type =
        TopicType::from_str(&body.topic_type).map_err(|e| ApiError::BadRequest(e.to_string()))?;
    let status = parse_opt_status(body.status.as_deref())?;
    let topic = ledger
        .create_topic(NewTopic {
            topic_type,
            repo: body.repo,
            title: body.title,
            summary: body.summary,
            initial_state: body.initial_state,
            status,
            tags: body.tags,
            creator_email: body.creator_email,
            creator_agent: body.creator_agent,
        })
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    fire_trigger(&state.ledger_trigger).await;
    tracing::info!(topic_id = %topic.topic_id, "ledger topic created");
    Ok(Json(serde_json::to_value(&topic).unwrap_or_default()))
}

/// `POST /ledger/{id}/append` body. Enum fields are strings, parsed in-handler.
#[derive(Deserialize)]
struct LedgerAppendBody {
    body: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    set_state: Option<String>,
    #[serde(default)]
    set_status: Option<String>,
    #[serde(default)]
    supersedes: Option<String>,
    author_email: String,
    #[serde(default)]
    author_agent: Option<String>,
}

async fn ledger_append(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<LedgerAppendBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ledger = state.ledger()?;
    if body.body.trim().is_empty() {
        return Err(ApiError::BadRequest("body must not be empty".into()));
    }
    let kind = match body.kind.as_deref() {
        None => EventKind::Note,
        Some(k) => EventKind::from_str(k).map_err(|e| ApiError::BadRequest(e.to_string()))?,
    };
    let set_status = parse_opt_status(body.set_status.as_deref())?;
    let event = match ledger
        .append_event(NewEvent {
            topic_id: id.clone(),
            body: body.body,
            kind,
            set_state: body.set_state,
            set_status,
            supersedes: body.supersedes,
            author_email: body.author_email,
            author_agent: body.author_agent,
        })
        .await
    {
        Ok(e) => e,
        Err(e) => {
            // If the id was retired by a move, point the caller at the new id.
            if let Ok(Some(mv)) = ledger.lookup_move(&id).await {
                return Err(ApiError::BadRequest(format!(
                    "topic {id} was moved to {}; append to that id instead",
                    mv.new_topic_id
                )));
            }
            return Err(ApiError::BadRequest(e.to_string()));
        }
    };

    fire_trigger(&state.ledger_trigger).await;
    tracing::info!(topic_id = %id, event_id = event.event_id, "ledger event appended");
    Ok(Json(serde_json::to_value(&event).unwrap_or_default()))
}

/// `POST /ledger/{id}/move` body — relocate a topic to another project.
#[derive(Deserialize)]
struct LedgerMoveBody {
    /// Destination project (repo name); the topic gets a brand-new id here.
    repo: String,
    author_email: String,
    #[serde(default)]
    author_agent: Option<String>,
}

async fn ledger_move(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<LedgerMoveBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ledger = state.ledger()?;
    if body.repo.trim().is_empty() {
        return Err(ApiError::BadRequest("repo is required".into()));
    }
    let topic = ledger
        .move_topic(
            &id,
            body.repo.trim(),
            &body.author_email,
            body.author_agent.as_deref(),
        )
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;

    fire_trigger(&state.ledger_trigger).await;
    tracing::info!(from = %id, to = %topic.topic_id, "ledger topic moved");
    Ok(Json(serde_json::to_value(&topic).unwrap_or_default()))
}

/// `POST /ledger/{id}/archive` body — soft-delete (or restore) a topic.
#[derive(Deserialize)]
struct LedgerArchiveBody {
    /// `true` (default) archives; `false` restores.
    #[serde(default = "default_true")]
    archived: bool,
    author_email: String,
    #[serde(default)]
    author_agent: Option<String>,
}

fn default_true() -> bool {
    true
}

async fn ledger_archive(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<LedgerArchiveBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let ledger = state.ledger()?;
    let topic = ledger
        .set_archived(
            &id,
            body.archived,
            &body.author_email,
            body.author_agent.as_deref(),
        )
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;

    fire_trigger(&state.ledger_trigger).await;
    tracing::info!(topic_id = %id, archived = body.archived, "ledger topic archive flag set");
    Ok(Json(serde_json::to_value(&topic).unwrap_or_default()))
}

async fn ledger_get(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let ledger = state.ledger()?;
    if let Some(record) = ledger
        .get_topic(&id)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?
    {
        return Ok(Json(serde_json::to_value(&record).unwrap_or_default()).into_response());
    }
    // Not a live topic — but if it was moved, return a 301-style pointer to where
    // its content now lives rather than a bare 404.
    if let Some(mv) = ledger
        .lookup_move(&id)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?
    {
        let body = serde_json::json!({
            "moved": true,
            "topic_id": id,
            "moved_to": mv.new_topic_id,
            "moved_at": mv.moved_at,
            "detail": format!(
                "topic {} was moved and now belongs under {}; fetch that id instead",
                id, mv.new_topic_id
            ),
        });
        return Ok(Json(body).into_response());
    }
    Err(ApiError::NotFound(format!("no ledger topic {id:?}")))
}

/// `POST /ledger/search` body — semantic search scoped to `corpus = ledger`.
#[derive(Deserialize)]
struct LedgerSearchBody {
    query: String,
    #[serde(default)]
    top_k: Option<usize>,
    #[serde(default)]
    repo: Option<String>,
    #[serde(default, rename = "type")]
    topic_type: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    rerank: Option<bool>,
    /// When true, search the archived (soft-deleted) set instead of the live index.
    #[serde(default)]
    archived: Option<bool>,
}

/// One archived topic in the `archived = true` search response. Archived topics are
/// absent from the RAG index, so this is a plain record rather than a `RankedHit`.
#[derive(Serialize)]
struct ArchivedHit {
    topic_id: String,
    #[serde(rename = "type")]
    topic_type: String,
    status: String,
    repo: String,
    title: String,
    summary: String,
    current_state: String,
    updated_at: String,
    archived_at: Option<String>,
}

#[derive(Serialize)]
struct ArchivedSearchResponse {
    query: String,
    archived: bool,
    count: usize,
    results: Vec<ArchivedHit>,
}

async fn ledger_search(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LedgerSearchBody>,
) -> Result<Response, ApiError> {
    // Archived path: a SQL substring search over the soft-deleted set. Needs no
    // retriever (archived topics aren't embedded), so it works without a Voyage key.
    if body.archived.unwrap_or(false) {
        let ledger = state.ledger()?;
        let limit = match body.top_k.unwrap_or(0) {
            0 => 50,
            n => n,
        };
        let topics = ledger
            .search_archived(
                &body.query,
                body.repo.as_deref(),
                body.topic_type.as_deref(),
                body.status.as_deref(),
                limit as i64,
            )
            .await
            .map_err(|e| ApiError::Internal(e.to_string()))?;
        let results: Vec<ArchivedHit> = topics
            .into_iter()
            .map(|t| ArchivedHit {
                topic_id: t.topic_id,
                topic_type: t.topic_type.as_str().to_string(),
                status: t.status.as_str().to_string(),
                repo: t.repo,
                title: t.title,
                summary: t.summary,
                current_state: t.current_state,
                updated_at: t.updated_at,
                archived_at: t.archived_at,
            })
            .collect();
        tracing::info!(query = %body.query, returned = results.len(), "ledger_search (archived)");
        return Ok(Json(ArchivedSearchResponse {
            query: body.query,
            archived: true,
            count: results.len(),
            results,
        })
        .into_response());
    }

    let retriever = state
        .retriever
        .as_ref()
        .ok_or_else(|| ApiError::Unavailable("retrieval unavailable: no Voyage API key".into()))?;
    if body.query.trim().is_empty() {
        return Err(ApiError::BadRequest("query must not be empty".into()));
    }

    let filters = SearchFilters {
        corpus: Some(Corpus::Ledger),
        repo: body.repo,
        language: None,
        path_prefix: None,
        topic_type: body.topic_type,
        status: body.status,
    };
    let requested_top_k = body.top_k.unwrap_or(0);
    let query = body.query.clone();
    let req = RetrievalRequest {
        query: body.query,
        top_k: requested_top_k,
        filters,
        rerank: body.rerank.unwrap_or(true),
    };
    let result = retriever
        .retrieve(&req)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    let top_k = if requested_top_k == 0 {
        retriever.default_top_k()
    } else {
        requested_top_k
    };
    tracing::info!(%query, returned = result.hits.len(), "ledger_search");
    Ok(Json(SearchResponse {
        query,
        top_k,
        reranked: result.reranked,
        candidates: result.candidates,
        timings: result.timings,
        results: result.hits,
    })
    .into_response())
}

/// Parse an optional status string, mapping a bad value to a 400.
fn parse_opt_status(s: Option<&str>) -> Result<Option<Status>, ApiError> {
    s.map(Status::from_str)
        .transpose()
        .map_err(|e| ApiError::BadRequest(e.to_string()))
}

/// Fire-and-forget: touch the ledger reconcile trigger. A failure just means the
/// 15-min timer will catch the change instead, so warn rather than error.
async fn fire_trigger(trigger: &Option<PathBuf>) {
    let Some(path) = trigger else { return };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Err(e) = tokio::fs::write(path, format!("{stamp}\n")).await {
        tracing::warn!(error = %e, trigger = %path.display(), "failed to write ledger trigger");
    }
}

// ---- Helpers ----------------------------------------------------------------

fn parse_filters(f: Option<FilterBody>) -> Result<SearchFilters, ApiError> {
    let Some(f) = f else {
        return Ok(SearchFilters::default());
    };
    let corpus = match f.corpus.as_deref() {
        None => None,
        Some(name) => Some(Corpus::from_name(name).ok_or_else(|| {
            ApiError::BadRequest(format!(
                "invalid corpus {name:?} (expected \"code\", \"wiki\" or \"ledger\")"
            ))
        })?),
    };
    Ok(SearchFilters {
        corpus,
        repo: f.repo,
        language: f.language,
        path_prefix: f.path_prefix,
        topic_type: None,
        status: None,
    })
}

/// Error type that renders as a JSON `{ "error": ... }` body with a status code,
/// never leaking the API key (core errors are stringified, which redact secrets).
enum ApiError {
    BadRequest(String),
    NotFound(String),
    Unavailable(String),
    Internal(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            ApiError::NotFound(m) => (StatusCode::NOT_FOUND, m),
            ApiError::Unavailable(m) => (StatusCode::SERVICE_UNAVAILABLE, m),
            ApiError::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, m),
        };
        let body = Json(serde_json::json!({ "error": message }));
        (status, body).into_response()
    }
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutdown signal received");
}
