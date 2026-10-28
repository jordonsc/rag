//! `rag-serve` — HTTP retrieval service (Phase 05).
//!
//! Exposes the shared retrieval pipeline (`rag_core::retrieval::Retriever`) over
//! HTTP: `POST /search` (embed → ANN search → rerank → ranked, cited results),
//! plus `GET /health` (liveness) and `GET /info` (collection stats + config echo,
//! no secrets). The pipeline itself lives in `core` so the MCP server (Phase 06)
//! reuses it rather than re-implementing it.
//!
//! When a web root is configured it also serves the ledger web UI on the same
//! port and origin (see [`web`]), which is why no CORS handling exists here.
//!
//! One route talks to a *second* vendor API: `POST /ledger/{id}/summarise` asks
//! Anthropic to summarise a topic. Its key is **optional** and its absence is
//! not a failure — see [`AppState::summariser`].
//!
//! Three more routes — `GET /prompts`, `POST /prompts/save`, `POST /prompts/delete`
//! — manage the small library of saved system prompts that endpoint chooses
//! from (see [`prompts`]). They are the only routes here that **write a file**,
//! on a service with no authentication, which is why the name validation in
//! that module is as strict as it is.
//!
//! The tracker's routes (`/tracker/…`, the queue, specs, concepts, documents and
//! attachments) live in [`tracker`], with their own state, and are merged in
//! below. Their contract is `specs/tracker/api.md`.

mod prompts;
mod summarise;
mod tracker;
mod web;

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

use rag_core::anthropic::{self, AnthropicClient};
use rag_core::config::Config;
use rag_core::ledger::{EventKind, LedgerStore, NewEvent, NewTopic, Status, TopicType};
use rag_core::model::{Corpus, RankedHit, SearchFilters};
use rag_core::retrieval::{RetrievalRequest, Retriever, Timings};
use rag_core::tracker::TrackerStore;

use crate::prompts::{PromptError, PromptLibrary, SavedPrompt};

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
    /// Anthropic client for `POST /ledger/{id}/summarise`.
    ///
    /// `None` whenever `ANTHROPIC_API_KEY` is unset — which is the **normal**
    /// configuration, not a degraded one. The summarise route then answers 503
    /// exactly as the retrieval routes do without a Voyage key, and nothing else
    /// about the service changes. A missing key must never fail a startup: it
    /// disables one feature, and a deployment that has never wanted an LLM in it
    /// is a deployment that should still boot.
    summariser: Option<AnthropicClient>,
    /// The saved system-prompt library backing the Summarise drawer's chooser.
    ///
    /// `None` when `server.prompts_dir` is unset — the normal configuration for
    /// a server nobody has given a prompts mount. `GET /prompts` then reports an
    /// empty, unconfigured library rather than failing, because the built-in
    /// default prompt is always available and needs no file; the two write
    /// routes answer 503, the same shape as `/reindex` without a trigger.
    prompts: Option<PromptLibrary>,
    /// Whether the tracker store opened (its routes hold their own handle).
    tracker_ready: bool,
}

impl AppState {
    /// The ledger store, or a 503 if it failed to open at startup.
    fn ledger(&self) -> Result<&LedgerStore, ApiError> {
        self.ledger
            .as_ref()
            .ok_or_else(|| ApiError::Unavailable("ledger store unavailable".into()))
    }

