//! The tracker's HTTP routes (`specs/tracker/master.md` D11, milestone m01 TR-07).
//!
//! The contract these routes implement is written down in
//! `specs/tracker/api.md`, which the MCP server (m02) and the web UI (m03, m04)
//! are built from. **Change that document with the code.**
//!
//! Conventions, in the ledger routes' style:
//!
//! * JSON in and out. Every write carries `author_email` (required), `agent`
//!   (optional; recorded as `Unknown` when absent) and `surface` (`web` or `mcp`).
//! * Request bodies are parsed here rather than by axum's `Json` extractor, so a
//!   malformed body, an unknown field or a bad enum value is a **400** with the
//!   same `{"error": …}` body as every other refusal, not axum's plain-text 422.
//!   Unknown fields are refused: a mistyped field name would otherwise be a
//!   silent no-op.
//! * A `note` is optional on every write (D7, amended 2026-10-27); the store
//!   generates the event's body from the change when there is none. Only a bare
//!   note (a write that changes nothing else) must carry text.
//! * 503 when the store did not open; 400 for a refusal (the store's message);
//!   404 for an unknown record; 409 for an edit against a stale revision,
//!   carrying the current revision and document.
//! * The queue view carries an `ETag` and answers a matching `If-None-Match`
//!   with 304, so the dashboard's 10-second poll is cheap.

