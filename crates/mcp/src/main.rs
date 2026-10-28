//! `rag-mcp` — MCP server(s) exposing the RAG backend as tools (Phase 06 + 10).
//!
//! A thin MCP shell over the HTTP service (`rag-serve`): every tool forwards to
//! `{RAG_SERVE_URL}/...` and returns the response. **It holds no API key** — Voyage
//! auth lives server-side in `rag-serve`, so the key never reaches a client box
//! (same as the Skill).
//!
//! One binary, three server *modes* selected by `--server`, so they register as
//! separate MCP servers and the agent's tool-use history reads "Calling rag…",
//! "Calling ledger…" or "Calling tracker…" rather than lumping writes under retrieval:
//!   - `--server corpus` (default): `search_corpus`, `reindex_corpus`.
//!   - `--server ledger`: `ledger_search`, `ledger_get`, `ledger_create`, `ledger_append`,
//!     `ledger_move`, `ledger_archive`.
//!   - `--server tracker`: the `tracker_*` tools (the queue, specs, concepts, documents
//!     and attachments; see `tracker.rs` and `specs/tracker/`).
//!
//! Two transports (`--transport`):
//!   - `stdio` (default): spawned per-client by the agent on the box it runs on.
//!     `--server` selects which tool set this process exposes.
//!   - `http`: a long-lived **Streamable HTTP** server (run once on the server), serving
//!     **every** tool set at once under distinct paths — `/corpus`, `/ledger` and
//!     `/tracker` — so clients register URLs and need no local binary. See `serve_http`.
//!
//! Logs to stderr (stdout carries the JSON-RPC stream in stdio mode).

use clap::{Parser, ValueEnum};
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, Content, ServerCapabilities, ServerInfo},
    tool, tool_handler, tool_router,
    transport::{
        stdio,
        streamable_http_server::{
            session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
        },
    },
    ErrorData as McpError, ServerHandler, ServiceExt,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

mod tracker;
use tracker::{TrackerServer, Transport};

/// Default bind address for the Streamable HTTP gateway (`--transport http`).
const DEFAULT_HTTP_BIND: &str = "0.0.0.0:17794";

const DEFAULT_SERVE_URL: &str = "http://localhost:17793";

/// Which tool set this process exposes. Each maps to a distinct MCP server name in
/// the client config, keeping retrieval and ledger calls visually separate.
#[derive(Copy, Clone, ValueEnum)]
enum ServerKind {
    /// Corpus retrieval: `search_corpus`, `reindex_corpus`.
    Corpus,
    /// Decision/incident ledger: `ledger_search`/`get`/`create`/`append`.
    Ledger,
    /// The tracker: a project's queue, specs, concepts, documents, attachments.
    Tracker,
}

/// How this process speaks MCP to clients.
#[derive(Copy, Clone, PartialEq, ValueEnum)]
enum TransportKind {
    /// stdio JSON-RPC — spawned per-client by the agent (the original mode).
    /// `--server` picks the single tool set this process serves.
    Stdio,
    /// Streamable HTTP — a long-lived network server (run once on the server). Serves
    /// **every** tool set under `/corpus`, `/ledger` and `/tracker`; `--server` is ignored.
    Http,
}

#[derive(Parser)]
#[command(
    name = "rag-mcp",
    about = "RAG MCP server (HTTP client of rag-serve)",
    version
)]
struct Cli {
    /// Which tool set to expose (stdio only). Register the binary once per mode so
    /// each shows up as its own MCP server (e.g. `rag` for corpus, `ledger`, `tracker`).
    /// Ignored under `--transport http`, which serves all three at once.
    #[arg(long, value_enum, default_value_t = ServerKind::Corpus)]
    server: ServerKind,

    /// Transport: `stdio` (per-client subprocess) or `http` (shared network server).
    #[arg(long, value_enum, default_value_t = TransportKind::Stdio)]
    transport: TransportKind,

    /// Bind address for `--transport http`. Serves `/corpus`, `/ledger` and `/tracker`.
    #[arg(long, env = "RAG_MCP_BIND", default_value = DEFAULT_HTTP_BIND)]
    bind: String,

    /// Base URL of the rag-serve service. Falls back to $RAG_SERVE_URL, then localhost.
    #[arg(long, env = "RAG_SERVE_URL", default_value = DEFAULT_SERVE_URL)]
    url: String,
}

// ---- Corpus tool arguments + request bodies ---------------------------------