    /// The prompt library, or a 503 if this server has no directory for one.
    /// Only the *write* routes call this: a read reports an empty library.
    fn prompt_library(&self) -> Result<&PromptLibrary, ApiError> {
        self.prompts.as_ref().ok_or_else(|| {
            ApiError::Unavailable(
                "saved prompts are not configured on this server (no server.prompts_dir)".into(),
            )
        })
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
    let tracker_trigger = {
        let t = cfg.server.tracker_reindex_trigger.trim();
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

    // Optional, and quietly so. Note the asymmetry with the Voyage key above:
    // that one is fatal outside --check because retrieval is the service; this
    // one is a feature that either exists or does not.
    let summariser = match AnthropicClient::from_env() {
        Ok(Some(client)) => {
            tracing::info!(default_model = %anthropic::DEFAULT_MODEL, "summarise enabled");
            Some(client)
        }
        Ok(None) => {
            tracing::info!(
                "no ANTHROPIC_API_KEY — /ledger/{{id}}/summarise will 503 (this is a valid configuration)"
            );
            None
        }
        Err(e) => {
            tracing::warn!(error = %e, "summarise unavailable — /ledger/{{id}}/summarise will 503");
            None
        }
    };

    // Optional like the rest, and constructed without touching the disk: the
    // directory is created on the first save, so a server pointed at a path
    // that does not exist yet starts normally with an empty library.
    let prompts = PromptLibrary::from_config(&cfg.server.prompts_dir);
    match &prompts {
        Some(library) => {
            tracing::info!(dir = %library.dir().display(), "saved prompt library enabled")
        }
        None => {
            tracing::info!("no server.prompts_dir — only the built-in Summarise prompt is offered")
        }
    }

    // The tracker is a second SQLite file beside the ledger's, opened the same
    // tolerant way: if it cannot open, its routes answer 503 and nothing else
    // about the service changes.
    let tracker = match TrackerStore::open(&cfg.tracker.db_path, &cfg.tracker.attachments_dir).await
    {
        Ok(t) => Some(t),
        Err(e) => {
            tracing::warn!(error = %e, path = %cfg.tracker.db_path.display(), "tracker unavailable — /tracker routes will 503");
            None
        }
    };

    let state = Arc::new(AppState {
        retriever,
        cfg: cfg.clone(),
        reindex_trigger,
        ledger,
        ledger_trigger,
        summariser,
        prompts,
        tracker_ready: tracker.is_some(),
    });

    let feed_store = tracker.clone();
    let app = api_router(state).merge(tracker::router(tracker, tracker_trigger));

    // The UI rides on the same port as the API — attached last, because it is a
    // fallback: it answers only what the routes above did not.
    let app = web::attach(app, &cfg.server.web_root);

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
        .with_graceful_shutdown(shutdown_with_feeds(feed_store))
        .await?;
    Ok(())
}

/// The service's own routes (everything but the tracker's and the web UI's),
/// bound to their state. A function so the route tests drive the same table.
fn api_router(state: Arc<AppState>) -> Router {
    Router::new()
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
        .route("/ledger/{id}/summarise", post(ledger_summarise))
        .route("/prompts", get(prompts_list))
        .route("/prompts/save", post(prompts_save))
        .route("/prompts/delete", post(prompts_delete))
        .with_state(state)
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
    /// Points in the collection, or `null` when Qdrant could not be asked: it is
    /// unreachable (see `qdrant_error`), or this server has no retriever (check
    /// mode without a Voyage key). Never a guessed `0` — an empty collection and
    /// a Qdrant that did not answer are different outages.
    points: Option<u64>,
    /// Why `points` is `null` when Qdrant was asked and failed; `null` otherwise.
    ///
    /// The route stays 200 in that case (rag-t0001): the readiness fields below
    /// are exactly what an operator wants during a Qdrant outage, and the ledger
    /// and the tracker work without Qdrant.
    qdrant_error: Option<String>,
    embed_model: String,
    rerank_model: String,
    dimensions: u32,
    over_fetch: usize,
    default_top_k: usize,
    qdrant_url: String,
    retrieval_ready: bool,
    /// Whether `POST /ledger/{id}/summarise` will do anything but 503. The UI
    /// keeps its Summarise tab visible either way and explains itself when this
    /// is false — a control that vanishes teaches a reader the application
    /// cannot do the thing at all.
    summarise_ready: bool,
    /// The models that endpoint accepts. Sent so the picker offers the server's
    /// allow-list rather than a copy of it that can drift out of step.
    summarise_models: &'static [&'static str],
    summarise_default_model: &'static str,
    /// The default instruction, so the editable prompt box is prefilled from the
    /// single source of truth instead of a second copy written in TypeScript.
    summarise_system_prompt: &'static str,
    /// Whether the tracker store opened, i.e. whether the `/tracker/…` routes
    /// will do anything but 503.
    tracker_ready: bool,
}

/// `GET /info`. Always 200: a Qdrant that cannot be reached is reported as
/// `points: null` with `qdrant_error`, not as a failed route. The Qdrant client's
/// own request timeout bounds how long an unreachable host can hold this up.
async fn info(State(state): State<Arc<AppState>>) -> Json<InfoResponse> {
    let cfg = &state.cfg;
    let (points, qdrant_error) = match &state.retriever {
        Some(r) => match r.store().points_count().await {
            Ok(n) => (Some(n), None),
            Err(e) => {
                tracing::warn!(error = %e, url = %cfg.qdrant.url, "GET /info: Qdrant unreachable — points reported as null");
                (None, Some(e.to_string()))
            }
        },
        None => (None, None),
    };

    Json(InfoResponse {
        collection: cfg.qdrant.collection.clone(),
        points,
        qdrant_error,
        embed_model: cfg.voyage.embed_model.clone(),
        rerank_model: cfg.voyage.rerank_model.clone(),
        dimensions: cfg.voyage.dimensions,
        over_fetch: cfg.server.over_fetch,
        default_top_k: cfg.server.default_top_k,
        qdrant_url: cfg.qdrant.url.clone(),
        retrieval_ready: state.retriever.is_some(),
        summarise_ready: state.summariser.is_some(),
        summarise_models: anthropic::ALLOWED_MODELS,
        summarise_default_model: anthropic::DEFAULT_MODEL,
        summarise_system_prompt: anthropic::DEFAULT_SYSTEM_PROMPT,
        tracker_ready: state.tracker_ready,
    })
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
    // `create_topic` interpolates the repo straight into the id (`{repo}-l{seq:04}`),
    // so a blank one mints `-l0001` rather than failing. `ledger_move` has always
    // guarded this; `ledger_create` did not, and the web UI is the first client
    // where a human types the repo freehand.
    if body.repo.trim().is_empty() {
        return Err(ApiError::BadRequest("repo is required".into()));
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
    /// Amend the topic's title. Blank is rejected by the store.
    #[serde(default)]
    set_title: Option<String>,
    /// Replace the topic's tag set wholesale; `[]` clears it, absent leaves it.
    #[serde(default)]
    set_tags: Option<Vec<String>>,
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
            set_title: body.set_title,
            set_tags: body.set_tags,
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

/// `POST /ledger/{id}/summarise` body — both fields optional.
///
/// **Note what is not here: the content.** The topic is read server-side from
/// the id in the path. A body that carried the prose would be the client
/// re-sending what the server already has, and would turn this route into a
/// general-purpose LLM proxy for anyone who can reach the port.
#[derive(Deserialize)]
struct SummariseBody {
    /// One of the allow-listed model ids. Absent or blank means the default.
    #[serde(default)]
    model: Option<String>,
    /// The instruction. Absent or blank means `DEFAULT_SYSTEM_PROMPT`, which
    /// `/info` also hands the UI so the editable box is prefilled with it.
    #[serde(default)]
    system_prompt: Option<String>,
}

#[derive(Serialize)]
struct SummariseUsage {
    input_tokens: u64,
    output_tokens: u64,
}

/// `POST /ledger/{id}/summarise` response.
///
/// The usage is returned because **nothing is cached**: every press costs a
/// call, and the operator paying for it should be able to see what it cost
/// rather than infer it from a bill.
#[derive(Serialize)]
struct SummariseResponse {
    summary: String,
    /// The model that actually served the request, as the API reported it.
    model: String,
    usage: SummariseUsage,
    /// The summary ran into the output limit and stops mid-thought.
    truncated: bool,
}

/// `POST /ledger/{id}/summarise` — ask a model to read one topic and compress it.
///
/// Deliberately uncached and un-backfilled: a summary is of the entry as it
/// stands, and the entry is append-only prose that changes under it. A stored
/// summary would go quietly stale, and the staleness would be invisible.
///
/// The summary comes back as Markdown written by a model that has just read
/// unauthenticated, attacker-writable prose, so it is untrusted output and the
/// UI renders it through the same DOMPurify path as every other ledger string.
async fn ledger_summarise(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<SummariseBody>,
) -> Result<Json<SummariseResponse>, ApiError> {
    // The same shape as the retrieval routes' missing-Voyage-key 503, and for
    // the same reason: the service is up, one dependency was never configured.
    let client = state.summariser.as_ref().ok_or_else(|| {
        ApiError::Unavailable(
            "summarise unavailable: no Anthropic API key configured on this server".into(),
        )
    })?;
    let ledger = state.ledger()?;

    // Against the allow-list before anything else. What comes back is one of
    // this crate's own `&'static str`s, so no client-supplied string can reach
    // the vendor API even if the rest of this function is rewritten.
    let model = anthropic::resolve_model(body.model.as_deref())
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;

    let system = match body.system_prompt.as_deref().map(str::trim) {
        Some(prompt) if !prompt.is_empty() => prompt,
        _ => anthropic::DEFAULT_SYSTEM_PROMPT,
    };

    let record = match ledger
        .get_topic(&id)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?
    {
        Some(record) => record,
        None => {
            // A moved id is a redirect, not an absence. `GET /ledger/{id}` says
            // where it went; a summarise of the same id should not be the one
            // place that answers a bare 404.
            if let Ok(Some(mv)) = ledger.lookup_move(&id).await {
                return Err(ApiError::NotFound(format!(
                    "topic {id} was moved to {}; summarise that id instead",
                    mv.new_topic_id
                )));
            }
            return Err(ApiError::NotFound(format!("no ledger topic {id:?}")));
        }
    };

    let content = summarise::render_topic(&record);
    let summary = client
        .summarise(model, system, &content)
        .await
        .map_err(|e| ApiError::Upstream(e.to_string()))?;

    // The prompt and the entry are not logged: one is a copy of the ledger and
    // the other is long. What is worth keeping is what it cost.
    tracing::info!(
        topic_id = %id,
        model = %summary.model,
        input_tokens = summary.input_tokens,
        output_tokens = summary.output_tokens,
        truncated = summary.truncated,
        "ledger topic summarised"
    );

    Ok(Json(SummariseResponse {
        summary: summary.text,
        model: summary.model,
        usage: SummariseUsage {
            input_tokens: summary.input_tokens,
            output_tokens: summary.output_tokens,
        },
        truncated: summary.truncated,
    }))
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

// ---- Saved prompt handlers --------------------------------------------------
//
// The Summarise drawer's instruction box needs somewhere to keep more than one
// instruction, so the operator can pick between "summarise this" and "list only
// what changed" without retyping either. A prompt is a Markdown file in
// `server.prompts_dir` (see [`prompts`]); these three routes are the browser's
// view of that directory.
//
// **The built-in default is not one of them.** It is a Rust constant served by
// `/info`, always offered, never deletable, and never written to disk — an
// empty directory means the library is empty, not that a default needs seeding.
//
// These are the only routes in this service that write a file, and it has no
// authentication, so read `prompts::validate_name` before changing them.

/// `GET /prompts` response.
#[derive(Serialize)]
struct PromptsResponse {
    /// Whether this server has a prompts directory at all. `false` means the
    /// two write routes will 503 — the chooser should offer the built-in
    /// default alone and not draw a Save it cannot honour. It is **not** an
    /// error: a server without a prompts mount is a valid deployment.
    configured: bool,
    /// Every saved prompt, name and body, ordered by name. The bodies travel
    /// with the list so switching between them in the chooser costs no request.
    prompts: Vec<SavedPrompt>,
}

async fn prompts_list(
    State(state): State<Arc<AppState>>,
) -> Result<Json<PromptsResponse>, ApiError> {
    let Some(library) = state.prompts.as_ref() else {
        return Ok(Json(PromptsResponse {
            configured: false,
            prompts: Vec::new(),
        }));
    };
    let prompts = library.list().await.map_err(api_error)?;
    Ok(Json(PromptsResponse {
        configured: true,
        prompts,
    }))
}

/// `POST /prompts/save` body — an upsert, keyed on the name.
///
/// The name is in the **body**, not the path, deliberately: a name in a URL is
/// a name that has been through percent-decoding and a path router before this
/// service sees it, and neither is a step worth having in front of a validator
/// that decides which file gets written.
#[derive(Deserialize)]
struct PromptSaveBody {
    name: String,
    body: String,
}

async fn prompts_save(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PromptSaveBody>,
) -> Result<Json<SavedPrompt>, ApiError> {
    let library = state.prompt_library()?;
    let saved = library
        .save(&body.name, &body.body)
        .await
        .map_err(api_error)?;
    Ok(Json(saved))
}

/// `POST /prompts/delete` body.
#[derive(Deserialize)]
struct PromptDeleteBody {
    name: String,
}

async fn prompts_delete(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PromptDeleteBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let library = state.prompt_library()?;
    let name = library.delete(&body.name).await.map_err(api_error)?;
    Ok(Json(serde_json::json!({ "name": name, "deleted": true })))
}

/// Map a prompt-library failure onto the API's own error vocabulary.
///
/// A rejected name or body is the caller's fault (400) and its message is
/// written to be shown to a person; a missing prompt is a 404; anything the
/// filesystem refused is ours (500).
fn api_error(error: PromptError) -> ApiError {
    match error {
        PromptError::Rejected(m) => ApiError::BadRequest(m),
        PromptError::NotFound(m) => ApiError::NotFound(m),
        PromptError::Io(m) => ApiError::Internal(m),
    }
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
                "invalid corpus {name:?} (expected \"code\", \"wiki\", \"ledger\" or \"tracker\")"
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
    /// A dependency answered, and answered badly. Distinct from `Internal`
    /// because it says where the fault is: a 500 invites someone to go looking
    /// through this service's logs for a bug that is not in it.
    Upstream(String),
    Internal(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            ApiError::NotFound(m) => (StatusCode::NOT_FOUND, m),
            ApiError::Unavailable(m) => (StatusCode::SERVICE_UNAVAILABLE, m),
            ApiError::Upstream(m) => (StatusCode::BAD_GATEWAY, m),
            ApiError::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, m),
        };
        let body = Json(serde_json::json!({ "error": message }));
        (status, body).into_response()
    }
}

/// Ctrl-C, or SIGTERM (what `podman stop` and systemd send: the container's
/// process is PID 1, which the kernel does not kill on a signal it has no
/// handler for, so without this a stop waited out podman's timeout and ended
/// in SIGKILL, and the event feeds never got their close frame).
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let term = async {
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(mut s) => {
                    s.recv().await;
                }
                Err(e) => {
                    tracing::warn!(error = %e, "cannot listen for SIGTERM");
                    std::future::pending::<()>().await;
                }
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutdown signal received");
}

/// The shutdown signal, then the event feeds told the server is going
/// (rag-t0036): each sends its client a close frame carrying the id to resume
/// from. The moment's grace lets those frames out before the runtime stops.
async fn shutdown_with_feeds(tracker: Option<TrackerStore>) {
    shutdown_signal().await;
    if let Some(t) = tracker {
        let listening = t.close_feed();
        if listening > 0 {
            tracing::info!(listening, "closing tracker event feeds");
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn corpus(name: &str) -> Result<SearchFilters, ApiError> {
        parse_filters(Some(FilterBody {
            corpus: Some(name.into()),
            repo: None,
            language: None,
            path_prefix: None,
        }))
    }

    /// `POST /search` takes `corpus: "tracker"` (m05 TS-02), beside the others.
    #[test]
    fn search_filters_accept_every_corpus_and_refuse_others() {
        for c in [Corpus::Code, Corpus::Wiki, Corpus::Ledger, Corpus::Tracker] {
            assert_eq!(corpus(c.as_str()).ok().and_then(|f| f.corpus), Some(c));
        }
        match corpus("trackers") {
            Err(ApiError::BadRequest(m)) => assert!(m.contains("\"tracker\""), "{m}"),
            _ => panic!("an unknown corpus must be a 400"),
        }
    }

    // ---- GET /info (rag-t0001) ----------------------------------------------

    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use rag_core::qdrant::VectorStore;
    use rag_core::voyage::VoyageClient;
    use tower::ServiceExt;

    /// A state with every optional part off but the retriever, which the caller
    /// chooses. `tracker_ready` is true so the test sees it survive the outage.
    fn info_state(retriever: Option<Retriever>, cfg: Config) -> Arc<AppState> {
        Arc::new(AppState {
            retriever,
            cfg,
            reindex_trigger: None,
            ledger: None,
            ledger_trigger: None,
            summariser: None,
            prompts: None,
            tracker_ready: true,
        })
    }

    async fn get_info(state: Arc<AppState>) -> (StatusCode, serde_json::Value) {
        let req = Request::get("/info").body(Body::empty()).unwrap();
        let res = api_router(state).oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| panic!("not JSON ({status}): {}", String::from_utf8_lossy(&bytes)));
        (status, body)
    }

    /// A URL nothing listens on: bind an ephemeral port, then release it, so a
    /// connection to it is refused at once rather than timing out.
    fn unreachable_url() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        format!("http://127.0.0.1:{port}")
    }

    /// The acceptance: Qdrant down is `points: null` and a reason, at 200, with
    /// the readiness fields intact. Before the fix this route answered 500.
    #[tokio::test]
    async fn info_is_200_with_null_points_when_qdrant_is_unreachable() {
        let mut cfg = Config::default();
        cfg.qdrant.url = unreachable_url();
        let store = VectorStore::connect(&cfg.qdrant.url, &cfg.qdrant.collection, None).unwrap();
        let voyage = VoyageClient::new(cfg.voyage.clone(), "test-key".into()).unwrap();
        let retriever = Retriever::new(store, voyage, 50, 8, 1.0);

        let (status, body) = get_info(info_state(Some(retriever), cfg.clone())).await;

        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body["points"].is_null(), "{body}");
        let reason = body["qdrant_error"].as_str().unwrap_or_default();
        assert!(!reason.is_empty(), "qdrant_error must say why: {body}");
        assert_eq!(body["retrieval_ready"], true);
        assert_eq!(body["summarise_ready"], false);
        assert_eq!(body["tracker_ready"], true);
        assert_eq!(body["qdrant_url"], cfg.qdrant.url.as_str());
        assert_eq!(body["collection"], cfg.qdrant.collection.as_str());
    }

    /// Without a retriever Qdrant was never asked: `points` is `null` (not a
    /// made-up 0) and there is no error to report.
    #[tokio::test]
    async fn info_reports_null_points_and_no_error_without_a_retriever() {
        let (status, body) = get_info(info_state(None, Config::default())).await;

        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body["points"].is_null(), "{body}");
        assert!(body["qdrant_error"].is_null(), "{body}");
        assert_eq!(body["retrieval_ready"], false);
        assert_eq!(body["tracker_ready"], true);
    }