use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{
        multipart::MultipartRejection, DefaultBodyLimit, FromRequestParts, Multipart, Path, Query,
        State,
    },
    http::{header, request::Parts, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

use rag_core::hashing::hash_str;
use rag_core::tracker::{
    Actor, Approval, BlockReason, ConceptState, ConceptUpdate, DocKind, Edit, Intensity,
    ItemStatus, ItemType, ItemUpdate, Link, MilestoneState, MilestoneUpdate, NewAttachment,
    NewConcept, NewDocument, NewItem, NewMilestone, NewSpec, Place, Replacement, SpecState,
    SpecUpdate, Surface, TrackerError, TrackerStore, MAX_ATTACHMENT_BYTES,
};

/// Body limit for the JSON routes: a document may be up to 4 MB, and JSON
/// escaping can nearly double that.
const JSON_BODY_LIMIT: usize = 9 * 1024 * 1024;

/// Body limit for an upload: the 50 MB cap plus room for the multipart framing
/// and the text fields. The store enforces the cap itself, with a clear message.
const UPLOAD_BODY_LIMIT: usize = MAX_ATTACHMENT_BYTES + 1024 * 1024;

/// The routes' state: the store, or `None` when it could not be opened.
pub struct TrackerApi {
    store: Option<TrackerStore>,
}

impl TrackerApi {
    fn store(&self) -> Result<&TrackerStore, ApiError> {
        self.store
            .as_ref()
            .ok_or_else(|| ApiError::Unavailable("tracker store unavailable".into()))
    }
}

type St = State<Arc<TrackerApi>>;

/// Every tracker route, ready to merge into the service's router.
///
/// `reindex_trigger` is the file touched after every successful write (any `POST`
/// answered 2xx), which starts the tracker reconcile (`rag-ingest
/// reconcile-tracker`, m05 TS-01) through a systemd `.path` unit, as the ledger's
/// trigger does; `None` disables it and the 15-minute timer alone keeps
/// `corpus = tracker` current.
pub fn router(store: Option<TrackerStore>, reindex_trigger: Option<PathBuf>) -> Router {
    let state = Arc::new(TrackerApi { store });
    Router::new()
        .route("/tracker/projects", get(projects))
        .route("/tracker/{project}", get(queue_view))
        .route("/tracker/{project}/check", get(check))
        .route("/tracker/{project}/ack-done", post(ack_done))
        .route("/tracker/{project}/labels", get(labels_list))
        .route(
            "/tracker/{project}/items",
            get(items_list).post(item_create),
        )
        .route("/tracker/items/{id}", get(item_get).post(item_update))
        .route("/tracker/items/{id}/move", post(item_move))
        .route("/tracker/{project}/docs", get(docs_list).post(doc_create))
        .route("/tracker/{project}/doc", get(doc_by_path))
        .route("/tracker/docs/{id}", get(doc_get))
        .route("/tracker/docs/{id}/edit", post(doc_edit))
        .route("/tracker/docs/{id}/write", post(doc_write))
        .route("/tracker/docs/{id}/rename", post(doc_rename))
        .route("/tracker/docs/{id}/restore", post(doc_restore))
        .route("/tracker/docs/{id}/revisions", get(doc_revisions))
        .route("/tracker/docs/{id}/diff", get(doc_diff))
        .route(
            "/tracker/{project}/specs",
            get(specs_list).post(spec_create),
        )
        .route(
            "/tracker/{project}/specs/{slug}",
            get(spec_get).post(spec_update),
        )
        .route(
            "/tracker/{project}/specs/{slug}/milestones",
            post(milestone_create),
        )
        .route(
            "/tracker/{project}/specs/{slug}/milestones/{code}",
            get(milestone_get).post(milestone_update),
        )
        .route(
            "/tracker/{project}/concepts",
            get(concepts_list).post(concept_create),
        )
        .route(
            "/tracker/{project}/concepts/{slug}",
            get(concept_get).post(concept_update),
        )
        .route(
            "/tracker/{project}/attachments",
            get(attachments_list)
                .post(attachment_upload)
                .layer(DefaultBodyLimit::max(UPLOAD_BODY_LIMIT)),
        )
        .route("/tracker/attachments/{hash}", get(attachment_get))
        .layer(DefaultBodyLimit::max(JSON_BODY_LIMIT))
        .layer(middleware::from_fn_with_state(
            reindex_trigger,
            reindex_after_write,
        ))
        .with_state(state)
}

/// Touch the reconcile trigger once a write has succeeded. Every tracker `POST`
/// is a write and every write may change what is indexed; a refusal changed
/// nothing, and a `GET` never does, so neither fires it. Fire-and-forget: a
/// failure only means the timer catches the change instead.
async fn reindex_after_write(
    State(trigger): State<Option<PathBuf>>,
    req: axum::extract::Request,
    next: Next,
) -> Response {
    let write = req.method() == Method::POST;
    let res = next.run(req).await;
    if let (true, Some(path)) = (write && res.status().is_success(), trigger.as_ref()) {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if let Err(e) = tokio::fs::write(path, format!("{stamp}\n")).await {
            tracing::warn!(error = %e, trigger = %path.display(), "failed to write tracker trigger");
        }
    }
    res
}

// ---- Errors -------------------------------------------------------------------

/// The tracker routes' errors: `{"error": "..."}` with a status, and for a
/// stale edit also `current_revision` and `current` (the document as it is now).
pub enum ApiError {
    BadRequest(String),
    NotFound(String),
    Conflict {
        message: String,
        current_revision: i64,
        current: Option<serde_json::Value>,
    },
    Status(StatusCode, String),
    Unavailable(String),
    Internal(String),
}

impl From<TrackerError> for ApiError {
    fn from(e: TrackerError) -> Self {
        match e {
            TrackerError::Refused(m) => ApiError::BadRequest(m),
            TrackerError::NotFound(m) => ApiError::NotFound(m),
            TrackerError::Stale {
                message,
                current_revision,
            } => ApiError::Conflict {
                message,
                current_revision,
                current: None,
            },
            e @ TrackerError::Internal(_) => ApiError::Internal(e.to_string()),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, body) = match self {
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, serde_json::json!({ "error": m })),
            ApiError::NotFound(m) => (StatusCode::NOT_FOUND, serde_json::json!({ "error": m })),
            ApiError::Conflict {
                message,
                current_revision,
                current,
            } => (
                StatusCode::CONFLICT,
                serde_json::json!({ "error": message, "current_revision": current_revision, "current": current }),
            ),
            ApiError::Status(s, m) => (s, serde_json::json!({ "error": m })),
            ApiError::Unavailable(m) => (
                StatusCode::SERVICE_UNAVAILABLE,
                serde_json::json!({ "error": m }),
            ),
            ApiError::Internal(m) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                serde_json::json!({ "error": m }),
            ),
        };
        (status, Json(body)).into_response()
    }
}

type ApiResult = Result<Response, ApiError>;

/// Parse a JSON body, turning any failure into a 400 that names the problem.
fn parse<T: DeserializeOwned>(body: &Bytes) -> Result<T, ApiError> {
    if body.is_empty() {
        return Err(ApiError::BadRequest(
            "a JSON request body is required".into(),
        ));
    }
    serde_json::from_slice(body)
        .map_err(|e| ApiError::BadRequest(format!("invalid request body: {e}")))
}

fn ok<T: Serialize>(value: &T) -> ApiResult {
    Ok(Json(value).into_response())
}

fn not_found(what: String) -> ApiError {
    ApiError::NotFound(what)
}