/// Arguments for the `search_corpus` tool. Field docs become the JSON-Schema
/// property descriptions the agent sees. Mirrors the `rag-serve` /search body.
#[derive(Debug, Deserialize, schemars::JsonSchema, Serialize)]
struct SearchArgs {
    /// Natural-language query describing what to find (concepts, symbols, behaviour).
    query: String,
    /// Max results to return. Defaults to the server's configured value (8).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    top_k: Option<usize>,
    /// Whether to rerank candidates for quality. Defaults to true; set false only
    /// for debugging or to save cost.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rerank: Option<bool>,
    /// Restrict to a corpus: "code" (source repos), "wiki" (the document library),
    /// "ledger" (the decision/incident ledger) or "tracker" (the tracker's specs,
    /// milestones, concepts and tickets). Use "ledger" to run a semantic + rerank
    /// search over the ledger — richer than the ledger server's keyword search — and
    /// "tracker" to find planned, specced or queued work.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    corpus: Option<String>,
    /// Restrict to a single repository by exact name (e.g. "centurion-garage-HAS").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    repo: Option<String>,
    /// Restrict to a detected language (e.g. "rust", "python", "markdown").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    language: Option<String>,
    /// Restrict to files whose repo-relative path starts with this prefix
    /// (e.g. "custom_components/"). Applied after the candidate fetch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    path_prefix: Option<String>,
}

/// The JSON body `rag-serve` expects on `POST /search`.
#[derive(Serialize)]
struct SearchBody {
    query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_k: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rerank: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    filters: Option<Filters>,
}

#[derive(Serialize)]
struct Filters {
    #[serde(skip_serializing_if = "Option::is_none")]
    corpus: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path_prefix: Option<String>,
}

// ---- Ledger tool arguments --------------------------------------------------

/// Arguments for `ledger_search`.
#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct LedgerSearchArgs {
    /// Natural-language query: "have we decided/hit this before?".
    query: String,
    /// Max results. Defaults to the server's configured value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    top_k: Option<usize>,
    /// Restrict to one project (repo name).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    repo: Option<String>,
    /// Restrict to a topic type: decision | incident | defect | investigation.
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    topic_type: Option<String>,
    /// Restrict to a status (e.g. open, accepted, superseded, reverted).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    /// Set true to instead search the archived (soft-deleted) set — a substring
    /// match, not semantic. Archived topics never appear in a normal search.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    archived: Option<bool>,
}

/// Arguments for `ledger_move`.
#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct LedgerMoveArgs {
    /// The topic id to move, e.g. "myrepo-l0005" (older ids: "myrepo-0005").
    topic_id: String,
    /// Destination project (repo name). The topic is reassigned a brand-new id in
    /// this repo (a fresh number too); the old id is removed.
    repo: String,
    /// The acting agent — **always pass this**, set to your own model name
    /// (e.g. "Claude Opus 5 (1M context)"). Nothing downstream can derive it, so
    /// the $RAG_AGENT fallback is the marker "Unknown", not a guess.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
}

/// Arguments for `ledger_archive`.
#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct LedgerArchiveArgs {
    /// The topic id to archive or restore, e.g. "rag-l0042" (older ids: "rag-0042").
    topic_id: String,
    /// `true` (default) archives (soft-delete + drop from the index); `false` restores.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    archived: Option<bool>,
    /// The acting agent — **always pass this**, set to your own model name
    /// (e.g. "Claude Opus 5 (1M context)"). Nothing downstream can derive it, so
    /// the $RAG_AGENT fallback is the marker "Unknown", not a guess.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
}

/// Arguments for `ledger_get`.
#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct LedgerGetArgs {
    /// The topic id, e.g. "rag-l0042" (older ids: "rag-0042").
    topic_id: String,
}

/// Arguments for `ledger_create`.
#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct LedgerCreateArgs {
    /// Topic type: decision | incident | defect | investigation.
    #[serde(rename = "type")]
    topic_type: String,
    /// Title — a one-line summary of the topic.
    title: String,
    /// Fixed summary: the original framing of the decision/bug/incident.
    summary: String,
    /// The initial current-state (where it stands now). Recorded as the first log entry.
    initial_state: String,
    /// Project (repo name). Defaults to the current git repo if omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    repo: Option<String>,
    /// Initial status. Defaults by type (decision→proposed, else open).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    /// Optional tags.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tags: Vec<String>,
    /// The acting agent — **always pass this**, set to your own model name
    /// (e.g. "Claude Opus 5 (1M context)"). Nothing downstream can derive it, so
    /// the $RAG_AGENT fallback is the marker "Unknown", not a guess.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
}