    // ---- Ledger ids of both forms over HTTP (rag-t0051) ----------------------

    async fn call(
        state: &Arc<AppState>,
        method: &str,
        uri: &str,
        body: Option<serde_json::Value>,
    ) -> (StatusCode, serde_json::Value) {
        let req = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(match body {
                Some(b) => Body::from(b.to_string()),
                None => Body::empty(),
            })
            .unwrap();
        let res = api_router(state.clone()).oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, body)
    }

    /// New topics mint `{repo}-l{seq:04}`, continuing the repo's legacy
    /// sequence; a legacy `{repo}-{seq:04}` id still gets, appends, moves (with
    /// its redirect), archives and is found by the archived search.
    #[tokio::test]
    async fn ledger_routes_take_both_id_forms() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("ledger.db");
        let ledger = LedgerStore::open(&db).await.unwrap();
        // A topic as the store minted it before rag-t0051, in a hyphenated repo.
        let raw = sqlx::SqlitePool::connect(&format!("sqlite://{}", db.display()))
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO topics (topic_id, seq, type, repo, title, summary, current_state, \
             status, created_at, updated_at, creator_email, tags) VALUES \
             ('shq-suite-0041', 41, 'decision', 'shq-suite', 'Legacy', 'Legacy summary.', \
             'Legacy state.', 'proposed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', \
             'dev@example.com', '[]')",
        )
        .execute(&raw)
        .await
        .unwrap();
        raw.close().await;

        let state = Arc::new(AppState {
            retriever: None,
            cfg: Config::default(),
            reindex_trigger: None,
            ledger: Some(ledger),
            ledger_trigger: None,
            summariser: None,
            prompts: None,
            tracker_ready: false,
        });
        let who = serde_json::json!({ "author_email": "dev@example.com" });
        let with = |extra: serde_json::Value| {
            let mut v = who.clone();
            v.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            v
        };

        // Create: the next number after the legacy 41, in the new form.
        let (st, created) = call(
            &state,
            "POST",
            "/ledger",
            Some(serde_json::json!({
                "type": "decision", "repo": "shq-suite", "title": "New",
                "summary": "New summary.", "initial_state": "New state.",
                "creator_email": "dev@example.com",
            })),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "{created}");
        assert_eq!(created["topic_id"], "shq-suite-l0042");

        // Get and append, both forms.
        for id in ["shq-suite-0041", "shq-suite-l0042"] {
            let (st, got) = call(&state, "GET", &format!("/ledger/{id}"), None).await;
            assert_eq!(st, StatusCode::OK, "{id}: {got}");
            assert_eq!(got["topic_id"], id);
            let (st, ev) = call(
                &state,
                "POST",
                &format!("/ledger/{id}/append"),
                Some(with(serde_json::json!({ "body": "Noted." }))),
            )
            .await;
            assert_eq!(st, StatusCode::OK, "{id}: {ev}");
            assert_eq!(ev["body"], "Noted.");
        }

        // Archive both, find both in the archived search, restore.
        for id in ["shq-suite-0041", "shq-suite-l0042"] {
            let (st, a) = call(
                &state,
                "POST",
                &format!("/ledger/{id}/archive"),
                Some(who.clone()),
            )
            .await;
            assert_eq!(st, StatusCode::OK, "{id}: {a}");
        }
        let (st, found) = call(
            &state,
            "POST",
            "/ledger/search",
            Some(serde_json::json!({ "query": "", "archived": true })),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "{found}");
        let mut ids: Vec<&str> = found["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| h["topic_id"].as_str().unwrap())
            .collect();
        ids.sort_unstable();
        assert_eq!(ids, ["shq-suite-0041", "shq-suite-l0042"]);
        for id in ["shq-suite-0041", "shq-suite-l0042"] {
            call(
                &state,
                "POST",
                &format!("/ledger/{id}/archive"),
                Some(with(serde_json::json!({ "archived": false }))),
            )
            .await;
        }

        // Move the legacy id: a new-form id in the destination, and the old id
        // answers with the redirect pointer.
        let (st, moved) = call(
            &state,
            "POST",
            "/ledger/shq-suite-0041/move",
            Some(with(serde_json::json!({ "repo": "rag" }))),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "{moved}");
        assert_eq!(moved["topic_id"], "rag-l0001");
        let (st, pointer) = call(&state, "GET", "/ledger/shq-suite-0041", None).await;
        assert_eq!(st, StatusCode::OK, "{pointer}");
        assert_eq!(pointer["moved"], true);
        assert_eq!(pointer["moved_to"], "rag-l0001");

        // The moved-away legacy number is not reissued in either form.
        let (_, next) = call(
            &state,
            "POST",
            "/ledger",
            Some(serde_json::json!({
                "type": "defect", "repo": "shq-suite", "title": "Next",
                "summary": "s", "initial_state": "i", "creator_email": "dev@example.com",
            })),
        )
        .await;
        assert_eq!(next["topic_id"], "shq-suite-l0043");
    }
}