/// A query string, parsed with a refusal in the routes' own `{"error": …}` shape.
struct Q<T>(T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequestParts<S> for Q<T> {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, ApiError> {
        Query::<T>::from_request_parts(parts, state)
            .await
            .map(|Query(t)| Q(t))
            .map_err(|e| ApiError::BadRequest(format!("invalid query string: {}", e.body_text())))
    }
}

/// The `?history=false` switch on the record reads.
#[derive(Deserialize)]
struct HistoryQuery {
    #[serde(default)]
    history: Option<bool>,
}

impl HistoryQuery {
    fn history(&self) -> bool {
        self.history.unwrap_or(true)
    }
}

fn place_of(
    before: Option<String>,
    after: Option<String>,
    top: bool,
    bottom: bool,
    required: bool,
) -> Result<Option<Place>, ApiError> {
    let given = before.is_some() as u8 + after.is_some() as u8 + top as u8 + bottom as u8;
    if given > 1 {
        return Err(ApiError::BadRequest(
            "give at most one of before, after, top and bottom".into(),
        ));
    }
    if given == 0 {
        return if required {
            Err(ApiError::BadRequest(
                "a move needs one of before, after, top or bottom".into(),
            ))
        } else {
            Ok(None)
        };
    }
    Ok(Some(match (before, after) {
        (Some(b), _) => Place::Before(b),
        (_, Some(a)) => Place::After(a),
        _ if top => Place::Top,
        _ => Place::Bottom,
    }))
}

// ---- Projects, the queue view and the check --------------------------------------

async fn projects(State(api): St) -> ApiResult {
    let projects = api.store()?.list_projects().await?;
    ok(&serde_json::json!({ "projects": projects }))
}

/// Whether an `If-None-Match` header matches `etag`.
fn etag_matches(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|t| t.trim().trim_start_matches("W/"))
        .any(|t| t == "*" || t == etag)
}

async fn queue_view(State(api): St, Path(project): Path<String>, headers: HeaderMap) -> ApiResult {
    rag_core::tracker::validate_project(&project)?;
    let view = api.store()?.queue_view(&project).await?;
    let body = serde_json::to_vec(&view).map_err(|e| ApiError::Internal(e.to_string()))?;
    let etag = format!("\"{}\"", &hash_str(&String::from_utf8_lossy(&body))[..32]);
    let etag_value = HeaderValue::from_str(&etag).map_err(|e| ApiError::Internal(e.to_string()))?;
    let cache = (header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    if etag_matches(&headers, &etag) {
        return Ok((
            StatusCode::NOT_MODIFIED,
            [(header::ETAG, etag_value), cache],
        )
            .into_response());
    }
    Ok((
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            ),
            (header::ETAG, etag_value),
            cache,
        ],
        body,
    )
        .into_response())
}