/// Arguments for `ledger_append`.
#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct LedgerAppendArgs {
    /// The topic id to append to, e.g. "rag-l0042" (older ids: "rag-0042").
    topic_id: String,
    /// The monologue entry — what happened / what was learned / what changed.
    body: String,
    /// Event kind: note | state_change | status_change | correction | link. Default note.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
    /// New current-state, if this entry changes where the topic stands.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    set_state: Option<String>,
    /// New status (e.g. resolved, accepted, superseded, reverted).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    set_status: Option<String>,
    /// Amend the topic's title — for a handle that turned out wrong or unclear.
    /// The amendment is logged like any other change. Must not be blank.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    set_title: Option<String>,
    /// Replace the topic's tags **wholesale** — send the full list you want, not
    /// just the ones being added. `[]` clears every tag; omit to leave them alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    set_tags: Option<Vec<String>>,
    /// If set, this topic supersedes the given topic id: links both ways and marks
    /// the other topic `superseded` (the "this was a bad idea, do it this way now" move).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    supersedes: Option<String>,
    /// The acting agent — **always pass this**, set to your own model name
    /// (e.g. "Claude Opus 5 (1M context)"). Nothing downstream can derive it, so
    /// the $RAG_AGENT fallback is the marker "Unknown", not a guess.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
}

// ---- HTTP request bodies sent to rag-serve ----------------------------------

#[derive(Serialize)]
struct CreateReq {
    #[serde(rename = "type")]
    topic_type: String,
    repo: String,
    title: String,
    summary: String,
    initial_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    tags: Vec<String>,
    creator_email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    creator_agent: Option<String>,
}

#[derive(Serialize)]
struct AppendReq {
    body: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    set_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    set_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    set_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    set_tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    supersedes: Option<String>,
    author_email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    author_agent: Option<String>,
}

#[derive(Serialize)]
struct LedgerSearchReq {
    query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_k: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    repo: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    topic_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    archived: Option<bool>,
}

#[derive(Serialize)]
struct MoveReq {
    repo: String,
    author_email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    author_agent: Option<String>,
}

#[derive(Serialize)]
struct ArchiveReq {
    archived: bool,
    author_email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    author_agent: Option<String>,
}

/// Forward an HTTP request to rag-serve and map the response to a tool result.
/// 4xx (bad args / not found / unprocessable) → `invalid_params`; else → internal error.
async fn forward(rb: reqwest::RequestBuilder) -> Result<CallToolResult, McpError> {
    let resp = rb
        .send()
        .await
        .map_err(|e| McpError::internal_error(format!("cannot reach rag-serve: {e}"), None))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status.is_success() {
        return Ok(CallToolResult::success(vec![Content::text(text)]));
    }
    // rag-serve returns `{"error": "..."}`; surface that message when present.
    let msg = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
        .unwrap_or(text);
    if status == reqwest::StatusCode::BAD_REQUEST
        || status == reqwest::StatusCode::NOT_FOUND
        || status == reqwest::StatusCode::UNPROCESSABLE_ENTITY
    {
        Err(McpError::invalid_params(msg, None))
    } else {
        Err(McpError::internal_error(
            format!("rag-serve {status}: {msg}"),
            None,
        ))
    }
}

// ---- Corpus server ----------------------------------------------------------

#[derive(Clone)]
struct CorpusServer {
    http: reqwest::Client,
    search_url: String,
    reindex_url: String,
    tool_router: ToolRouter<CorpusServer>,
}

#[tool_router]
impl CorpusServer {
    fn new(http: reqwest::Client, base_url: &str) -> Self {
        let base = base_url.trim_end_matches('/');
        Self {
            search_url: format!("{base}/search"),
            reindex_url: format!("{base}/reindex"),
            http,
            tool_router: Self::tool_router(),
        }
    }

    /// Search the local code + wiki corpus. Forwards to rag-serve, which embeds the
    /// query, runs vector search with optional filters, reranks, and returns ranked
    /// chunks. Cite results by `repo` + `rel_path` + `start_line`/`end_line` (the
    /// `path` field is the indexer's internal view — ignore it for citations); a
    /// tracker hit carries its own `citation`.
    #[tool(
        description = "Search the local code and wiki corpus (Retrieval-Augmented Generation). \
        Returns ranked, reranked source chunks with provenance. Use it to find where something \
        is implemented, how an API is used, or relevant docs across all indexed repositories. \
        Cite results as repo + rel_path + line range. Optional filters: corpus \
        (code|wiki|ledger|tracker), repo, language, path_prefix. Pass corpus=\"ledger\" to \
        semantically search the decision/incident ledger (better recall than the ledger \
        server's keyword search). Pass corpus=\"tracker\" to search the tracker's specs, \
        milestones, concepts and tickets (search it before re-planning work); repo is then \
        the project, and each hit's `citation` is `<project>:<path>@r<revision>` for a document \
        chunk (read it with tracker_doc_get) or the ticket id (tracker_get)."
    )]
    async fn search_corpus(
        &self,
        Parameters(args): Parameters<SearchArgs>,
    ) -> Result<CallToolResult, McpError> {
        if args.query.trim().is_empty() {
            return Err(McpError::invalid_params("query must not be empty", None));
        }
        let has_filter = args.corpus.is_some()
            || args.repo.is_some()
            || args.language.is_some()
            || args.path_prefix.is_some();
        let filters = has_filter.then_some(Filters {
            corpus: args.corpus,
            repo: args.repo,
            language: args.language,
            path_prefix: args.path_prefix,
        });
        let body = SearchBody {
            query: args.query,
            top_k: args.top_k,
            rerank: args.rerank,
            filters,
        };
        forward(self.http.post(&self.search_url).json(&body)).await
    }

    /// Trigger an immediate re-index of the corpus. The corpus otherwise refreshes
    /// automatically every 15 minutes; call this after pushing changes you want
    /// searchable right away. Returns as soon as the re-index is triggered — the run
    /// takes roughly 30s–3min in the background, so wait a moment before re-searching.
    #[tool(
        description = "Trigger an immediate re-index of the local code/wiki corpus. \
        The corpus auto-refreshes every 15 minutes; use this after pushing changes you want \
        searchable now. Returns once triggered (the indexing runs in the background, ~30s–3min) \
        — wait briefly, then search again to see new content."
    )]
    async fn reindex_corpus(&self) -> Result<CallToolResult, McpError> {
        forward(self.http.post(&self.reindex_url)).await
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for CorpusServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(
            "Retrieval over the local code + wiki corpus. Call `search_corpus` with a \
            natural-language query to find relevant source chunks; narrow with the corpus/repo/\
            language/path_prefix filters. Results are reranked and carry citable provenance \
            (repo + rel_path + line range). Call `reindex_corpus` to refresh the index immediately \
            after pushing changes (it otherwise updates every 15 minutes). The decision/incident \
            ledger is indexed too: pass corpus=\"ledger\" to `search_corpus` for a semantic search \
            over it (better recall than the ledger server's keyword search). The tracker's \
            documents and tickets are indexed too: pass corpus=\"tracker\" to find planned, \
            specced or queued work; each hit's `citation` is `<project>:<path>@r<revision>` or an \
            ticket id. Writing to the ledger (create/append) and exact lookups are on the separate \
            `ledger_*` MCP server; the tracker's are on the `tracker_*` server.",
        )
    }
}

// ---- Ledger server ----------------------------------------------------------

#[derive(Clone)]
struct LedgerServer {
    http: reqwest::Client,
    base: String,
    tool_router: ToolRouter<LedgerServer>,
}

#[tool_router]
impl LedgerServer {
    fn new(http: reqwest::Client, base_url: &str) -> Self {
        Self {
            base: base_url.trim_end_matches('/').to_string(),
            http,
            tool_router: Self::tool_router(),
        }
    }