async fn check(State(api): St, Path(project): Path<String>) -> ApiResult {
    ok(&api.store()?.check(&project).await?)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AckBody {
    author_email: String,
    #[serde(default)]
    agent: Option<String>,
    surface: Surface,
}

async fn ack_done(State(api): St, Path(project): Path<String>, body: Bytes) -> ApiResult {
    let b: AckBody = parse(&body)?;
    let actor = Actor::new(b.author_email, b.agent.as_deref(), b.surface);
    let acknowledged = api.store()?.acknowledge_done(&project, &actor).await?;
    ok(&serde_json::json!({ "project": project, "acknowledged": acknowledged }))
}

// ---- Items ----------------------------------------------------------------------

#[derive(Deserialize)]
struct ItemsQuery {
    #[serde(default)]
    status: Option<String>,
    /// Only items carrying this label, matched case-insensitively (rag-t0027).
    #[serde(default)]
    label: Option<String>,
}

async fn items_list(State(api): St, Path(project): Path<String>, Q(q): Q<ItemsQuery>) -> ApiResult {
    let status = q
        .status
        .as_deref()
        .map(str::parse::<ItemStatus>)
        .transpose()?;
    let items = api
        .store()?
        .list_items(&project, status, q.label.as_deref())
        .await?;
    ok(&serde_json::json!({ "project": project, "items": items }))
}

/// A project's label vocabulary (rag-t0027): each label its items carry, in the
/// project's casing, with how many items carry it and how many of those are
/// queued. The pickers' suggestions and the dashboard's filter read it.
async fn labels_list(State(api): St, Path(project): Path<String>) -> ApiResult {
    rag_core::tracker::validate_project(&project)?;
    let labels = api.store()?.project_labels(&project).await?;
    ok(&serde_json::json!({ "project": project, "labels": labels }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ItemCreateBody {
    #[serde(rename = "type")]
    item_type: ItemType,
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    assignee: Option<String>,
    #[serde(default)]
    approval: Option<Approval>,
    #[serde(default)]
    links: Vec<Link>,
    #[serde(default)]
    intensity: Option<Intensity>,
    #[serde(default)]
    release: bool,
    #[serde(default)]
    parallel: bool,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    after: Option<String>,
    #[serde(default)]
    top: bool,
    #[serde(default)]
    bottom: bool,
    #[serde(default)]
    note: Option<String>,
    author_email: String,
    #[serde(default)]
    agent: Option<String>,
    surface: Surface,
}

async fn item_create(State(api): St, Path(project): Path<String>, body: Bytes) -> ApiResult {
    let b: ItemCreateBody = parse(&body)?;
    let place = place_of(b.before, b.after, b.top, b.bottom, false)?.unwrap_or(Place::Bottom);
    let actor = Actor::new(b.author_email, b.agent.as_deref(), b.surface);
    let rec = api
        .store()?
        .create_item(
            NewItem {
                project,
                item_type: b.item_type,
                title: b.title,
                body: b.body,
                assignee: b.assignee,
                approval: b.approval.unwrap_or(Approval::Unapproved),
                links: b.links,
                intensity: b.intensity,
                release: b.release,
                parallel: b.parallel,
                labels: b.labels,
                place,
                note: b.note,
            },
            &actor,
        )
        .await?;
    ok(&rec)
}

async fn item_get(State(api): St, Path(id): Path<String>, Q(q): Q<HistoryQuery>) -> ApiResult {
    match api.store()?.get_item(&id, q.history()).await? {
        Some(rec) => ok(&rec),
        None => Err(not_found(format!("no item {id:?}"))),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ItemUpdateBody {
    #[serde(default)]
    status: Option<ItemStatus>,
    #[serde(default)]
    blocked: Option<bool>,
    #[serde(default)]
    block_reason: Option<BlockReason>,
    #[serde(default)]
    depends_on: Option<Vec<String>>,
    #[serde(default)]
    approval: Option<Approval>,
    #[serde(default)]
    assignee: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    add_links: Vec<Link>,
    #[serde(default)]
    remove_links: Vec<Link>,
    #[serde(default)]
    intensity: Option<Intensity>,
    #[serde(default)]
    release: Option<bool>,
    #[serde(default)]
    parallel: Option<bool>,
    #[serde(default)]
    labels: Option<Vec<String>>,
    #[serde(default)]
    note: Option<String>,
    author_email: String,
    #[serde(default)]
    agent: Option<String>,
    surface: Surface,
}

async fn item_update(State(api): St, Path(id): Path<String>, body: Bytes) -> ApiResult {
    let b: ItemUpdateBody = parse(&body)?;
    let actor = Actor::new(b.author_email, b.agent.as_deref(), b.surface);
    let rec = api
        .store()?
        .update_item(
            &id,
            ItemUpdate {
                status: b.status,
                blocked: b.blocked,
                block_reason: b.block_reason,
                depends_on: b.depends_on,
                approval: b.approval,
                assignee: b.assignee,
                title: b.title,
                body: b.body,
                add_links: b.add_links,
                remove_links: b.remove_links,
                intensity: b.intensity,
                release: b.release,
                parallel: b.parallel,
                labels: b.labels,
                note: b.note,
            },
            &actor,
        )
        .await?;
    ok(&rec)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MoveBody {
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    after: Option<String>,
    #[serde(default)]
    top: bool,
    #[serde(default)]
    bottom: bool,
    #[serde(default)]
    note: Option<String>,
    author_email: String,
    #[serde(default)]
    agent: Option<String>,
    surface: Surface,
}

async fn item_move(State(api): St, Path(id): Path<String>, body: Bytes) -> ApiResult {
    let b: MoveBody = parse(&body)?;
    let place = place_of(b.before, b.after, b.top, b.bottom, true)?.expect("required place");
    let actor = Actor::new(b.author_email, b.agent.as_deref(), b.surface);
    let rec = api
        .store()?
        .move_item(&id, place, b.note.as_deref(), &actor)
        .await?;
    ok(&rec)
}

// ---- Documents ------------------------------------------------------------------

#[derive(Deserialize)]
struct DocsQuery {
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    prefix: Option<String>,
}

async fn docs_list(State(api): St, Path(project): Path<String>, Q(q): Q<DocsQuery>) -> ApiResult {
    let kind = q.kind.as_deref().map(str::parse::<DocKind>).transpose()?;
    let documents = api
        .store()?
        .list_documents(&project, kind, q.prefix.as_deref())
        .await?;
    ok(&serde_json::json!({ "project": project, "documents": documents }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DocCreateBody {
    path: String,
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    message: Option<String>,
    author_email: String,
    #[serde(default)]
    agent: Option<String>,
    surface: Surface,
}

async fn doc_create(State(api): St, Path(project): Path<String>, body: Bytes) -> ApiResult {
    let b: DocCreateBody = parse(&body)?;
    let actor = Actor::new(b.author_email, b.agent.as_deref(), b.surface);
    let view = api
        .store()?
        .create_document(
            NewDocument {
                project,
                path: b.path,
                title: b.title,
                body: b.body,
                message: b.message,
            },
            &actor,
        )
        .await?;
    ok(&view)
}

#[derive(Deserialize)]
struct DocQuery {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    revision: Option<i64>,
    #[serde(default)]
    history: Option<bool>,
}

async fn doc_by_path(State(api): St, Path(project): Path<String>, Q(q): Q<DocQuery>) -> ApiResult {
    let path = q
        .path
        .ok_or_else(|| ApiError::BadRequest("?path= is required".into()))?;
    match api
        .store()?
        .get_document_by_path(&project, &path, q.revision, q.history.unwrap_or(true))
        .await?
    {
        Some(view) => ok(&view),
        None => Err(not_found(format!(
            "no document at {path:?} in project {project}"
        ))),
    }
}

async fn doc_get(State(api): St, Path(id): Path<String>, Q(q): Q<DocQuery>) -> ApiResult {
    if q.path.is_some() {
        return Err(ApiError::BadRequest(
            "?path= belongs on /tracker/{project}/doc".into(),
        ));
    }
    match api
        .store()?
        .get_document(&id, q.revision, q.history.unwrap_or(true))
        .await?
    {
        Some(view) => ok(&view),
        None => Err(not_found(format!("no document {id:?}"))),
    }
}

/// Map a stale refusal to a 409 carrying the document as it is now, so a client
/// can show the newer revision without a second request.
async fn with_current(api: &TrackerApi, id: &str, e: TrackerError) -> ApiError {
    let mut err = ApiError::from(e);
    if let ApiError::Conflict { current, .. } = &mut err {
        if let Ok(store) = api.store() {
            if let Ok(Some(view)) = store.get_document(id, None, false).await {
                *current = serde_json::to_value(view).ok();
            }
        }
    }
    err
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DocEditBody {
    base_revision: i64,
    replacements: Vec<Replacement>,
    #[serde(default)]
    message: Option<String>,
    author_email: String,
    #[serde(default)]
    agent: Option<String>,
    surface: Surface,
}

async fn doc_edit(State(api): St, Path(id): Path<String>, body: Bytes) -> ApiResult {
    let b: DocEditBody = parse(&body)?;
    let actor = Actor::new(b.author_email, b.agent.as_deref(), b.surface);
    match api
        .store()?
        .edit_document(
            &id,
            b.base_revision,
            Edit::Replace(b.replacements),
            b.message.as_deref(),
            &actor,
        )
        .await
    {
        Ok(view) => ok(&view),
        Err(e) => Err(with_current(&api, &id, e).await),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DocWriteBody {
    base_revision: i64,
    body: String,
    #[serde(default)]
    message: Option<String>,
    author_email: String,
    #[serde(default)]
    agent: Option<String>,
    surface: Surface,
}

async fn doc_write(State(api): St, Path(id): Path<String>, body: Bytes) -> ApiResult {
    let b: DocWriteBody = parse(&body)?;
    let actor = Actor::new(b.author_email, b.agent.as_deref(), b.surface);
    match api
        .store()?
        .edit_document(
            &id,
            b.base_revision,
            Edit::Body(b.body),
            b.message.as_deref(),
            &actor,
        )
        .await
    {
        Ok(view) => ok(&view),
        Err(e) => Err(with_current(&api, &id, e).await),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DocRenameBody {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    note: Option<String>,
    author_email: String,
    #[serde(default)]
    agent: Option<String>,
    surface: Surface,
}

async fn doc_rename(State(api): St, Path(id): Path<String>, body: Bytes) -> ApiResult {
    let b: DocRenameBody = parse(&body)?;
    let actor = Actor::new(b.author_email, b.agent.as_deref(), b.surface);
    let view = api
        .store()?
        .rename_document(
            &id,
            b.path.as_deref(),
            b.title.as_deref(),
            b.note.as_deref(),
            &actor,
        )
        .await?;
    ok(&view)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DocRestoreBody {
    revision: i64,
    base_revision: i64,
    #[serde(default)]
    message: Option<String>,
    author_email: String,
    #[serde(default)]
    agent: Option<String>,
    surface: Surface,
}

async fn doc_restore(State(api): St, Path(id): Path<String>, body: Bytes) -> ApiResult {
    let b: DocRestoreBody = parse(&body)?;
    let actor = Actor::new(b.author_email, b.agent.as_deref(), b.surface);
    match api
        .store()?
        .restore_revision(
            &id,
            b.revision,
            b.base_revision,
            b.message.as_deref(),
            &actor,
        )
        .await
    {
        Ok(view) => ok(&view),
        Err(e) => Err(with_current(&api, &id, e).await),
    }
}

async fn doc_revisions(State(api): St, Path(id): Path<String>) -> ApiResult {
    let revisions = api.store()?.list_revisions(&id).await?;
    ok(&serde_json::json!({ "doc_id": id, "revisions": revisions }))
}

#[derive(Deserialize)]
struct DiffQuery {
    #[serde(default)]
    from: Option<i64>,
    #[serde(default)]
    to: Option<i64>,
}

async fn doc_diff(State(api): St, Path(id): Path<String>, Q(q): Q<DiffQuery>) -> ApiResult {
    ok(&api.store()?.diff_revisions(&id, q.from, q.to).await?)
}

// ---- Specs and milestones ---------------------------------------------------------

async fn specs_list(State(api): St, Path(project): Path<String>) -> ApiResult {
    let specs = api.store()?.list_specs(&project).await?;
    ok(&serde_json::json!({ "project": project, "specs": specs }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MilestoneInput {
    code: String,
    title: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    state: Option<MilestoneState>,
    #[serde(default)]
    approval: Option<Approval>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    note: Option<String>,
}

impl From<MilestoneInput> for NewMilestone {
    fn from(m: MilestoneInput) -> Self {
        NewMilestone {
            code: m.code,
            title: m.title,
            name: m.name,
            state: m.state,
            approval: m.approval.unwrap_or(Approval::Unapproved),
            body: m.body,
            note: m.note,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SpecCreateBody {
    slug: String,
    title: String,
    #[serde(default)]
    state: Option<SpecState>,
    #[serde(default)]
    approval: Option<Approval>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    milestones: Vec<MilestoneInput>,
    #[serde(default)]
    note: Option<String>,
    author_email: String,
    #[serde(default)]
    agent: Option<String>,
    surface: Surface,
}

async fn spec_create(State(api): St, Path(project): Path<String>, body: Bytes) -> ApiResult {
    let b: SpecCreateBody = parse(&body)?;
    let actor = Actor::new(b.author_email, b.agent.as_deref(), b.surface);
    let rec = api
        .store()?
        .create_spec(
            NewSpec {
                project,
                slug: b.slug,
                title: b.title,
                state: b.state,
                approval: b.approval.unwrap_or(Approval::Unapproved),
                body: b.body,
                milestones: b.milestones.into_iter().map(Into::into).collect(),
                note: b.note,
            },
            &actor,
        )
        .await?;
    ok(&rec)
}

async fn spec_get(
    State(api): St,
    Path((project, slug)): Path<(String, String)>,
    Q(q): Q<HistoryQuery>,
) -> ApiResult {
    match api.store()?.get_spec(&project, &slug, q.history()).await? {
        Some(rec) => ok(&rec),
        None => Err(not_found(format!("no spec {slug:?} in project {project}"))),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SpecUpdateBody {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    state: Option<SpecState>,
    #[serde(default)]
    approval: Option<Approval>,
    #[serde(default)]
    note: Option<String>,
    author_email: String,
    #[serde(default)]
    agent: Option<String>,
    surface: Surface,
}

async fn spec_update(
    State(api): St,
    Path((project, slug)): Path<(String, String)>,
    body: Bytes,
) -> ApiResult {
    let b: SpecUpdateBody = parse(&body)?;
    let actor = Actor::new(b.author_email, b.agent.as_deref(), b.surface);
    let rec = api
        .store()?
        .update_spec(
            &project,
            &slug,
            SpecUpdate {
                title: b.title,
                state: b.state,
                approval: b.approval,
                note: b.note,
            },
            &actor,
        )
        .await?;
    ok(&rec)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MilestoneCreateBody {
    code: String,
    title: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    state: Option<MilestoneState>,
    #[serde(default)]
    approval: Option<Approval>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    note: Option<String>,
    author_email: String,
    #[serde(default)]
    agent: Option<String>,
    surface: Surface,
}

async fn milestone_create(
    State(api): St,
    Path((project, slug)): Path<(String, String)>,
    body: Bytes,
) -> ApiResult {
    let b: MilestoneCreateBody = parse(&body)?;
    let actor = Actor::new(b.author_email, b.agent.as_deref(), b.surface);
    let new = NewMilestone {
        code: b.code,
        title: b.title,
        name: b.name,
        state: b.state,
        approval: b.approval.unwrap_or(Approval::Unapproved),
        body: b.body,
        note: b.note,
    };
    ok(&api
        .store()?
        .create_milestone(&project, &slug, new, &actor)
        .await?)
}

async fn milestone_get(
    State(api): St,
    Path((project, slug, code)): Path<(String, String, String)>,
    Q(q): Q<HistoryQuery>,
) -> ApiResult {
    match api
        .store()?
        .get_milestone(&project, &slug, &code, q.history())
        .await?
    {
        Some(rec) => ok(&rec),
        None => Err(not_found(format!(
            "no milestone {slug}/{code} in project {project}"
        ))),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MilestoneUpdateBody {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    state: Option<MilestoneState>,
    #[serde(default)]
    approval: Option<Approval>,
    #[serde(default)]
    order: Option<i64>,
    #[serde(default)]
    note: Option<String>,
    author_email: String,
    #[serde(default)]
    agent: Option<String>,
    surface: Surface,
}

async fn milestone_update(
    State(api): St,
    Path((project, slug, code)): Path<(String, String, String)>,
    body: Bytes,
) -> ApiResult {
    let b: MilestoneUpdateBody = parse(&body)?;
    let actor = Actor::new(b.author_email, b.agent.as_deref(), b.surface);
    let upd = MilestoneUpdate {
        title: b.title,
        state: b.state,
        approval: b.approval,
        order: b.order,
        note: b.note,
    };
    ok(&api
        .store()?
        .update_milestone(&project, &slug, &code, upd, &actor)
        .await?)
}

// ---- Concepts -------------------------------------------------------------------

#[derive(Deserialize)]
struct ConceptsQuery {
    #[serde(default)]
    state: Option<String>,
}

async fn concepts_list(
    State(api): St,
    Path(project): Path<String>,
    Q(q): Q<ConceptsQuery>,
) -> ApiResult {
    let state = q
        .state
        .as_deref()
        .map(str::parse::<ConceptState>)
        .transpose()?;
    let concepts = api.store()?.list_concepts(&project, state).await?;
    ok(&serde_json::json!({ "project": project, "concepts": concepts }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConceptCreateBody {
    slug: String,
    title: String,
    #[serde(default)]
    state: Option<ConceptState>,
    #[serde(default)]
    approval: Option<Approval>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    links: Vec<Link>,
    #[serde(default)]
    note: Option<String>,
    author_email: String,
    #[serde(default)]
    agent: Option<String>,
    surface: Surface,
}

async fn concept_create(State(api): St, Path(project): Path<String>, body: Bytes) -> ApiResult {
    let b: ConceptCreateBody = parse(&body)?;
    let actor = Actor::new(b.author_email, b.agent.as_deref(), b.surface);
    let rec = api
        .store()?
        .create_concept(
            NewConcept {
                project,
                slug: b.slug,
                title: b.title,
                state: b.state,
                approval: b.approval.unwrap_or(Approval::Unapproved),
                body: b.body,
                links: b.links,
                note: b.note,
            },
            &actor,
        )
        .await?;
    ok(&rec)
}

async fn concept_get(
    State(api): St,
    Path((project, slug)): Path<(String, String)>,
    Q(q): Q<HistoryQuery>,
) -> ApiResult {
    match api
        .store()?
        .get_concept(&project, &slug, q.history())
        .await?
    {
        Some(rec) => ok(&rec),
        None => Err(not_found(format!(
            "no concept {slug:?} in project {project}"
        ))),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConceptUpdateBody {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    state: Option<ConceptState>,
    #[serde(default)]
    approval: Option<Approval>,
    #[serde(default)]
    add_links: Vec<Link>,
    #[serde(default)]
    remove_links: Vec<Link>,
    #[serde(default)]
    note: Option<String>,
    author_email: String,
    #[serde(default)]
    agent: Option<String>,
    surface: Surface,
}

async fn concept_update(
    State(api): St,
    Path((project, slug)): Path<(String, String)>,
    body: Bytes,
) -> ApiResult {
    let b: ConceptUpdateBody = parse(&body)?;
    let actor = Actor::new(b.author_email, b.agent.as_deref(), b.surface);
    let upd = ConceptUpdate {
        title: b.title,
        state: b.state,
        approval: b.approval,
        add_links: b.add_links,
        remove_links: b.remove_links,
        note: b.note,
    };
    ok(&api
        .store()?
        .update_concept(&project, &slug, upd, &actor)
        .await?)
}

// ---- Attachments ----------------------------------------------------------------

async fn attachments_list(State(api): St, Path(project): Path<String>) -> ApiResult {
    let attachments = api.store()?.list_attachments(&project).await?;
    ok(&serde_json::json!({ "project": project, "attachments": attachments }))
}

/// `POST /tracker/{project}/attachments`, multipart: a `file` part (its file name
/// and content type are the upload's), and text parts `author_email`, `agent`
/// (optional), `surface` and `name` (optional, overrides the file name).
async fn attachment_upload(
    State(api): St,
    Path(project): Path<String>,
    form: Result<Multipart, MultipartRejection>,
) -> ApiResult {
    let store = api.store()?;
    let mut form = form.map_err(|e| {
        ApiError::BadRequest(format!(
            "an upload is multipart/form-data: {}",
            e.body_text()
        ))
    })?;
    let mut file: Option<(String, Option<String>, Vec<u8>)> = None;
    let (mut email, mut agent, mut surface, mut name) = (None, None, None, None);
    let multipart_err =
        |e: axum::extract::multipart::MultipartError| ApiError::Status(e.status(), e.body_text());
    while let Some(field) = form.next_field().await.map_err(multipart_err)? {
        let field_name = field.name().unwrap_or("").to_string();
        match field_name.as_str() {
            "file" => {
                let file_name = field.file_name().unwrap_or("").to_string();
                let media = field.content_type().map(str::to_string);
                let bytes = field.bytes().await.map_err(multipart_err)?;
                file = Some((file_name, media, bytes.to_vec()));
            }
            "author_email" => email = Some(field.text().await.map_err(multipart_err)?),
            "agent" => agent = Some(field.text().await.map_err(multipart_err)?),
            "surface" => surface = Some(field.text().await.map_err(multipart_err)?),
            "name" => name = Some(field.text().await.map_err(multipart_err)?),
            other => {
                return Err(ApiError::BadRequest(format!(
                    "unknown multipart field {other:?}"
                )))
            }
        }
    }
    let (file_name, media, bytes) =
        file.ok_or_else(|| ApiError::BadRequest("a `file` part is required".into()))?;
    let email =
        email.ok_or_else(|| ApiError::BadRequest("an `author_email` part is required".into()))?;
    let surface: Surface = surface
        .ok_or_else(|| ApiError::BadRequest("a `surface` part is required (web|mcp)".into()))?
        .parse()?;
    // `application/octet-stream` is what a client sends when it does not know;
    // treat it as undeclared so an image is still recognised by its bytes.
    let media = media.filter(|m| m != "application/octet-stream");
    let actor = Actor::new(email, agent.as_deref(), surface);
    let att = store
        .store_attachment(
            NewAttachment {
                project,
                name: name.filter(|n| !n.trim().is_empty()).unwrap_or(file_name),
                media_type: media,
                bytes,
            },
            &actor,
        )
        .await?;
    ok(&att)
}

/// `GET /tracker/attachments/{hash}`: the bytes, with headers that keep an
/// uploaded file from running as part of this origin.
async fn attachment_get(State(api): St, Path(hash): Path<String>) -> ApiResult {
    let found = api.store()?.find_attachment(&hash).await?;
    let bytes = tokio::fs::read(&found.path)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    let a = found.attachment;
    let media = HeaderValue::from_str(&a.media_type)
        .unwrap_or(HeaderValue::from_static("application/octet-stream"));
    // Raster images display inline; anything else (SVG included) downloads, so
    // an uploaded HTML or SVG file never renders as a page of this origin.
    let raster = a.media_type.starts_with("image/") && a.media_type != "image/svg+xml";
    let safe_name: String = a
        .name
        .chars()
        .map(|c| {
            if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let disposition = format!(
        "{}; filename=\"{safe_name}\"",
        if raster { "inline" } else { "attachment" }
    );
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, media);
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&disposition).unwrap_or(HeaderValue::from_static("attachment")),
    );
    headers.insert(
        header::ETAG,
        HeaderValue::from_str(&format!("\"{}\"", a.sha256))
            .map_err(|e| ApiError::Internal(e.to_string()))?,
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        ),
    );
    Ok((StatusCode::OK, headers, bytes).into_response())
}

#[cfg(test)]
mod tests;