    /// Search the decision/incident ledger semantically. Use BEFORE making a
    /// non-obvious decision or re-investigating a bug to check for prior reasoning
    /// or a "this was a bad idea" record. Returns matching topics; fetch the full
    /// history with `ledger_get`.
    #[tool(
        description = "Search the cross-project decision/incident ledger (corpus=ledger). \
        Use this BEFORE making a non-obvious design decision or re-investigating a bug, to \
        find prior reasoning, postmortems, or superseded approaches. Returns matching topics \
        (topic_id, type, status, title); call ledger_get for the full monologue. Filters: \
        repo, type (decision|incident|defect|investigation), status. Set archived=true to \
        instead search the soft-deleted set (a substring match); archived topics are otherwise \
        hidden and absent from the RAG index."
    )]
    async fn ledger_search(
        &self,
        Parameters(args): Parameters<LedgerSearchArgs>,
    ) -> Result<CallToolResult, McpError> {
        // An empty query is allowed for the archived listing (lists recent archived);
        // the live semantic path still requires one (rag-serve rejects it).
        if args.query.trim().is_empty() && !args.archived.unwrap_or(false) {
            return Err(McpError::invalid_params("query must not be empty", None));
        }
        let body = LedgerSearchReq {
            query: args.query,
            top_k: args.top_k,
            repo: args.repo,
            topic_type: args.topic_type,
            status: args.status,
            archived: args.archived,
        };
        let url = format!("{}/ledger/search", self.base);
        forward(self.http.post(&url).json(&body)).await
    }

    /// Fetch one ledger topic in full: metadata, summary, current state, the
    /// complete append-only monologue, and links to related topics.
    #[tool(
        description = "Fetch a single ledger topic by id (e.g. \"rag-l0042\"; older ids \"rag-0042\") with its full \
        structured record: summary, current state, the complete monologue history, and links \
        (supersedes/superseded_by/related/caused_by). Use after ledger_search to read the detail. \
        If the id was moved to another project, returns a redirect pointer \
        ({\"moved\":true,\"moved_to\":\"<new-id>\"}) instead — fetch the new id."
    )]
    async fn ledger_get(
        &self,
        Parameters(args): Parameters<LedgerGetArgs>,
    ) -> Result<CallToolResult, McpError> {
        if args.topic_id.trim().is_empty() {
            return Err(McpError::invalid_params("topic_id must not be empty", None));
        }
        let url = format!("{}/ledger/{}", self.base, args.topic_id.trim());
        forward(self.http.get(&url)).await
    }

    /// Create a new ledger topic (a decision, incident, defect, or investigation).
    /// The git user.email and repo are captured automatically.
    #[tool(
        description = "Create a new ledger topic recording a decision, incident, defect, or \
        investigation. Scope each topic to ONE decision or finding — prefer creating several \
        small, atomic topics over one broad, evolving one, even within a single task or session \
        (e.g. 'Postgres over MySQL' and 'retry/backoff policy' are two topics, not one 'storage \
        layer' topic). Provide type, title, a fixed summary, and the initial current-state — \
        keep current-state a concise status, not a growing multi-point dossier. The creator \
        email is taken from git config and the repo from the current git repo (override with \
        `repo`). Returns the new topic_id (e.g. \"rag-l0042\"). Append later updates with \
        ledger_append — never edit history, append to it."
    )]
    async fn ledger_create(
        &self,
        Parameters(args): Parameters<LedgerCreateArgs>,
    ) -> Result<CallToolResult, McpError> {
        if args.title.trim().is_empty() || args.summary.trim().is_empty() {
            return Err(McpError::invalid_params(
                "title and summary are required",
                None,
            ));
        }
        let repo = args.repo.or_else(git_repo).ok_or_else(|| {
            McpError::invalid_params(
                "repo not given and could not be inferred from a git repo",
                None,
            )
        })?;
        let body = CreateReq {
            topic_type: args.topic_type,
            repo,
            title: args.title,
            summary: args.summary,
            initial_state: args.initial_state,
            status: args.status,
            tags: args.tags,
            creator_email: identity_email(),
            creator_agent: resolve_agent(args.agent),
        };
        let url = format!("{}/ledger", self.base);
        forward(self.http.post(&url).json(&body)).await
    }

    /// Append an entry to a ledger topic's monologue, optionally updating its
    /// current state, status, or recording that it supersedes another topic.
    #[tool(
        description = "Append an entry to a ledger topic's append-only monologue — to evolve the \
        SAME single thing this topic records: a status change, a correction, or its outcome. A \
        new, distinct decision or finding is a NEW topic (`ledger_create`), not an append here, \
        even within the same task. If you find yourself appending genuinely new facts more than \
        once or twice, or the current-state is swelling into a dossier, you have several topics — \
        split them. Optionally update current-state (set_state — keep it a concise status, not a \
        growing dossier), status (set_status), or mark that this topic supersedes another \
        (supersedes=<topic_id> — links both ways and flips the other to 'superseded', the way to \
        record 'this earlier approach was wrong'). It is also how a topic's metadata is amended: \
        set_title for a handle that turned out wrong, set_tags to refile it (wholesale — send the \
        full list, not a delta). The `summary` is NOT amendable by design: it is the original \
        framing, and a topic that was framed wrongly is worth more than one tidied to match its \
        outcome — correct it in the body instead. The author email is captured from git."
    )]
    async fn ledger_append(
        &self,
        Parameters(args): Parameters<LedgerAppendArgs>,
    ) -> Result<CallToolResult, McpError> {
        if args.topic_id.trim().is_empty() || args.body.trim().is_empty() {
            return Err(McpError::invalid_params(
                "topic_id and body are required",
                None,
            ));
        }
        let body = AppendReq {
            body: args.body,
            kind: args.kind.unwrap_or_else(|| "note".to_string()),
            set_state: args.set_state,
            set_status: args.set_status,
            set_title: args.set_title,
            set_tags: args.set_tags,
            supersedes: args.supersedes,
            author_email: identity_email(),
            author_agent: resolve_agent(args.agent),
        };
        let url = format!("{}/ledger/{}/append", self.base, args.topic_id.trim());
        forward(self.http.post(&url).json(&body)).await
    }

    /// Move a topic to another project, reassigning a brand-new id.
    #[tool(
        description = "Move a ledger topic to another project (repo). It is reassigned a \
        completely new id — including a fresh number — in the destination repo; the old id is \
        removed. The whole monologue and all links (both directions) follow, and a provenance \
        note records the move. The RAG index is updated automatically (old points purged, new \
        ones indexed). Use this to correct a topic filed under the wrong project. The author \
        email is captured from git."
    )]
    async fn ledger_move(
        &self,
        Parameters(args): Parameters<LedgerMoveArgs>,
    ) -> Result<CallToolResult, McpError> {
        if args.topic_id.trim().is_empty() || args.repo.trim().is_empty() {
            return Err(McpError::invalid_params(
                "topic_id and repo are required",
                None,
            ));
        }
        let body = MoveReq {
            repo: args.repo.trim().to_string(),
            author_email: identity_email(),
            author_agent: resolve_agent(args.agent),
        };
        let url = format!("{}/ledger/{}/move", self.base, args.topic_id.trim());
        forward(self.http.post(&url).json(&body)).await
    }

    /// Archive (soft-delete) or restore a topic.
    #[tool(
        description = "Archive (soft-delete) a ledger topic, or restore one. Archiving retains \
        the topic in the ledger but hides it from a normal ledger_search and removes it entirely \
        from the RAG index (so it no longer surfaces in search_corpus either). It stays \
        reachable via ledger_get, and via ledger_search with archived=true. Pass archived=false \
        to restore (re-index) it. Use this to retire obsolete or noise entries without losing \
        history. The author email is captured from git."
    )]
    async fn ledger_archive(
        &self,
        Parameters(args): Parameters<LedgerArchiveArgs>,
    ) -> Result<CallToolResult, McpError> {
        if args.topic_id.trim().is_empty() {
            return Err(McpError::invalid_params("topic_id is required", None));
        }
        let body = ArchiveReq {
            archived: args.archived.unwrap_or(true),
            author_email: identity_email(),
            author_agent: resolve_agent(args.agent),
        };
        let url = format!("{}/ledger/{}/archive", self.base, args.topic_id.trim());
        forward(self.http.post(&url).json(&body)).await
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for LedgerServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(
            "The cross-project decision/incident ledger: design decisions, incidents, defects, \
            and investigations recorded so they aren't lost or repeated. BEFORE a non-obvious \
            decision or re-investigating a bug, call `ledger_search` (then `ledger_get` for the \
            full history). Record new ones with `ledger_create` and evolve them with \
            `ledger_append` (which can mark a topic as superseding an earlier, worse approach). \
            PREFER MANY SMALL, ATOMIC TOPICS over one broad, evolving one: one topic = one \
            decision or one finding. Use `ledger_create` for each distinct decision/finding — \
            even several within a single task or session — and use `ledger_append` only to \
            record a change to that SAME thing (status moved on, a correction, the outcome), not \
            to pile new, distinct facts onto it. A swelling current-state or repeated \
            new-fact appends means you should have split into separate topics. \
            History is append-only — never rewritten. Housekeeping: `ledger_move` refiles a \
            topic under the right project (it gets a new id), and `ledger_archive` soft-deletes \
            a noise/obsolete topic (hidden from search + dropped from the index, restorable). \
            Code/doc search is a separate MCP server (`search_corpus`).",
        )
    }
}

// ---- git identity helpers ---------------------------------------------------

/// Resolve a git config / repo value by running `git` in the current directory.
fn git_value(args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// The committer email from the current git context (authoritative identity).
fn git_email() -> Option<String> {
    git_value(&["config", "user.email"])
}

/// Author identity for a ledger write: the client's git `user.email` when running
/// as a local stdio subprocess, else `$RAG_EMAIL` (set on the shared HTTP gateway,
/// which has no client git context), else "unknown". See `serve_http` for why the
/// remote transport relies on the env fallback.
fn identity_email() -> String {
    git_email()
        .or_else(|| std::env::var("RAG_EMAIL").ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

/// The current repo name (basename of the git toplevel).
fn git_repo() -> Option<String> {
    let top = git_value(&["rev-parse", "--show-toplevel"])?;
    top.rsplit('/').next().map(|s| s.to_string())
}

/// The acting agent: the explicit arg, else `$RAG_AGENT`.
///
/// **The env is a marker, not an identity.** Nothing in this stack can derive
/// which model is calling — one stdio process serves a whole session including
/// subagents running other models, and MCP's `initialize` carries the *client*
/// (`claude-code`), not the model. So the caller is the only thing that knows,
/// and `$RAG_AGENT` should be set to something that admits it (`Unknown`, or
/// `rag-mcp-http` on the shared gateway). Setting it to a model name stamps
/// every unattributed write with a confident lie that outlives the release.
fn resolve_agent(arg: Option<String>) -> Option<String> {
    arg.or_else(|| std::env::var("RAG_AGENT").ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Streamable HTTP gateway: one long-lived server (run on the server) exposing
/// **every** tool set so remote clients need no local binary — just registered URLs:
///   - `POST <bind>/corpus` → `search_corpus`, `reindex_corpus`
///   - `POST <bind>/ledger` → the `ledger_*` tools
///   - `POST <bind>/tracker` → the `tracker_*` tools (attachments as base64, ≤ 10 MB)
///
/// Each request still forwards to `rag-serve` (`url`), so the Voyage key never
/// leaves the server — same trust model as the stdio binary.
///
/// **Identity caveat (ledger).** A local stdio process reads the *client's* git
/// `user.email`/repo and `$RAG_AGENT`; a shared HTTP server cannot — it has no
/// client git context. So ledger writes over HTTP attribute the author from the
/// gateway's `$RAG_EMAIL`/`$RAG_AGENT` env (set once in the unit), and the repo
/// must be passed explicitly to `ledger_create` (git inference returns nothing
/// server-side, surfacing the existing "repo not given" error otherwise). Fine for
/// a single-operator estate; per-client attribution would need request headers.
/// The tracker tools have the same caveat, and need `project` passed explicitly.
async fn serve_http(http: reqwest::Client, serve_url: &str, bind: &str) -> anyhow::Result<()> {
    // LAN-trusted: clients connect by the server's IP/hostname, so the default
    // loopback-only Host allowlist (a DNS-rebinding guard for local servers) would
    // reject them. Disable it — there is no public exposure (same posture as the
    // password-free rag-serve and unauthenticated LAN Qdrant).
    let config = || StreamableHttpServerConfig::default().disable_allowed_hosts();

    let corpus = {
        let (http, url) = (http.clone(), serve_url.to_string());
        StreamableHttpService::new(
            move || Ok(CorpusServer::new(http.clone(), &url)),
            Arc::new(LocalSessionManager::default()),
            config(),
        )
    };
    let ledger = {
        let (http, url) = (http.clone(), serve_url.to_string());
        StreamableHttpService::new(
            move || Ok(LedgerServer::new(http.clone(), &url)),
            Arc::new(LocalSessionManager::default()),
            config(),
        )
    };

    let tracker = {
        let (http, url) = (http.clone(), serve_url.to_string());
        StreamableHttpService::new(
            move || Ok(TrackerServer::new(http.clone(), &url, Transport::Gateway)),
            Arc::new(LocalSessionManager::default()),
            config(),
        )
    };

    let app = axum::Router::new()
        .nest_service("/corpus", corpus)
        .nest_service("/ledger", ledger)
        .nest_service("/tracker", tracker);

    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!(
        bind = %bind,
        serve = %serve_url,
        "rag-mcp starting (http; /corpus + /ledger + /tracker; no local key)"
    );
    axum::serve(listener, app).await?;
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Logs to stderr — stdout is the MCP transport.
    rag_core::telemetry::init_stderr();
    let cli = Cli::parse();

    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()?;

    match cli.transport {
        TransportKind::Http => serve_http(http, &cli.url, &cli.bind).await?,
        TransportKind::Stdio => match cli.server {
            ServerKind::Corpus => {
                tracing::info!(serve = %cli.url, "rag-mcp starting (corpus; stdio; no local key)");
                let svc = CorpusServer::new(http, &cli.url).serve(stdio()).await?;
                svc.waiting().await?;
            }
            ServerKind::Ledger => {
                tracing::info!(serve = %cli.url, "rag-mcp starting (ledger; stdio; no local key)");
                let svc = LedgerServer::new(http, &cli.url).serve(stdio()).await?;
                svc.waiting().await?;
            }
            ServerKind::Tracker => {
                tracing::info!(serve = %cli.url, "rag-mcp starting (tracker; stdio; no local key)");
                let svc = TrackerServer::new(http, &cli.url, Transport::Stdio)
                    .serve(stdio())
                    .await?;
                svc.waiting().await?;
            }
        },
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::{extract::State, routing::post, Json, Router};
    use serde_json::{json, Value};

    use super::*;

    /// A stand-in `rag-serve` whose `/search` records the body it was sent and
    /// answers with one tracker hit, shaped as `RankedHit` serialises one.
    async fn stand_in() -> (String, Arc<Mutex<Option<Value>>>) {
        let seen: Arc<Mutex<Option<Value>>> = Arc::default();
        async fn search(
            State(seen): State<Arc<Mutex<Option<Value>>>>,
            Json(body): Json<Value>,
        ) -> Json<Value> {
            *seen.lock().unwrap() = Some(body);
            Json(json!({
                "query": "solar film", "top_k": 8, "reranked": true, "candidates": 1,
                "timings": {"embed_ms": 1, "search_ms": 1, "rerank_ms": 1, "total_ms": 3},
                "results": [{
                    "corpus": "tracker", "repo": "ubu", "rel_path": "concepts/power.md",
                    "path": "", "language": "markdown", "start_line": 3, "end_line": 9,
                    "text": "Power · ubu:concepts/power.md\n\nA solar film on the roof.",
                    "ann_score": 0.7, "rerank_score": 0.9, "title": "Power",
                    "citation": "ubu:concepts/power.md@r4", "tracker_id": "ubu-d0003",
                    "kind": "concept", "revision": 4
                }]
            }))
        }
        let app = Router::new()
            .route("/search", post(search))
            .with_state(seen.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), seen)
    }

    /// m05: `search_corpus` with `corpus: "tracker"` sends the filter and returns
    /// the fixture document's chunk with its citation.
    #[tokio::test]
    async fn search_corpus_takes_the_tracker_corpus_and_returns_the_citation() {
        let (base, seen) = stand_in().await;
        let server = CorpusServer::new(reqwest::Client::new(), &base);
        let args = SearchArgs {
            query: "solar film".into(),
            top_k: None,
            rerank: None,
            corpus: Some("tracker".into()),
            repo: Some("ubu".into()),
            language: None,
            path_prefix: None,
        };
        let res = server.search_corpus(Parameters(args)).await.unwrap();
        let body = seen.lock().unwrap().clone().unwrap();
        assert_eq!(
            body,
            json!({"query": "solar film", "filters": {"corpus": "tracker", "repo": "ubu"}})
        );
        let text = res.content[0].as_text().unwrap().text.clone();
        let v: Value = serde_json::from_str(&text).unwrap();
        let hit = &v["results"][0];
        assert_eq!(hit["corpus"], "tracker");
        assert_eq!(hit["citation"], "ubu:concepts/power.md@r4");
        assert_eq!(hit["tracker_id"], "ubu-d0003");
        assert!(hit["text"].as_str().unwrap().contains("solar film"));
    }

    #[test]
    fn the_corpus_tool_names_the_tracker_corpus() {
        let tools = CorpusServer::tool_router().list_all();
        let search = tools.iter().find(|t| t.name == "search_corpus").unwrap();
        let d = search.description.as_deref().unwrap_or_default();
        assert!(
            d.contains("corpus=\"tracker\"") && d.contains("citation"),
            "{d}"
        );
    }
}
