//! The `tracker` MCP server (m02 of `specs/tracker`): the third `--server` mode of
//! `rag-mcp`, and `/tracker` on the HTTP gateway, so tracker calls show as their
//! own server ("Calling tracker…").
//!
//! Every tool forwards to the `/tracker/…` routes of `rag-serve`, whose contract
//! is `specs/tracker/api.md`. Each tool turns its arguments into a [`Req`] with a
//! pure builder (the unit-tested seam), sends it, and formats the answer: the
//! queue and documents as compact text an agent reads cheaply, records as the
//! server's JSON. A refusal comes back as the server's own message.
//!
//! Identity is the ledger tools': `author_email` from the client's git config (or
//! `$RAG_EMAIL` on the gateway), `agent` from the argument (else `$RAG_AGENT`; the
//! server records an absent one as `Unknown`), and `surface: "mcp"` on every
//! write. The project defaults to the current git repository, as `ledger_create`'s
//! `repo` does; the gateway has no client git context, so it needs `project`.
//!
//! Attachments (TM-04) differ by transport: over stdio the tools read and write
//! local files (the agent then `Read`s an image); over the gateway they take and
//! return base64, capped at [`GATEWAY_MAX_BYTES`].

use std::collections::BTreeSet;
use std::path::PathBuf;

use base64::Engine as _;
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, Content, ServerCapabilities, ServerInfo},
    tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use rag_core::tracker::{describe_changes, EventKind, TargetKind};

use crate::{git_repo, identity_email, resolve_agent};

/// The most bytes an attachment may carry over the HTTP gateway, either way.
pub const GATEWAY_MAX_BYTES: usize = 10 * 1024 * 1024;

/// The server's own upload cap (api.md § Attachments); checked locally first so a
/// huge file is refused before it is read.
const UPLOAD_MAX_BYTES: u64 = 50 * 1024 * 1024;

const NO_PROJECT: &str = "project not given and could not be inferred from a git repository: \
     pass `project` (the repository name, e.g. \"ubu\"; always needed over the HTTP gateway)";

/// The server's instructions: the rules every tool shares, said once here
/// rather than in each tool's description, which an agent pays for again in
/// every session (rag-t0039).
const INSTRUCTIONS: &str = "The project tracker: each project's work queue (tickets of type dev, \
design, recon, analysis, gate, request), its specs with milestones, its concepts and documents. \
specs/... and concepts/... paths named in repositories and the ledger live here.
Reading: tracker_next after each job (what to dispatch next); tracker_queue for a status report; \
tracker_get for one record (history: true, or N for the last N events, only when needed); \
search_corpus corpus=tracker to find work by meaning.
Writing: queue writes (creating tickets, status, block, approval, assignee, moves, acknowledging) are \
for the agent working with the owner, in practice the manager. A sub-agent reads anything, edits \
documents (tracker_doc_edit) and notes its own task (tracker_update with a note alone). Pass agent \
(your model name) on every write, or it is recorded as Unknown. A note is optional: give one when the \
reason is not obvious. approval owner only when the owner approved (in conversation counts), the \
note saying where; ratified only from agent, when the owner confirms. A write replies with one \
line: ok, the record, what changed, the event id.
project defaults to the current git repository over stdio; the HTTP gateway needs it, and takes \
attachments as base64 (at most 10 MB) rather than local paths. Decisions go in the ledger.
A request is the owner's idea, never dispatched (its feed frame says {type: request}): create its \
tickets with links from:<request id> (approval defaults to agent), place them as it says (else the \
bottom), then set it done with a note listing them.
A draft is the owner's, unfinished: never dispatched and out of the feed; leave it until its \
publish frame ({draft: yes → no}).";

/// Replace `body_path` with the file's contents in `body`, so the request builders
/// see an ordinary body. Over the HTTP gateway a path is refused: it cannot read the
/// client's disk. Both at once is refused rather than one silently winning.
async fn inline_body(
    transport: Transport,
    body: &mut Option<String>,
    body_path: &mut Option<String>,
) -> Result<(), McpError> {
    let Some(path) = body_path.take() else {
        return Ok(());
    };
    if body.is_some() {
        return Err(bad("give body or body_path, not both"));
    }
    if transport == Transport::Gateway {
        return Err(bad(
            "the HTTP gateway cannot read your files: pass the markdown as `body`",
        ));
    }
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| bad(format!("cannot read {path}: {e}")))?;
    if meta.len() > rag_core::tracker::MAX_DOCUMENT_BYTES as u64 {
        return Err(bad(format!(
            "{path} is {} bytes; a document is at most 4 MB",
            meta.len()
        )));
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| bad(format!("cannot read {path}: {e}")))?;
    let text = String::from_utf8(bytes).map_err(|_| bad(format!("{path} is not UTF-8 text")))?;
    *body = Some(text);
    Ok(())
}

/// How this server reaches its client, which decides how attachments travel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
    /// A local stdio subprocess: attachments are local files.
    Stdio,
    /// The shared HTTP gateway: attachments are base64 (it cannot see the client's disk).
    Gateway,
}

// ---- Requests ---------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Method {
    Get,
    Post,
}

/// One request to `rag-serve`, built from a tool's arguments.
#[derive(Debug, Clone, PartialEq)]
struct Req {
    method: Method,
    /// The path and query, e.g. `/tracker/ubu/doc?path=specs%2Fa%2Fmaster.md`.
    path: String,
    body: Option<Value>,
}

impl Req {
    fn get(path: impl Into<String>) -> Self {
        Self {
            method: Method::Get,
            path: path.into(),
            body: None,
        }
    }

    fn post(path: impl Into<String>, body: Map<String, Value>) -> Self {
        Self {
            method: Method::Post,
            path: path.into(),
            body: Some(Value::Object(body)),
        }
    }
}

/// Who is writing: stamped on every write's body.
#[derive(Debug, Clone)]
struct Author {
    email: String,
    agent: Option<String>,
}

impl Author {
    fn resolve(agent: Option<String>) -> Self {
        Self {
            email: identity_email(),
            agent: resolve_agent(agent),
        }
    }

    fn stamp(&self, body: &mut Map<String, Value>) {
        body.insert("author_email".into(), json!(self.email));
        if let Some(agent) = &self.agent {
            body.insert("agent".into(), json!(agent));
        }
        body.insert("surface".into(), json!("mcp"));
    }
}

/// Percent-encode a path segment or query value (everything but RFC 3986's
/// unreserved characters).
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `?a=1&b=2` from the pairs that have a value, or `""`.
fn query(pairs: &[(&str, Option<String>)]) -> String {
    let parts: Vec<String> = pairs
        .iter()
        .filter_map(|(k, v)| v.as_ref().map(|v| format!("{k}={}", enc(v))))
        .collect();
    if parts.is_empty() {
        String::new()
    } else {
        format!("?{}", parts.join("&"))
    }
}

/// `history=false` when the history is not wanted (the server's default is true).
fn history_param(history: bool) -> Option<String> {
    (!history).then(|| "false".to_string())
}

/// The project from the argument, else the current git repository.
fn resolve_project(arg: Option<String>) -> Option<String> {
    arg.map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(git_repo)
}

fn need_project(project: Option<&str>) -> Result<&str, String> {
    project.ok_or_else(|| NO_PROJECT.to_string())
}

/// What a reference names (`tracker_get`, `tracker_update`, `tracker_doc_*`).
#[derive(Debug, Clone, PartialEq)]
enum Target {
    Item(String),
    Doc(String),
    Path(String),
    Spec(String),
    Milestone(String, String),
    Concept(String),
}

const TARGET_FORMS: &str = "a ticket id (ubu-t0042), a document id (ubu-d0007), a document path \
     (specs/audio/master.md), spec:<slug>, milestone:<slug>/<code> or concept:<slug>";

fn parse_target(raw: &str) -> Result<Target, String> {
    let s = raw.trim();
    let nonblank = |v: &str, what: &str| -> Result<String, String> {
        let v = v.trim();
        if v.is_empty() {
            Err(format!("`{s}` names no {what}"))
        } else {
            Ok(v.to_string())
        }
    };
    if s.is_empty() {
        return Err(format!("id must not be empty: give {TARGET_FORMS}"));
    }
    if let Some(slug) = s.strip_prefix("spec:") {
        return Ok(Target::Spec(nonblank(slug, "spec")?));
    }
    if let Some(rest) = s.strip_prefix("milestone:") {
        let (slug, code) = rest
            .split_once('/')
            .ok_or_else(|| format!("`{s}`: a milestone is milestone:<spec slug>/<code>"))?;
        return Ok(Target::Milestone(
            nonblank(slug, "spec")?,
            nonblank(code, "milestone code")?,
        ));
    }
    if let Some(slug) = s.strip_prefix("concept:") {
        return Ok(Target::Concept(nonblank(slug, "concept")?));
    }
    if s.ends_with(".md") {
        return Ok(Target::Path(s.to_string()));
    }
    if let Some((_, tail)) = s.rsplit_once('-') {
        let digits = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
        if tail.strip_prefix('t').is_some_and(digits) {
            return Ok(Target::Item(s.to_string()));
        }
        if tail.strip_prefix('d').is_some_and(digits) {
            return Ok(Target::Doc(s.to_string()));
        }
    }
    // A ledger topic (`ubu-l1652`, or a legacy `ubu-1592`) is the commonest
    // wrong guess here: say where it lives rather than list the tracker's forms.
    if rag_core::ledger::parse_topic_id(s).is_some() {
        return Err(format!(
            "`{s}` is a ledger topic id, not a tracker reference: read it with ledger_get"
        ));
    }
    Err(format!(
        "`{s}` is not a tracker reference: give {TARGET_FORMS}"
    ))
}

/// The fields an argument struct actually carries (absent options are skipped
/// when it serialises), so a builder can refuse a field that does not apply
/// instead of dropping it silently, as the server refuses unknown fields.
fn present(args: &impl Serialize) -> Map<String, Value> {
    match serde_json::to_value(args) {
        Ok(Value::Object(m)) => m,
        _ => Map::new(),
    }
}

fn only(fields: &Map<String, Value>, allowed: &[&str], what: &str) -> Result<(), String> {
    let bad: Vec<&str> = fields
        .keys()
        .map(String::as_str)
        .filter(|k| !allowed.contains(k))
        .collect();
    if bad.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "{} not apply to {what} (it takes: {})",
            match bad.as_slice() {
                [one] => format!("`{one}` does"),
                _ => format!("`{}` do", bad.join("`, `")),
            },
            allowed.join(", ")
        ))
    }
}

// ---- Tool arguments -----------------------------------------------------------
//
// Every argument doc below is the JSON-Schema description an agent pays for in
// every session (rag-t0039), so each says only what a call needs: the rules
// that apply to every write (`agent`, notes, approval, who may write) are said
// once, in the server's instructions ([`INSTRUCTIONS`]). The schemas are
// compacted further when the router is built ([`compact_schema`]).

// A link from a record to another (api.md § Names and ids).
#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
struct LinkArg {
    /// spec|milestone|concept|ledger|item
    kind: String,
    /// slug, slug/code, ticket id or ledger id
    target: String,
}

// A milestone created with its spec.
#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
#[schemars(inline)]
struct MilestoneArg {
    /// e.g. m01
    code: String,
    title: String,
    /// File name part; default the title
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    approval: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    body_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

// An exact-text replacement for `tracker_doc_edit`.
#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
#[schemars(inline)]
struct ReplacementArg {
    /// Exact text, occurring once
    old: String,
    new: String,
}

#[derive(Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
struct TrackerQueueArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    /// Queue rows; default 20
    #[serde(default, skip_serializing_if = "Option::is_none")]
    limit: Option<u32>,
    /// Only the batch up to the next gate
    #[serde(default, skip_serializing_if = "Option::is_none")]
    until_gate: Option<bool>,
    /// Of requests, review, done, queue, blocked, deferred; default all but done; [] counts only
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sections: Option<Vec<String>>,
}

#[derive(Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
struct TrackerNextArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    /// Default 1
    #[serde(default, skip_serializing_if = "Option::is_none")]
    n: Option<u32>,
    /// dev|design|recon|analysis|gate
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    item_type: Option<String>,
}

#[derive(Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
struct TrackerListArgs {
    /// projects|items|labels|specs|concepts|docs|attachments
    what: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    /// items
    #[serde(default, skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    /// items
    #[serde(default, skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    /// concepts
    #[serde(default, skip_serializing_if = "Option::is_none")]
    state: Option<String>,
    /// docs: spec|milestone|concept|doc
    #[serde(default, skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
    /// docs: path prefix
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prefix: Option<String>,
}

/// `history`: `true` or `false`, or a number of events (the last N).
fn history_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({
        "type": ["boolean", "integer"],
        "description": "true: every event; N: the last N; default none"
    })
}

#[derive(Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
struct TrackerGetArgs {
    /// Ticket id, doc id or path, spec:<slug>, milestone:<slug>/<code>, concept:<slug>
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "history_schema")]
    history: Option<Value>,
}

/// How much history a read asks for (rag-t0039): none by default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum History {
    None,
    All,
    Last(usize),
}

fn history_of(v: Option<&Value>) -> Result<History, String> {
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => Ok(History::None),
        Some(Value::Bool(true)) => Ok(History::All),
        Some(Value::Number(n)) => match n.as_u64() {
            Some(0) => Ok(History::None),
            Some(n) => Ok(History::Last(n as usize)),
            None => Err("history is true, false or a number of events (0 or more)".into()),
        },
        Some(_) => Err("history is true, false or a number of events (0 or more)".into()),
    }
}

/// Links as the tools take them, `kind:target` (`ledger:rag-0033`,
/// `milestone:audio/m01`), the way the queue's lines show them: a string each
/// costs an agent far less to read in a schema than an object (rag-t0039).
fn links_of(links: Option<Vec<String>>) -> Result<Option<Vec<LinkArg>>, String> {
    links
        .map(|ls| {
            ls.iter()
                .map(|l| match l.split_once(':') {
                    Some((kind, target))
                        if !kind.trim().is_empty() && !target.trim().is_empty() =>
                    {
                        Ok(LinkArg {
                            kind: kind.trim().to_string(),
                            target: target.trim().to_string(),
                        })
                    }
                    _ => Err(format!(
                        "link `{l}` is kind:target, e.g. ledger:rag-0033 or milestone:audio/m01"
                    )),
                })
                .collect()
        })
        .transpose()
}

// `tracker_create`: a queue item or a gate.
#[derive(Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
struct CreateItemArgs {
    /// dev|design|recon|analysis|gate|request
    #[serde(rename = "type")]
    item_type: String,
    title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    body: Option<String>,
    /// stdio: a local file, instead of body
    #[serde(default, skip_serializing_if = "Option::is_none")]
    body_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    assignee: Option<String>,
    /// unapproved|agent|owner
    #[serde(default, skip_serializing_if = "Option::is_none")]
    approval: Option<String>,
    /// kind:target, e.g. ledger:rag-0033, item:ubu-t0042, from:<request id>
    #[serde(default, skip_serializing_if = "Option::is_none")]
    links: Option<Vec<String>>,
    /// Reuse the project's (tracker_list what=labels)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    labels: Option<Vec<String>>,
    /// Gate: quick|standard|full
    #[serde(default, skip_serializing_if = "Option::is_none")]
    intensity: Option<String>,
    /// Gate: a release follows
    #[serde(default, skip_serializing_if = "Option::is_none")]
    release: Option<bool>,
    /// May start before the gates above it; lands after them
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parallel: Option<bool>,
    /// Join before this id (default the bottom)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    after: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    top: Option<bool>,
    /// The owner's draft: out of the feed and the queue until published
    #[serde(default, skip_serializing_if = "Option::is_none")]
    draft: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
}

// `tracker_create_record`: a spec, a milestone, a concept or a document.
#[derive(Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
struct CreateRecordArgs {
    /// spec|milestone|concept|doc
    kind: String,
    title: String,
    /// spec, concept
    #[serde(default, skip_serializing_if = "Option::is_none")]
    slug: Option<String>,
    /// milestone: its spec's slug
    #[serde(default, skip_serializing_if = "Option::is_none")]
    spec: Option<String>,
    /// milestone: e.g. m03
    #[serde(default, skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    /// milestone: file name part; default the title
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    /// doc: e.g. notes/terrain.md
    #[serde(default, skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    state: Option<String>,
    /// unapproved|agent|owner
    #[serde(default, skip_serializing_if = "Option::is_none")]
    approval: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    body: Option<String>,
    /// stdio: a local file, instead of body
    #[serde(default, skip_serializing_if = "Option::is_none")]
    body_path: Option<String>,
    /// concept: kind:target, e.g. spec:audio, ledger:rag-0033
    #[serde(default, skip_serializing_if = "Option::is_none")]
    links: Option<Vec<String>>,
    /// spec: created with it, in order
    #[serde(default, skip_serializing_if = "Option::is_none")]
    milestones: Option<Vec<MilestoneArg>>,
    /// doc: the first revision's message
    #[serde(default, skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    /// The owner's draft: out of the feed and the queue until published
    #[serde(default, skip_serializing_if = "Option::is_none")]
    draft: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
}

/// Every create, flat: the shape [`create_req`] checks and sends. The two
/// tools' arguments ([`CreateItemArgs`], [`CreateRecordArgs`]) fill it.
#[derive(Debug, Default, Serialize)]
struct TrackerCreateArgs {
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    item_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    assignee: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    approval: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    links: Option<Vec<LinkArg>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    intensity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    release: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parallel: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    labels: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bottom: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    spec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    milestones: Option<Vec<MilestoneArg>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    draft: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
}

impl TryFrom<CreateItemArgs> for TrackerCreateArgs {
    type Error = String;

    fn try_from(a: CreateItemArgs) -> Result<Self, String> {
        Ok(Self {
            kind: "item".into(),
            project: a.project,
            item_type: Some(a.item_type),
            title: Some(a.title),
            body: a.body,
            body_path: a.body_path,
            assignee: a.assignee,
            approval: a.approval,
            links: links_of(a.links)?,
            intensity: a.intensity,
            release: a.release,
            parallel: a.parallel,
            labels: a.labels,
            before: a.before,
            after: a.after,
            top: a.top,
            draft: a.draft,
            note: a.note,
            agent: a.agent,
            ..Default::default()
        })
    }
}

impl TryFrom<CreateRecordArgs> for TrackerCreateArgs {
    type Error = String;

    fn try_from(a: CreateRecordArgs) -> Result<Self, String> {
        let kind = a.kind.trim().to_ascii_lowercase();
        if matches!(kind.as_str(), "item" | "gate") {
            return Err("tickets and gates are created with tracker_create".into());
        }
        Ok(Self {
            kind,
            project: a.project,
            title: Some(a.title),
            slug: a.slug,
            spec: a.spec,
            code: a.code,
            name: a.name,
            path: a.path,
            state: a.state,
            approval: a.approval,
            body: a.body,
            body_path: a.body_path,
            links: links_of(a.links)?,
            milestones: a.milestones,
            message: a.message,
            draft: a.draft,
            note: a.note,
            agent: a.agent,
            ..Default::default()
        })
    }
}

// `tracker_update`: a queue item (or gate).
#[derive(Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
struct UpdateItemArgs {
    /// e.g. ubu-t0042
    id: String,
    /// pending|in_progress|done|failed|cancelled|deferred|review
    #[serde(default, skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    blocked: Option<bool>,
    /// redesign|review|dependency
    #[serde(default, skip_serializing_if = "Option::is_none")]
    block_reason: Option<String>,
    /// With reason dependency: the ids it waits on; it unblocks when all are done
    #[serde(default, skip_serializing_if = "Option::is_none")]
    depends_on: Option<Vec<String>>,
    /// unapproved|agent|ratified|owner
    #[serde(default, skip_serializing_if = "Option::is_none")]
    approval: Option<String>,
    /// "" clears
    #[serde(default, skip_serializing_if = "Option::is_none")]
    assignee: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    body: Option<String>,
    /// kind:target, e.g. ledger:rag-0033, item:ubu-t0042
    #[serde(default, skip_serializing_if = "Option::is_none")]
    add_links: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    remove_links: Option<Vec<String>>,
    /// The whole set; [] clears
    #[serde(default, skip_serializing_if = "Option::is_none")]
    labels: Option<Vec<String>>,
    /// Gate: quick|standard|full
    #[serde(default, skip_serializing_if = "Option::is_none")]
    intensity: Option<String>,
    /// Gate
    #[serde(default, skip_serializing_if = "Option::is_none")]
    release: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parallel: Option<bool>,
    /// false publishes the owner's draft; true makes it one
    #[serde(default, skip_serializing_if = "Option::is_none")]
    draft: Option<bool>,
    /// Why; alone, a note on the history
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
}

// `tracker_update_record`: a spec, a milestone or a concept.
#[derive(Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
struct UpdateRecordArgs {
    /// spec:<slug>, milestone:<slug>/<code> or concept:<slug>
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    state: Option<String>,
    /// unapproved|agent|ratified|owner
    #[serde(default, skip_serializing_if = "Option::is_none")]
    approval: Option<String>,
    /// concept: kind:target
    #[serde(default, skip_serializing_if = "Option::is_none")]
    add_links: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    remove_links: Option<Vec<String>>,
    /// milestone: its place in the spec
    #[serde(default, skip_serializing_if = "Option::is_none")]
    order: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
}

/// Every update, flat: the shape [`update_req`] checks and sends.
#[derive(Debug, Default, Serialize)]
struct TrackerUpdateArgs {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    blocked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    block_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    depends_on: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    approval: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    assignee: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    add_links: Option<Vec<LinkArg>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    remove_links: Option<Vec<LinkArg>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    intensity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    release: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parallel: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    labels: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    order: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    draft: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
}

impl TryFrom<UpdateItemArgs> for TrackerUpdateArgs {
    type Error = String;

    fn try_from(a: UpdateItemArgs) -> Result<Self, String> {
        match parse_target(&a.id)? {
            Target::Item(_) => {}
            Target::Doc(_) | Target::Path(_) => {
                return Err("documents are changed with tracker_doc_edit".into())
            }
            _ => {
                return Err(
                    "tracker_update changes tickets; a spec, milestone or concept is \
                     changed with tracker_update_record"
                        .into(),
                )
            }
        }
        Ok(Self {
            id: a.id,
            note: a.note,
            status: a.status,
            blocked: a.blocked,
            block_reason: a.block_reason,
            depends_on: a.depends_on,
            approval: a.approval,
            assignee: a.assignee,
            title: a.title,
            body: a.body,
            add_links: links_of(a.add_links)?,
            remove_links: links_of(a.remove_links)?,
            intensity: a.intensity,
            release: a.release,
            parallel: a.parallel,
            labels: a.labels,
            draft: a.draft,
            agent: a.agent,
            ..Default::default()
        })
    }
}

impl TryFrom<UpdateRecordArgs> for TrackerUpdateArgs {
    type Error = String;

    fn try_from(a: UpdateRecordArgs) -> Result<Self, String> {
        match parse_target(&a.id)? {
            Target::Item(_) => {
                return Err("tickets are changed with tracker_update".into());
            }
            Target::Doc(_) | Target::Path(_) => {
                return Err("documents are changed with tracker_doc_edit".into())
            }
            _ => {}
        }
        Ok(Self {
            id: a.id,
            project: a.project,
            title: a.title,
            state: a.state,
            approval: a.approval,
            add_links: links_of(a.add_links)?,
            remove_links: links_of(a.remove_links)?,
            order: a.order,
            note: a.note,
            agent: a.agent,
            ..Default::default()
        })
    }
}

#[derive(Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
struct TrackerMoveArgs {
    /// The queued item to move
    id: String,
    /// Just before this id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    before: Option<String>,
    /// Just after this id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    after: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    top: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bottom: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
}

#[derive(Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
struct TrackerDocGetArgs {
    /// Doc id or path, spec:<slug>, milestone:<slug>/<code>, concept:<slug>
    doc: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    /// body (default)|revisions|diff
    #[serde(default, skip_serializing_if = "Option::is_none")]
    view: Option<String>,
    /// body: an older revision
    #[serde(default, skip_serializing_if = "Option::is_none")]
    revision: Option<i64>,
    /// body: with its events
    #[serde(default, skip_serializing_if = "Option::is_none")]
    history: Option<bool>,
    /// diff: default to - 1
    #[serde(default, skip_serializing_if = "Option::is_none")]
    from: Option<i64>,
    /// diff: default the current one
    #[serde(default, skip_serializing_if = "Option::is_none")]
    to: Option<i64>,
}

#[derive(Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
struct TrackerDocEditArgs {
    /// Doc id or path, spec:<slug>, milestone:<slug>/<code>, concept:<slug>
    doc: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    /// The revision you read; required but for a rename
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base_revision: Option<i64>,
    /// Applied in order, all or nothing
    #[serde(default, skip_serializing_if = "Option::is_none")]
    replacements: Option<Vec<ReplacementArg>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    body: Option<String>,
    /// stdio: a local file, instead of body
    #[serde(default, skip_serializing_if = "Option::is_none")]
    body_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    restore_revision: Option<i64>,
    /// Rename; the old path redirects
    #[serde(default, skip_serializing_if = "Option::is_none")]
    new_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    new_title: Option<String>,
    /// One line: what changed
    #[serde(default, skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
}

#[derive(Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
struct TrackerAttachArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    /// stdio: a local file, at most 50 MB
    #[serde(default, skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    /// gateway: the bytes, at most 10 MB, with name
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    media_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
}

#[derive(Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
struct TrackerAttachmentGetArgs {
    /// att:<hash>
    #[serde(rename = "ref")]
    reference: String,
    /// stdio: where to write it
    #[serde(default, skip_serializing_if = "Option::is_none")]
    out_path: Option<String>,
}

#[derive(Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
struct TrackerAckDoneArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
}

// ---- Request builders -----------------------------------------------------------

const ITEM_CREATE: &[&str] = &[
    "type",
    "title",
    "body",
    "assignee",
    "approval",
    "links",
    "intensity",
    "release",
    "parallel",
    "labels",
    "before",
    "after",
    "top",
    "bottom",
    "draft",
    "note",
];
const SPEC_CREATE: &[&str] = &[
    "slug",
    "title",
    "state",
    "approval",
    "body",
    "milestones",
    "draft",
    "note",
];
const MILESTONE_CREATE: &[&str] = &[
    "code", "title", "name", "state", "approval", "body", "draft", "note",
];
const CONCEPT_CREATE: &[&str] = &[
    "slug", "title", "state", "approval", "body", "links", "draft", "note",
];
const DOC_CREATE: &[&str] = &["path", "title", "body", "message", "draft"];

const ITEM_UPDATE: &[&str] = &[
    "status",
    "blocked",
    "block_reason",
    "depends_on",
    "approval",
    "assignee",
    "title",
    "body",
    "add_links",
    "remove_links",
    "intensity",
    "release",
    "parallel",
    "labels",
    "draft",
    "note",
];
const SPEC_UPDATE: &[&str] = &["title", "state", "approval", "note"];
const MILESTONE_UPDATE: &[&str] = &["title", "state", "approval", "order", "note"];
const CONCEPT_UPDATE: &[&str] = &[
    "title",
    "state",
    "approval",
    "add_links",
    "remove_links",
    "note",
];

fn queue_req(project: Option<&str>) -> Result<Req, String> {
    Ok(Req::get(format!(
        "/tracker/{}",
        enc(need_project(project)?)
    )))
}

fn list_req(args: &TrackerListArgs, project: Option<&str>) -> Result<Req, String> {
    let mut f = present(args);
    let what = args.what.trim().to_ascii_lowercase();
    for k in ["what", "project"] {
        f.remove(k);
    }
    let (allowed, path): (&[&str], String) = match what.as_str() {
        "projects" => (&[], "/tracker/projects".to_string()),
        "items" => {
            let p = enc(need_project(project)?);
            (
                &["status", "label"],
                format!(
                    "/tracker/{p}/items{}",
                    query(&[("status", args.status.clone()), ("label", args.label.clone())])
                ),
            )
        }
        "labels" => (
            &[],
            format!("/tracker/{}/labels", enc(need_project(project)?)),
        ),
        "specs" => (
            &[],
            format!("/tracker/{}/specs", enc(need_project(project)?)),
        ),
        "concepts" => {
            let p = enc(need_project(project)?);
            (
                &["state"],
                format!(
                    "/tracker/{p}/concepts{}",
                    query(&[("state", args.state.clone())])
                ),
            )
        }
        "docs" => {
            let p = enc(need_project(project)?);
            (
                &["kind", "prefix"],
                format!(
                    "/tracker/{p}/docs{}",
                    query(&[("kind", args.kind.clone()), ("prefix", args.prefix.clone())])
                ),
            )
        }
        "attachments" => (
            &[],
            format!("/tracker/{}/attachments", enc(need_project(project)?)),
        ),
        other => {
            return Err(format!(
                "cannot list `{other}`: give projects, items, labels, specs, concepts, docs or attachments"
            ))
        }
    };
    only(&f, allowed, &format!("a list of {what}"))?;
    Ok(Req::get(path))
}

/// A record read (`tracker_get`) for anything but a document.
fn record_get_req(target: &Target, project: Option<&str>, history: bool) -> Result<Req, String> {
    let q = query(&[("history", history_param(history))]);
    Ok(Req::get(match target {
        Target::Item(id) => format!("/tracker/items/{}{q}", enc(id)),
        Target::Spec(slug) => format!(
            "/tracker/{}/specs/{}{q}",
            enc(need_project(project)?),
            enc(slug)
        ),
        Target::Milestone(slug, code) => format!(
            "/tracker/{}/specs/{}/milestones/{}{q}",
            enc(need_project(project)?),
            enc(slug),
            enc(code)
        ),
        Target::Concept(slug) => format!(
            "/tracker/{}/concepts/{}{q}",
            enc(need_project(project)?),
            enc(slug)
        ),
        Target::Doc(_) | Target::Path(_) => {
            return doc_get_req(target, project, None, history);
        }
    }))
}

/// A document read by id or path (the server follows a renamed path's redirect).
fn doc_get_req(
    target: &Target,
    project: Option<&str>,
    revision: Option<i64>,
    history: bool,
) -> Result<Req, String> {
    let rev = revision.map(|r| r.to_string());
    Ok(Req::get(match target {
        Target::Doc(id) => format!(
            "/tracker/docs/{}{}",
            enc(id),
            query(&[("revision", rev), ("history", history_param(history))])
        ),
        Target::Path(path) => format!(
            "/tracker/{}/doc{}",
            enc(need_project(project)?),
            query(&[
                ("path", Some(path.clone())),
                ("revision", rev),
                ("history", history_param(history)),
            ])
        ),
        _ => return Err("not a document id or path".to_string()),
    }))
}

fn revisions_req(doc_id: &str) -> Req {
    Req::get(format!("/tracker/docs/{}/revisions", enc(doc_id)))
}

fn diff_req(doc_id: &str, from: Option<i64>, to: Option<i64>) -> Req {
    Req::get(format!(
        "/tracker/docs/{}/diff{}",
        enc(doc_id),
        query(&[
            ("from", from.map(|v| v.to_string())),
            ("to", to.map(|v| v.to_string())),
        ])
    ))
}

fn create_req(
    args: &TrackerCreateArgs,
    project: Option<&str>,
    who: &Author,
) -> Result<Req, String> {
    let mut f = present(args);
    for k in ["kind", "project", "agent"] {
        f.remove(k);
    }
    let kind = args.kind.trim().to_ascii_lowercase();
    let p = enc(need_project(project)?);
    let (allowed, path): (&[&str], String) = match kind.as_str() {
        "item" => (ITEM_CREATE, format!("/tracker/{p}/items")),
        "gate" => {
            match f.get("type").and_then(Value::as_str) {
                None => {
                    f.insert("type".into(), json!("gate"));
                }
                Some("gate") => {}
                Some(other) => {
                    return Err(format!(
                        "kind gate creates a ticket of type gate, not `{other}`"
                    ))
                }
            }
            (ITEM_CREATE, format!("/tracker/{p}/items"))
        }
        "spec" => (SPEC_CREATE, format!("/tracker/{p}/specs")),
        "milestone" => {
            let spec = f
                .remove("spec")
                .and_then(|v| v.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .ok_or("a milestone needs `spec`: the slug of the spec it joins")?;
            (
                MILESTONE_CREATE,
                format!("/tracker/{p}/specs/{}/milestones", enc(&spec)),
            )
        }
        "concept" => (CONCEPT_CREATE, format!("/tracker/{p}/concepts")),
        "doc" => (DOC_CREATE, format!("/tracker/{p}/docs")),
        other => {
            return Err(format!(
                "cannot create `{other}`: kind is item, gate, spec, milestone, concept or doc"
            ))
        }
    };
    only(&f, allowed, &format!("a {kind}"))?;
    who.stamp(&mut f);
    Ok(Req::post(path, f))
}

fn update_req(
    args: &TrackerUpdateArgs,
    project: Option<&str>,
    who: &Author,
) -> Result<Req, String> {
    let mut f = present(args);
    for k in ["id", "project", "agent"] {
        f.remove(k);
    }
    // A note is optional with any change (D7, amended 2026-10-27); a blank one is
    // no note. Only a call that changes nothing needs one: the note is all it records.
    if args.note.as_deref().is_some_and(|n| n.trim().is_empty()) {
        f.remove("note");
    }
    if f.is_empty() {
        return Err(
            "nothing to update: give a field to change, or a note (alone, it is recorded as \
             a note on the history)"
                .to_string(),
        );
    }
    let (allowed, path, what): (&[&str], String, &str) = match parse_target(&args.id)? {
        Target::Item(id) => (
            ITEM_UPDATE,
            format!("/tracker/items/{}", enc(&id)),
            "a ticket",
        ),
        Target::Spec(slug) => (
            SPEC_UPDATE,
            format!(
                "/tracker/{}/specs/{}",
                enc(need_project(project)?),
                enc(&slug)
            ),
            "a spec",
        ),
        Target::Milestone(slug, code) => (
            MILESTONE_UPDATE,
            format!(
                "/tracker/{}/specs/{}/milestones/{}",
                enc(need_project(project)?),
                enc(&slug),
                enc(&code)
            ),
            "a milestone",
        ),
        Target::Concept(slug) => (
            CONCEPT_UPDATE,
            format!(
                "/tracker/{}/concepts/{}",
                enc(need_project(project)?),
                enc(&slug)
            ),
            "a concept",
        ),
        Target::Doc(_) | Target::Path(_) => {
            return Err(
                "documents are changed with tracker_doc_edit (content and renames)".to_string(),
            )
        }
    };
    only(&f, allowed, what)?;
    who.stamp(&mut f);
    Ok(Req::post(path, f))
}

fn move_req(args: &TrackerMoveArgs, who: &Author) -> Result<Req, String> {
    let id = match parse_target(&args.id)? {
        Target::Item(id) => id,
        _ => return Err("only tickets move: give a ticket id (ubu-t0042)".to_string()),
    };
    let mut f = present(args);
    for k in ["id", "agent"] {
        f.remove(k);
    }
    who.stamp(&mut f);
    Ok(Req::post(format!("/tracker/items/{}/move", enc(&id)), f))
}

fn doc_edit_req(doc_id: &str, args: &TrackerDocEditArgs, who: &Author) -> Result<Req, String> {
    let rename = args.new_path.is_some() || args.new_title.is_some();
    let modes = [
        args.replacements.is_some(),
        args.body.is_some(),
        args.restore_revision.is_some(),
        rename,
    ];
    if modes.iter().filter(|m| **m).count() != 1 {
        return Err(
            "give exactly one of: replacements, body, restore_revision, or \
             new_path / new_title (a rename)"
                .to_string(),
        );
    }
    let id = enc(doc_id);
    let mut f = Map::new();
    if rename {
        if let Some(p) = &args.new_path {
            f.insert("path".into(), json!(p));
        }
        if let Some(t) = &args.new_title {
            f.insert("title".into(), json!(t));
        }
        if let Some(m) = &args.message {
            f.insert("note".into(), json!(m));
        }
        who.stamp(&mut f);
        return Ok(Req::post(format!("/tracker/docs/{id}/rename"), f));
    }
    let base = args.base_revision.ok_or(
        "base_revision is required: read the document with tracker_doc_get and pass the \
         revision it shows",
    )?;
    f.insert("base_revision".into(), json!(base));
    if let Some(m) = &args.message {
        f.insert("message".into(), json!(m));
    }
    let route = if let Some(reps) = &args.replacements {
        if reps.is_empty() {
            return Err("replacements is empty".to_string());
        }
        f.insert("replacements".into(), json!(reps));
        "edit"
    } else if let Some(body) = &args.body {
        f.insert("body".into(), json!(body));
        "write"
    } else {
        f.insert("revision".into(), json!(args.restore_revision));
        "restore"
    };
    who.stamp(&mut f);
    Ok(Req::post(format!("/tracker/docs/{id}/{route}"), f))
}

fn ack_req(project: Option<&str>, who: &Author) -> Result<Req, String> {
    let mut f = Map::new();
    who.stamp(&mut f);
    Ok(Req::post(
        format!("/tracker/{}/ack-done", enc(need_project(project)?)),
        f,
    ))
}

/// The hash part of an `att:` reference or sha256 (prefix).
fn attachment_hash(reference: &str) -> Result<String, String> {
    let r = reference.trim();
    let h = r.strip_prefix("att:").unwrap_or(r).to_ascii_lowercase();
    if h.len() < 12 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!(
            "`{r}` is not an attachment reference: give att:<12+ hex> or a sha256"
        ));
    }
    Ok(h)
}

fn attachment_get_req(reference: &str) -> Result<Req, String> {
    Ok(Req::get(format!(
        "/tracker/attachments/{}",
        attachment_hash(reference)?
    )))
}

/// A media type from a file name, for the common document types. Images are left
/// undeclared: the server recognises them by their bytes, which is safer than an
/// extension that lies.
fn guess_media(name: &str) -> Option<&'static str> {
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match ext.as_str() {
        "md" | "markdown" => "text/markdown",
        "txt" | "log" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "toml" => "application/toml",
        "yaml" | "yml" => "application/yaml",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        _ => return None,
    })
}

/// A file name safe to put in a header or on disk.
fn safe_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "._- ".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let s = s.trim().trim_start_matches('.').to_string();
    if s.is_empty() {
        "attachment".to_string()
    } else {
        s
    }
}

/// A multipart boundary that does not occur in the bytes.
fn boundary_for(bytes: &[u8]) -> String {
    let mut n: u64 = 0x5eed_1e55_u64 ^ bytes.len() as u64;
    loop {
        let b = format!("----rag-mcp-tracker-{n:016x}");
        if !bytes.windows(b.len()).any(|w| w == b.as_bytes()) {
            return b;
        }
        n = n
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
    }
}

/// The `multipart/form-data` body for `POST /tracker/{project}/attachments`.
fn multipart_body(
    boundary: &str,
    fields: &[(&str, &str)],
    file_name: &str,
    media_type: Option<&str>,
    bytes: &[u8],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + 512);
    for (k, v) in fields {
        out.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n")
                .as_bytes(),
        );
    }
    out.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{}\"\r\n\
             Content-Type: {}\r\n\r\n",
            safe_name(file_name),
            media_type.unwrap_or("application/octet-stream")
        )
        .as_bytes(),
    );
    out.extend_from_slice(bytes);
    out.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    out
}

/// The file name in a `Content-Disposition` header.
fn disposition_name(header: &str) -> Option<String> {
    let start = header.find("filename=\"")? + "filename=\"".len();
    let end = header[start..].find('"')? + start;
    Some(header[start..end].to_string())
}

fn default_out_path(hash: &str, name: Option<&str>) -> PathBuf {
    let prefix: String = hash.chars().take(12).collect();
    std::env::temp_dir().join("rag-tracker").join(format!(
        "{prefix}-{}",
        safe_name(name.unwrap_or("attachment"))
    ))
}

fn is_raster(media: &str) -> bool {
    media.starts_with("image/") && media != "image/svg+xml"
}

// ---- Responses ----------------------------------------------------------------

/// A non-2xx answer from rag-serve as a tool error carrying the server's message.
fn refusal(status: u16, text: &str) -> McpError {
    let v: Option<Value> = serde_json::from_str(text).ok();
    let msg = v
        .as_ref()
        .and_then(|v| v.get("error").and_then(Value::as_str))
        .map(String::from)
        .unwrap_or_else(|| text.chars().take(2000).collect());
    match status {
        409 => {
            let cur = v
                .as_ref()
                .and_then(|v| v.get("current_revision"))
                .and_then(Value::as_i64);
            let tail = match cur {
                Some(c) => format!(
                    " — stale base_revision: the current revision is {c}. Nothing was written; \
                     re-read it with tracker_doc_get and apply your change to the current text \
                     with base_revision {c}"
                ),
                None => " — nothing was written".to_string(),
            };
            McpError::invalid_params(format!("{msg}{tail}"), None)
        }
        400 | 404 | 422 => McpError::invalid_params(msg, None),
        503 => McpError::internal_error(
            format!("rag-serve 503: the tracker store is not open on the server ({msg})"),
            None,
        ),
        _ => McpError::internal_error(format!("rag-serve {status}: {msg}"), None),
    }
}

fn text(s: impl Into<String>) -> CallToolResult {
    CallToolResult::success(vec![Content::text(s.into())])
}

fn bad(msg: impl Into<String>) -> McpError {
    McpError::invalid_params(msg.into(), None)
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn glyph(status: &str) -> &'static str {
    match status {
        "in_progress" => "●",
        "pending" => "○",
        "failed" => "✗",
        "done" => "✓",
        "cancelled" => "–",
        "deferred" => "◌",
        "review" => "◆",
        _ => "?",
    }
}

fn links_text(v: &Value) -> Option<String> {
    let links = arr(v, "links");
    (!links.is_empty()).then(|| {
        links
            .iter()
            .map(|l| format!("{}:{}", s(l, "kind"), s(l, "target")))
            .collect::<Vec<_>>()
            .join(", ")
    })
}

/// An item's labels as `[Physics, Biomes]`, or `None` when it has none (rag-t0027).
fn labels_text(it: &Value) -> Option<String> {
    let labels: Vec<&str> = arr(it, "labels").iter().filter_map(Value::as_str).collect();
    (!labels.is_empty()).then(|| format!("[{}]", labels.join(", ")))
}

/// The assignee, labels, approval (when there is one) and links of an item or marker.
fn item_extras(it: &Value, parts: &mut Vec<String>) {
    if it.get("draft").and_then(Value::as_bool) == Some(true) {
        parts.push("draft".into());
    }
    let assignee = s(it, "assignee");
    if !assignee.is_empty() {
        parts.push(format!("agent: {assignee}"));
    }
    if let Some(l) = labels_text(it) {
        parts.push(l);
    }
    let approval = s(it, "approval");
    if !approval.is_empty() && approval != "unapproved" {
        parts.push(format!("approval: {approval}"));
    }
    if let Some(l) = links_text(it) {
        parts.push(format!("links: {l}"));
    }
}

fn gate_label(it: &Value) -> String {
    let mut g = format!("gate: {}", s(it, "intensity"));
    if it.get("release").and_then(Value::as_bool) == Some(true) {
        g.push_str(" · release");
    }
    g
}

fn is_parallel(it: &Value) -> bool {
    it.get("parallel").and_then(Value::as_bool) == Some(true)
}

/// One item as a line: `● ubu-t0042 [dev] title · in progress · agent: dev-3 · approval: agent`,
/// with `parallel` on an item that may start before the gates above it (rag-t0013) and,
/// blocked with reason dependency, what it waits on (`blocked: dependency: waits on
/// ubu-t0040`, rag-t0018).
fn item_line(it: &Value) -> String {
    item_line_with(it, None)
}

/// [`item_line`], its `parallel` marker replaced by `parallel_note` when given.
fn item_line_with(it: &Value, parallel_note: Option<&str>) -> String {
    let status = s(it, "status");
    let ty = if s(it, "type") == "gate" {
        gate_label(it)
    } else {
        s(it, "type").to_string()
    };
    let mut parts = vec![status.replace('_', " ")];
    if let Some(n) = parallel_note {
        parts.push(n.to_string());
    } else if is_parallel(it) {
        parts.push("parallel".into());
    }
    item_extras(it, &mut parts);
    if it.get("blocked").and_then(Value::as_bool) == Some(true) {
        let mut b = format!("blocked: {}", s(it, "block_reason"));
        let waits: Vec<&str> = arr(it, "depends_on")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        if !waits.is_empty() {
            b.push_str(&format!(": waits on {}", waits.join(", ")));
        }
        let note = s(it, "block_note");
        if !note.is_empty() {
            b.push_str(&format!(": {note}"));
        }
        parts.push(b);
    }
    format!(
        "{} {} [{ty}] {} · {}",
        glyph(status),
        s(it, "id"),
        s(it, "title"),
        parts.join(" · ")
    )
}

/// A gate in the queue, drawn as a marker: `── ubu-t0043 gate: standard · release ──`.
fn gate_marker(it: &Value) -> String {
    let mut parts = vec![gate_label(it)];
    let status = s(it, "status");
    if status != "pending" {
        parts.push(status.replace('_', " "));
    }
    item_extras(it, &mut parts);
    format!("── {} {} ──", s(it, "id"), parts.join(" · "))
}

/// `tracker_queue`'s default row limit.
const QUEUE_LIMIT: u32 = 20;

/// The item types, for `tracker_next`'s filter: every type but `request`,
/// which is never dispatched (rag-t0044).
const ITEM_TYPES: &[&str] = &["dev", "design", "recon", "analysis", "gate"];

/// What `tracker_queue` lists, checked before any request.
#[derive(Debug, Clone, PartialEq, Eq)]
struct QueueOpts {
    /// The most queue rows to list.
    limit: usize,
    /// Stop after the gate that ends the next batch.
    until_gate: bool,
    requests: bool,
    review: bool,
    done: bool,
    queue: bool,
    blocked: bool,
    deferred: bool,
}

fn queue_opts(args: &TrackerQueueArgs) -> Result<QueueOpts, String> {
    let limit = args.limit.unwrap_or(QUEUE_LIMIT);
    if limit == 0 {
        return Err(
            "limit must be at least 1 (to list no queue rows, leave queue out of sections)".into(),
        );
    }
    let (mut requests, mut review, mut done, mut queue, mut blocked, mut deferred) =
        (true, true, false, true, true, true);
    if let Some(list) = &args.sections {
        (requests, review, queue, blocked, deferred) = (false, false, false, false, false);
        for raw in list {
            match raw.trim().to_ascii_lowercase().as_str() {
                "requests" => requests = true,
                "review" => review = true,
                "done" => done = true,
                "queue" => queue = true,
                "blocked" => blocked = true,
                "deferred" => deferred = true,
                other => {
                    return Err(format!(
                        "unknown section {other:?}: requests, review, done, queue, blocked or \
                         deferred"
                    ))
                }
            }
        }
    }
    Ok(QueueOpts {
        limit: limit as usize,
        until_gate: args.until_gate.unwrap_or(false),
        requests,
        review,
        done,
        queue,
        blocked,
        deferred,
    })
}

/// `tracker_next`'s count and type filter, checked before any request.
fn next_opts(args: &TrackerNextArgs) -> Result<(usize, Option<String>), String> {
    let n = args.n.unwrap_or(1);
    if n == 0 {
        return Err("n must be at least 1".into());
    }
    let ty = match args.item_type.as_deref() {
        None => None,
        Some(raw) => {
            let t = raw.trim().to_ascii_lowercase();
            if t == "request" {
                return Err(
                    "requests are never dispatched: tracker_queue lists them, to break down".into(),
                );
            }
            if !ITEM_TYPES.contains(&t.as_str()) {
                return Err(format!(
                    "unknown type {raw:?}: dev, design, recon, analysis or gate"
                ));
            }
            Some(t)
        }
    };
    Ok((n as usize, ty))
}

fn is_gate(it: &Value) -> bool {
    s(it, "type") == "gate"
}

/// The gate that ends a batch: the first gate not already in progress. A running
/// gate has been dispatched; the batch after it is the next one.
fn ends_batch(it: &Value) -> bool {
    is_gate(it) && s(it, "status") != "in_progress"
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// The `Not shown:` footer of `tracker_queue` and `tracker_next`: every item of the
/// queue view not listed above, counted once each under the first that applies:
/// blocked, then gate (any status), then its status (pending, in progress, failed),
/// then the requests (rag-t0044), the owner's drafts, the deferred items (blocked or not), the items in
/// review (blocked or not) and the done items not yet acknowledged.
/// Zero counts are left out.
fn not_shown(v: &Value, shown: &BTreeSet<&str>) -> String {
    let hidden = |k: &str| {
        arr(v, k)
            .iter()
            .filter(|it| !shown.contains(s(it, "id")))
            .collect::<Vec<_>>()
    };
    let (mut pending, mut running, mut failed, mut gates) = (0, 0, 0, 0);
    for it in hidden("queue") {
        if is_gate(it) {
            gates += 1;
            continue;
        }
        match s(it, "status") {
            "in_progress" => running += 1,
            "failed" => failed += 1,
            _ => pending += 1,
        }
    }
    let (requests, drafts, blocked, deferred, review, done) = (
        hidden("requests").len(),
        hidden("drafts").len(),
        hidden("blocked").len(),
        hidden("deferred").len(),
        hidden("review").len(),
        hidden("done").len(),
    );
    let parts: Vec<String> = [
        (pending, format!("{pending} pending")),
        (running, format!("{running} in progress")),
        (failed, format!("{failed} failed")),
        (gates, plural(gates, "gate", "gates")),
        (requests, plural(requests, "request", "requests")),
        (drafts, plural(drafts, "draft", "drafts")),
        (blocked, format!("{blocked} blocked")),
        (deferred, format!("{deferred} deferred")),
        (review, format!("{review} in review")),
        (done, format!("{done} done not acknowledged")),
    ]
    .into_iter()
    .filter(|(n, _)| *n > 0)
    .map(|(_, t)| t)
    .collect();
    if parts.is_empty() {
        "Not shown: none".into()
    } else {
        format!("Not shown: {}", parts.join(" · "))
    }
}

fn unknown_project(v: &Value) -> Option<String> {
    (v.get("exists").and_then(Value::as_bool) == Some(false)).then(|| {
        format!(
            "{}: no tracker records yet (a project is created by its first write).",
            s(v, "project")
        )
    })
}

/// `tracker_queue`'s text: a header of totals, then the sections asked for (the
/// owner's requests first, rag-t0044: work to break down; review, rag-t0024: the work
/// waiting on the owner; done not yet acknowledged; the
/// queue in order with gate markers, cut at the limit or the gate with a line saying
/// how many more; blocked; deferred), then the `Not shown:` footer.
/// Compact and stable (a golden test pins it).
fn render_queue(v: &Value, o: &QueueOpts) -> String {
    if let Some(t) = unknown_project(v) {
        return t;
    }
    let (requests, review, done, queue, blocked, deferred) = (
        arr(v, "requests"),
        arr(v, "review"),
        arr(v, "done"),
        arr(v, "queue"),
        arr(v, "blocked"),
        arr(v, "deferred"),
    );
    let mut out = vec![format!(
        "{}: {}, {} in review, {} in the queue, {} blocked, {} deferred, {} done not acknowledged",
        s(v, "project"),
        plural(requests.len(), "request", "requests"),
        review.len(),
        queue.len(),
        blocked.len(),
        deferred.len(),
        done.len()
    )];
    let mut shown = BTreeSet::new();
    let section = |out: &mut Vec<String>, name: &str, rows: Vec<String>| {
        if rows.is_empty() {
            out.push(format!("{name}: none"));
        } else {
            out.push(format!("{name}:"));
            out.extend(rows.into_iter().map(|r| format!("  {r}")));
        }
    };
    if o.requests {
        shown.extend(requests.iter().map(|it| s(it, "id")));
        section(
            &mut out,
            "Requests",
            requests.iter().map(item_line).collect(),
        );
    }
    if o.review {
        shown.extend(review.iter().map(|it| s(it, "id")));
        section(&mut out, "Review", review.iter().map(item_line).collect());
    }
    if o.done {
        shown.extend(done.iter().map(|it| s(it, "id")));
        section(&mut out, "Done", done.iter().map(item_line).collect());
    }
    if o.queue {
        let mut rows = Vec::new();
        let mut cut = None;
        for it in queue {
            if rows.len() == o.limit {
                cut = Some(format!("(limit {})", o.limit));
                break;
            }
            shown.insert(s(it, "id"));
            rows.push(if is_gate(it) {
                gate_marker(it)
            } else {
                item_line(it)
            });
            if o.until_gate && ends_batch(it) {
                cut = Some("below the gate (until_gate)".into());
                break;
            }
        }
        let more = queue.len() - rows.len();
        section(&mut out, "Queue", rows);
        if let (Some(why), true) = (cut, more > 0) {
            out.push(format!("  … {more} more queued {why}"));
        }
    }
    if o.blocked {
        shown.extend(blocked.iter().map(|it| s(it, "id")));
        section(&mut out, "Blocked", blocked.iter().map(item_line).collect());
    }
    if o.deferred {
        shown.extend(deferred.iter().map(|it| s(it, "id")));
        section(
            &mut out,
            "Deferred",
            deferred.iter().map(item_line).collect(),
        );
    }
    out.push(not_shown(v, &shown));
    out.join("\n")
}

/// One item in full for `tracker_next`: its queue line, then its body between rules.
fn item_full(it: &Value) -> String {
    item_full_with(it, None)
}

/// [`item_full`] with its line's `parallel` marker replaced by `parallel_note`.
fn item_full_with(it: &Value, parallel_note: Option<&str>) -> String {
    let body = s(it, "body").trim_end();
    format!(
        "{}\n-----\n{}\n-----",
        item_line_with(it, parallel_note),
        if body.is_empty() { "(no body)" } else { body }
    )
}

/// `tracker_next`'s text: a header saying what was picked and where the batch ends,
/// each picked item in full, then the `Not shown:` footer.
///
/// The walk goes down the queue (requests, review, blocked and deferred items are not
/// in it, so none of them holds a gate), takes the first `n`
/// pending items of the wanted type, passes over the rest (in progress, failed, other
/// types) and stops at the first gate not already in progress. That gate is itself the
/// next job, and is returned, only when nothing at all is queued above it.
///
/// Then, while fewer than `n` are picked, the rest of the queue below that gate is
/// searched for **parallel** items (rag-t0013): pending, of the wanted type, marked
/// `parallel`, in queue order. Each is listed after the batch with the nearest gate
/// above it, the one it lands after: `parallel: lands after gate ubu-t0043`.
fn render_next(v: &Value, n: usize, ty: Option<&str>) -> String {
    if let Some(t) = unknown_project(v) {
        return t;
    }
    let project = s(v, "project");
    let wanted = |it: &Value| ty.is_none_or(|t| s(it, "type") == t);
    let mut picked: Vec<&Value> = Vec::new();
    let (mut eligible, mut running, mut failed, mut other) = (0usize, 0usize, 0usize, 0usize);
    let mut gate = None;
    let queue = arr(v, "queue");
    let mut below: &[Value] = &[];
    for (at, it) in queue.iter().enumerate() {
        // Never a request (rag-t0044): the server lists them apart; a stray
        // one is neither offered nor counted.
        if s(it, "type") == "request" {
            continue;
        }
        if is_gate(it) {
            if ends_batch(it) {
                gate = Some(it);
                below = &queue[at + 1..];
                break;
            }
            // A running gate is passed over, but nothing below it is at the top.
            running += 1;
            continue;
        }
        match s(it, "status") {
            "pending" if wanted(it) => {
                eligible += 1;
                if picked.len() < n {
                    picked.push(it);
                }
            }
            "pending" => other += 1,
            "in_progress" => running += 1,
            "failed" => failed += 1,
            _ => {}
        }
    }
    let kind = ty.map(|t| format!("{t} ")).unwrap_or_default();
    let filter = ty.map(|t| format!(" (type {t})")).unwrap_or_default();
    let held = [
        (running, format!("{running} in progress")),
        (failed, format!("{failed} failed")),
        (other, format!("{other} pending of other types")),
    ]
    .into_iter()
    .filter(|(c, _)| *c > 0)
    .map(|(_, t)| t)
    .collect::<Vec<_>>()
    .join(", ");
    let at_top = eligible + running + failed + other == 0;
    let gate_ref = |g: &Value| format!("gate {} ({})", s(g, "id"), gate_label(g));

    let mut shown = BTreeSet::new();
    let mut out = Vec::new();
    match gate {
        _ if !picked.is_empty() => {
            let place = gate.map_or("(no gate below them)".to_string(), |g| {
                format!("before {}", gate_ref(g))
            });
            out.push(format!(
                "{project}: the next {} of {} {place}",
                picked.len(),
                plural(
                    eligible,
                    &format!("dispatchable {kind}ticket"),
                    &format!("dispatchable {kind}tickets")
                ),
            ));
        }
        Some(g) if at_top && s(g, "status") == "pending" && wanted(g) => {
            out.push(format!(
                "{project}: the next job is {}: nothing is queued above it",
                gate_ref(g)
            ));
            picked.push(g);
        }
        Some(g) if at_top && s(g, "status") == "pending" => out.push(format!(
            "{project}: nothing dispatchable{filter}: the next job is {}",
            gate_ref(g)
        )),
        Some(g) if at_top => out.push(format!(
            "{project}: nothing dispatchable: {} is {} and holds the queue",
            gate_ref(g),
            s(g, "status").replace('_', " ")
        )),
        Some(g) => out.push(format!(
            "{project}: nothing dispatchable{filter}: {} waits on {held} above it",
            gate_ref(g)
        )),
        None if held.is_empty() => out.push(format!(
            "{project}: nothing dispatchable: the queue is empty"
        )),
        None => out.push(format!(
            "{project}: nothing dispatchable{filter}: the queue holds {held}"
        )),
    }
    for it in &picked {
        shown.insert(s(it, "id"));
        out.push(String::new());
        out.push(item_full(it));
    }

    // Parallel work below the gate (rag-t0013): it may start now, and lands
    // after the nearest gate above it.
    let mut parallel: Vec<(&Value, &Value)> = Vec::new();
    let mut parallel_found = 0usize;
    if let Some(mut above) = gate {
        for it in below {
            if is_gate(it) {
                above = it;
                continue;
            }
            if is_parallel(it) && s(it, "status") == "pending" && wanted(it) {
                parallel_found += 1;
                if picked.len() + parallel.len() < n {
                    parallel.push((it, above));
                }
            }
        }
    }
    let parallel_items = |k: usize| {
        plural(
            k,
            &format!("parallel {kind}ticket"),
            &format!("parallel {kind}tickets"),
        )
    };
    if !parallel.is_empty() {
        out.push(String::new());
        out.push(format!(
            "Below the gate: {} of {}, which may start now and land after the gate named",
            parallel.len(),
            parallel_items(parallel_found)
        ));
        for (it, g) in &parallel {
            shown.insert(s(it, "id"));
            out.push(String::new());
            let note = format!("parallel: lands after gate {}", s(g, "id"));
            out.push(item_full_with(it, Some(&note)));
        }
    } else if parallel_found > 0 {
        out.push(String::new());
        out.push(format!(
            "Below the gate: {} not listed (raise n)",
            parallel_items(parallel_found)
        ));
    }
    out.push(String::new());
    out.push(not_shown(v, &shown));
    out.join("\n")
}

fn event_line(e: &Value) -> String {
    let agent = match s(e, "agent") {
        "" => "Unknown",
        a => a,
    };
    format!(
        "  {} {} · {agent} via {} ({}) · {}",
        s(e, "ts"),
        s(e, "kind"),
        s(e, "surface"),
        s(e, "author_email"),
        s(e, "body")
    )
}

/// A document view as text: its header, the revision to edit against, the body,
/// and the history when it was asked for.
fn render_doc(v: &Value) -> String {
    let rev = v.get("revision").and_then(Value::as_i64).unwrap_or(0);
    let body_rev = v
        .get("body_revision")
        .and_then(Value::as_i64)
        .unwrap_or(rev);
    let mut out = vec![format!(
        "{} · {} · {} · {}",
        s(v, "id"),
        s(v, "path"),
        s(v, "kind"),
        s(v, "title")
    )];
    out.push(format!(
        "revision {rev} (edit with base_revision {rev}) · updated {}",
        s(v, "updated_at")
    ));
    if body_rev != rev {
        out.push(format!(
            "showing revision {body_rev}, an older body (the current revision is {rev})"
        ));
    }
    if let Some(from) = v.get("redirected_from").and_then(Value::as_str) {
        out.push(format!("redirected from {from} (renamed)"));
    }
    let owner: Vec<String> = ["spec", "milestone", "concept"]
        .iter()
        .filter_map(|k| {
            v.get(*k)
                .and_then(Value::as_str)
                .map(|x| format!("{k} {x}"))
        })
        .collect();
    if !owner.is_empty() {
        out.push(format!("belongs to {}", owner.join(", ")));
    }
    out.push("-----".to_string());
    out.push(s(v, "body").to_string());
    out.push("-----".to_string());
    let events = arr(v, "events");
    if !events.is_empty() {
        out.push("History:".to_string());
        out.extend(events.iter().map(event_line));
    }
    out.join("\n")
}

fn render_revisions(v: &Value) -> String {
    let mut out = vec![format!("{} revisions (oldest first):", s(v, "doc_id"))];
    out.extend(arr(v, "revisions").iter().map(|r| {
        format!(
            "  r{} · {} · {} via {} ({}) · {} B · {}",
            r.get("revision").and_then(Value::as_i64).unwrap_or(0),
            s(r, "ts"),
            match s(r, "agent") {
                "" => "Unknown",
                a => a,
            },
            s(r, "surface"),
            s(r, "author_email"),
            r.get("size").and_then(Value::as_i64).unwrap_or(0),
            s(r, "message")
        )
    }));
    out.join("\n")
}

fn render_diff(v: &Value) -> String {
    let n = |k: &str| v.get(k).and_then(Value::as_i64).unwrap_or(0);
    let diff = s(v, "diff");
    format!(
        "{} diff r{} -> r{}:\n{}",
        s(v, "doc_id"),
        n("from"),
        n("to"),
        if diff.is_empty() { "(no change)" } else { diff }
    )
}

/// The name a write reply gives the record the server returned: an item's id,
/// a document's id, `spec:<slug>`, `milestone:<slug>/<code>` or
/// `concept:<slug>`, and its kind for [`describe_changes`].
fn record_of(v: &Value) -> (String, TargetKind) {
    let has = |k: &str| v.get(k).is_some();
    if has("status") && has("type") {
        (s(v, "id").to_string(), TargetKind::Item)
    } else if has("revision") && has("path") && has("id") {
        (s(v, "id").to_string(), TargetKind::Document)
    } else if has("code") && has("spec") {
        (
            format!("milestone:{}/{}", s(v, "spec"), s(v, "code")),
            TargetKind::Milestone,
        )
    } else if has("milestones") {
        (format!("spec:{}", s(v, "slug")), TargetKind::Spec)
    } else {
        (format!("concept:{}", s(v, "slug")), TargetKind::Concept)
    }
}

/// `(ubu-d0007 specs/audio/master.md)`: where a record's document is.
fn doc_of(v: &Value) -> String {
    format!("({} {})", s(v, "doc_id"), s(v, "path"))
}

/// A write's answer as one line (rag-t0039): `ok`, the record, what changed
/// from → to, and the event id, e.g. `ok ubu-t0042 status: in_progress → done
/// (#13950)`. A create names what it made and where (`ok created ubu-t0042
/// [dev] "Title" after ubu-t0041 (#13951)`, a spec its document and its
/// milestones'); a note reads `note`. The record is one `tracker_get` away;
/// the reply used to be the whole record as JSON, some 2.5k characters.
fn write_line(v: &Value) -> String {
    if let Some(acked) = v.get("acknowledged").and_then(Value::as_array) {
        let ids: Vec<&str> = acked.iter().filter_map(Value::as_str).collect();
        return if ids.is_empty() {
            format!("ok {}: nothing to acknowledge", s(v, "project"))
        } else {
            format!(
                "ok {}: acknowledged {}: {}",
                s(v, "project"),
                plural(ids.len(), "done ticket", "done tickets"),
                ids.join(", ")
            )
        };
    }
    let (label, target_kind) = record_of(v);
    let event = arr(v, "events").last();
    let tag = event
        .and_then(|e| e.get("event_id"))
        .and_then(Value::as_i64)
        .map(|id| format!(" (#{id})"))
        .unwrap_or_default();
    let kind = event
        .map(|e| s(e, "kind"))
        .unwrap_or("")
        .parse::<EventKind>()
        .ok();
    let what = match (kind, target_kind) {
        (Some(EventKind::Create), TargetKind::Item) => {
            let place = match (v.get("prev_id"), v.get("next_id")) {
                (Some(Value::String(p)), _) => format!(" after {p}"),
                (Some(Value::Null), Some(Value::String(_))) => " at the top".to_string(),
                _ => String::new(),
            };
            let ty = if s(v, "type") == "gate" {
                gate_label(v)
            } else {
                s(v, "type").to_string()
            };
            return format!(
                "ok created {label} [{ty}] \"{}\"{place}{tag}",
                s(v, "title")
            );
        }
        (Some(EventKind::Create), TargetKind::Document) => {
            return format!(
                "ok created {label} {} r{}{tag}",
                s(v, "path"),
                v.get("revision").and_then(Value::as_i64).unwrap_or(0)
            );
        }
        (Some(EventKind::Create), TargetKind::Spec) => {
            let mut out = format!("ok created {label} {}", doc_of(v));
            let ms: Vec<String> = arr(v, "milestones")
                .iter()
                .map(|m| format!("milestone:{}/{} {}", s(m, "spec"), s(m, "code"), doc_of(m)))
                .collect();
            if !ms.is_empty() {
                out.push_str(&format!("; {}", ms.join(", ")));
            }
            return format!("{out}{tag}");
        }
        (Some(EventKind::Create), _) => {
            return format!("ok created {label} {}{tag}", doc_of(v));
        }
        (Some(EventKind::Note), _) => "note".to_string(),
        (Some(k), _) => {
            let e = event.expect("a kind comes from an event");
            let said = describe_changes(
                k,
                target_kind,
                e.get("fields").unwrap_or(&Value::Null),
                e.get("before").filter(|b| !b.is_null()),
            );
            if said.is_empty() {
                k.to_string()
            } else {
                said.join("; ")
            }
        }
        (None, _) => "written".to_string(),
    };
    format!("ok {label} {what}{tag}")
}

/// A record read's history cut to what was asked (rag-t0039): none (the
/// `events` key goes), all, or the last `n`, with `events_omitted` counting
/// the older ones left out.
fn trim_history(v: &mut Value, history: History) {
    let Some(obj) = v.as_object_mut() else {
        return;
    };
    match history {
        History::All => {}
        History::None => {
            obj.remove("events");
        }
        History::Last(n) => {
            if let Some(Value::Array(events)) = obj.get_mut("events") {
                let omitted = events.len().saturating_sub(n);
                if omitted > 0 {
                    events.drain(..omitted);
                    obj.insert("events_omitted".into(), json!(omitted));
                }
            }
        }
    }
}

/// A tool's input schema with what an agent need not read taken out
/// (rag-t0039): the `$schema` and `title` keywords, `null` in an optional
/// field's type (an absent field is the default), and the `format` and
/// `minimum: 0` schemars adds to an unsigned integer. Only keyword values are
/// touched (a `title` *property* is an object, not a string), so the schema
/// still describes exactly what the tool takes.
fn compact_schema(v: &mut Value) {
    match v {
        Value::Object(m) => {
            for k in ["$schema", "title", "format"] {
                if m.get(k).is_some_and(Value::is_string) {
                    m.remove(k);
                }
            }
            if m.get("minimum").and_then(Value::as_i64) == Some(0) {
                m.remove("minimum");
            }
            if let Some(Value::Array(types)) = m.get("type") {
                let kept: Vec<Value> = types
                    .iter()
                    .filter(|t| t.as_str() != Some("null"))
                    .cloned()
                    .collect();
                m.insert(
                    "type".into(),
                    match kept.as_slice() {
                        [one] => one.clone(),
                        _ => Value::Array(kept),
                    },
                );
            }
            // `Option<Struct>`: anyOf [the struct, null] is the struct.
            if let Some(Value::Array(any)) = m.get("anyOf") {
                let kept: Vec<Value> = any
                    .iter()
                    .filter(|t| t.get("type").and_then(Value::as_str) != Some("null"))
                    .cloned()
                    .collect();
                if let ([one], 2) = (kept.as_slice(), any.len()) {
                    let one = one.clone();
                    m.remove("anyOf");
                    if let Value::Object(inner) = one {
                        for (k, val) in inner {
                            m.entry(k).or_insert(val);
                        }
                    }
                }
            }
            for val in m.values_mut() {
                compact_schema(val);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(compact_schema),
        _ => {}
    }
}

fn approval_tag(v: &Value) -> String {
    format!("approval {}", s(v, "approval"))
}

fn render_list(what: &str, v: &Value) -> String {
    let rows: Vec<String> = match what {
        "projects" => arr(v, "projects")
            .iter()
            .map(|p| {
                let n = |k: &str| p.get(k).and_then(Value::as_i64).unwrap_or(0);
                format!(
                    "{} · {} · {} in review · {} in the queue · {} blocked · {} deferred · {} done not acknowledged",
                    s(p, "name"),
                    plural(n("requests") as usize, "request", "requests"),
                    n("review"),
                    n("queued")
                        - n("requests")
                        - n("drafts")
                        - n("blocked")
                        - n("deferred")
                        - n("review"),
                    n("blocked"),
                    n("deferred"),
                    n("done_unacknowledged")
                )
            })
            .collect(),
        "items" => arr(v, "items").iter().map(item_line).collect(),
        "labels" => arr(v, "labels")
            .iter()
            .map(|l| {
                let n = |k: &str| l.get(k).and_then(Value::as_i64).unwrap_or(0);
                format!(
                    "{} · {} · {} queued",
                    s(l, "label"),
                    plural(n("count") as usize, "ticket", "tickets"),
                    n("queued")
                )
            })
            .collect(),
        "specs" => arr(v, "specs")
            .iter()
            .flat_map(|sp| {
                let mut rows = vec![format!(
                    "spec:{} · {} · {} · {} · {} ({})",
                    s(sp, "slug"),
                    s(sp, "state"),
                    approval_tag(sp),
                    s(sp, "title"),
                    s(sp, "path"),
                    s(sp, "doc_id")
                )];
                rows.extend(arr(sp, "milestones").iter().map(|m| {
                    format!(
                        "  milestone:{}/{} · {} · {} · {} · {} ({})",
                        s(m, "spec"),
                        s(m, "code"),
                        s(m, "state"),
                        approval_tag(m),
                        s(m, "title"),
                        s(m, "path"),
                        s(m, "doc_id")
                    )
                }));
                rows
            })
            .collect(),
        "concepts" => arr(v, "concepts")
            .iter()
            .map(|c| {
                format!(
                    "concept:{} · {} · {} · {} · {} ({})",
                    s(c, "slug"),
                    s(c, "state"),
                    approval_tag(c),
                    s(c, "title"),
                    s(c, "path"),
                    s(c, "doc_id")
                )
            })
            .collect(),
        "docs" => arr(v, "documents")
            .iter()
            .map(|d| {
                format!(
                    "{} · {} · {} · r{} · {}",
                    s(d, "id"),
                    s(d, "path"),
                    s(d, "kind"),
                    d.get("revision").and_then(Value::as_i64).unwrap_or(0),
                    s(d, "title")
                )
            })
            .collect(),
        "attachments" => arr(v, "attachments")
            .iter()
            .map(|a| {
                format!(
                    "{} · {} · {} · {} B · {}",
                    s(a, "ref"),
                    s(a, "name"),
                    s(a, "media_type"),
                    a.get("size").and_then(Value::as_i64).unwrap_or(0),
                    s(a, "uploaded_at")
                )
            })
            .collect(),
        _ => Vec::new(),
    };
    if rows.is_empty() {
        format!("No {what}.")
    } else {
        rows.join("\n")
    }
}

// ---- The server ---------------------------------------------------------------

#[derive(Clone)]
pub struct TrackerServer {
    http: reqwest::Client,
    base: String,
    transport: Transport,
    tool_router: ToolRouter<TrackerServer>,
}

impl TrackerServer {
    async fn send(&self, req: &Req) -> Result<reqwest::Response, McpError> {
        let url = format!("{}{}", self.base, req.path);
        let rb = match req.method {
            Method::Get => self.http.get(&url),
            Method::Post => {
                let rb = self.http.post(&url);
                match &req.body {
                    Some(b) => rb.json(b),
                    None => rb,
                }
            }
        };
        rb.send()
            .await
            .map_err(|e| McpError::internal_error(format!("cannot reach rag-serve: {e}"), None))
    }

    /// Send a request and parse its JSON answer; a refusal is a tool error.
    async fn call(&self, req: Req) -> Result<Value, McpError> {
        let resp = self.send(&req).await?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(refusal(status.as_u16(), &body));
        }
        serde_json::from_str(&body).map_err(|e| {
            McpError::internal_error(format!("rag-serve answered with invalid JSON: {e}"), None)
        })
    }

    /// `tracker_create` and `tracker_create_record`: read any `body_path`, then
    /// send the create.
    async fn create(&self, mut args: TrackerCreateArgs) -> Result<CallToolResult, McpError> {
        inline_body(self.transport, &mut args.body, &mut args.body_path).await?;
        for m in args.milestones.iter_mut().flatten() {
            inline_body(self.transport, &mut m.body, &mut m.body_path).await?;
        }
        let project = resolve_project(args.project.clone());
        let who = Author::resolve(args.agent.clone());
        let req = create_req(&args, project.as_deref(), &who).map_err(bad)?;
        let v = self.call(req).await?;
        Ok(text(write_line(&v)))
    }

    /// `tracker_update` and `tracker_update_record`.
    async fn update(&self, args: TrackerUpdateArgs) -> Result<CallToolResult, McpError> {
        let project = resolve_project(args.project.clone());
        let who = Author::resolve(args.agent.clone());
        let req = update_req(&args, project.as_deref(), &who).map_err(bad)?;
        let v = self.call(req).await?;
        Ok(text(write_line(&v)))
    }

    /// The id of the document a reference names (a record's reference reads the
    /// record for its `doc_id`; a path reads the document for its id).
    async fn doc_id(&self, target: &Target, project: Option<&str>) -> Result<String, McpError> {
        let id_of = |v: &Value, k: &str| -> Result<String, McpError> {
            v.get(k)
                .and_then(Value::as_str)
                .map(String::from)
                .ok_or_else(|| McpError::internal_error("rag-serve answered without an id", None))
        };
        match target {
            Target::Doc(id) => Ok(id.clone()),
            Target::Path(_) => {
                let v = self
                    .call(doc_get_req(target, project, None, false).map_err(bad)?)
                    .await?;
                id_of(&v, "id")
            }
            Target::Item(_) => Err(bad("a ticket is not a document: read it with tracker_get")),
            _ => {
                let v = self
                    .call(record_get_req(target, project, false).map_err(bad)?)
                    .await?;
                id_of(&v, "doc_id")
            }
        }
    }
}

#[tool_router]
impl TrackerServer {
    pub fn new(http: reqwest::Client, base_url: &str, transport: Transport) -> Self {
        let mut tool_router = Self::tool_router();
        for route in tool_router.map.values_mut() {
            let mut schema = Value::Object((*route.attr.input_schema).clone());
            compact_schema(&mut schema);
            if let Value::Object(m) = schema {
                route.attr.input_schema = std::sync::Arc::new(m);
            }
        }
        Self {
            http,
            base: base_url.trim_end_matches('/').to_string(),
            transport,
            tool_router,
        }
    }

    #[tool(
        description = "A project's dashboard as text: requests, review, the queue (gates as markers), blocked, deferred, then a Not shown: count. For status reports; to dispatch, tracker_next."
    )]
    async fn tracker_queue(
        &self,
        Parameters(args): Parameters<TrackerQueueArgs>,
    ) -> Result<CallToolResult, McpError> {
        let opts = queue_opts(&args).map_err(bad)?;
        let project = resolve_project(args.project);
        let v = self
            .call(queue_req(project.as_deref()).map_err(bad)?)
            .await?;
        Ok(text(render_queue(&v, &opts)))
    }

    #[tool(
        description = "The next n dispatchable tickets in full: pending, unblocked, in queue order, stopping at the first gate not in progress (itself returned when nothing is above it); then parallel tickets below it, which may start now and land after that gate. Read it after each job."
    )]
    async fn tracker_next(
        &self,
        Parameters(args): Parameters<TrackerNextArgs>,
    ) -> Result<CallToolResult, McpError> {
        let (n, ty) = next_opts(&args).map_err(bad)?;
        let project = resolve_project(args.project);
        let v = self
            .call(queue_req(project.as_deref()).map_err(bad)?)
            .await?;
        Ok(text(render_next(&v, n, ty.as_deref())))
    }

    #[tool(
        description = "One line per record: projects, items, labels, specs (with milestones), concepts, docs or attachments."
    )]
    async fn tracker_list(
        &self,
        Parameters(args): Parameters<TrackerListArgs>,
    ) -> Result<CallToolResult, McpError> {
        let project = resolve_project(args.project.clone());
        let what = args.what.trim().to_ascii_lowercase();
        let v = self
            .call(list_req(&args, project.as_deref()).map_err(bad)?)
            .await?;
        Ok(text(render_list(&what, &v)))
    }

    #[tool(
        description = "One record as JSON (a document as text with the revision to edit against), without its history unless asked."
    )]
    async fn tracker_get(
        &self,
        Parameters(args): Parameters<TrackerGetArgs>,
    ) -> Result<CallToolResult, McpError> {
        let target = parse_target(&args.id).map_err(bad)?;
        let history = history_of(args.history.as_ref()).map_err(bad)?;
        let project = resolve_project(args.project);
        let req =
            record_get_req(&target, project.as_deref(), history != History::None).map_err(bad)?;
        let mut v = self.call(req).await?;
        trim_history(&mut v, history);
        Ok(text(match target {
            Target::Doc(_) | Target::Path(_) => render_doc(&v),
            _ => v.to_string(),
        }))
    }

    #[tool(
        description = "Create a ticket, or a gate (type gate, with intensity). It joins the bottom unless placed. Manager only."
    )]
    async fn tracker_create(
        &self,
        Parameters(args): Parameters<CreateItemArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.create(args.try_into().map_err(bad)?).await
    }

    #[tool(
        description = "Create a spec (its master document, optional milestones), a milestone on a spec, a concept, or a free document (kind doc, at path)."
    )]
    async fn tracker_create_record(
        &self,
        Parameters(args): Parameters<CreateRecordArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.create(args.try_into().map_err(bad)?).await
    }

    #[tool(
        description = "Change a ticket, or note on it: a note alone is how a sub-agent reports on its task; any other change is the manager's. A refused status move names the allowed ones."
    )]
    async fn tracker_update(
        &self,
        Parameters(args): Parameters<UpdateItemArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.update(args.try_into().map_err(bad)?).await
    }

    #[tool(
        description = "Change a spec, milestone or concept: title, state, approval, links (concept), order (milestone); or note on it."
    )]
    async fn tracker_update_record(
        &self,
        Parameters(args): Parameters<UpdateRecordArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.update(args.try_into().map_err(bad)?).await
    }

    #[tool(
        description = "Move a queued ticket just before or after another, or to the top or bottom (exactly one). Manager only."
    )]
    async fn tracker_move(
        &self,
        Parameters(args): Parameters<TrackerMoveArgs>,
    ) -> Result<CallToolResult, McpError> {
        let who = Author::resolve(args.agent.clone());
        let v = self.call(move_req(&args, &who).map_err(bad)?).await?;
        Ok(text(write_line(&v)))
    }

    #[tool(
        description = "Read a document by id, path or its record, with the revision to edit against; or view its revisions or a diff."
    )]
    async fn tracker_doc_get(
        &self,
        Parameters(args): Parameters<TrackerDocGetArgs>,
    ) -> Result<CallToolResult, McpError> {
        let target = parse_target(&args.doc).map_err(bad)?;
        let project = resolve_project(args.project.clone());
        let view = args
            .view
            .as_deref()
            .unwrap_or("body")
            .trim()
            .to_ascii_lowercase();
        let history = args.history.unwrap_or(false);
        match view.as_str() {
            "body" => {
                if args.from.is_some() || args.to.is_some() {
                    return Err(bad("from and to apply to view=diff"));
                }
                let req = match &target {
                    Target::Doc(_) | Target::Path(_) => {
                        doc_get_req(&target, project.as_deref(), args.revision, history)
                    }
                    _ => {
                        let id = self.doc_id(&target, project.as_deref()).await?;
                        doc_get_req(&Target::Doc(id), None, args.revision, history)
                    }
                }
                .map_err(bad)?;
                Ok(text(render_doc(&self.call(req).await?)))
            }
            "revisions" | "diff" => {
                if args.revision.is_some() || args.history.is_some() {
                    return Err(bad("revision and history apply to view=body"));
                }
                let id = self.doc_id(&target, project.as_deref()).await?;
                if view == "revisions" {
                    if args.from.is_some() || args.to.is_some() {
                        return Err(bad("from and to apply to view=diff"));
                    }
                    Ok(text(render_revisions(
                        &self.call(revisions_req(&id)).await?,
                    )))
                } else {
                    Ok(text(render_diff(
                        &self.call(diff_req(&id, args.from, args.to)).await?,
                    )))
                }
            }
            other => Err(bad(format!(
                "view `{other}` is not one of body, revisions, diff"
            ))),
        }
    }

    #[tool(
        description = "Edit a document against base_revision: replacements, a whole body, restore_revision, or a rename (new_path, new_title); exactly one. A stale base is refused: re-read and edit again."
    )]
    async fn tracker_doc_edit(
        &self,
        Parameters(mut args): Parameters<TrackerDocEditArgs>,
    ) -> Result<CallToolResult, McpError> {
        inline_body(self.transport, &mut args.body, &mut args.body_path).await?;
        let target = parse_target(&args.doc).map_err(bad)?;
        let project = resolve_project(args.project.clone());
        let who = Author::resolve(args.agent.clone());
        // Check the arguments before any request, so a bad call costs nothing.
        doc_edit_req("check", &args, &who).map_err(bad)?;
        let id = self.doc_id(&target, project.as_deref()).await?;
        let v = self
            .call(doc_edit_req(&id, &args, &who).map_err(bad)?)
            .await?;
        let rev = v.get("revision").and_then(Value::as_i64).unwrap_or(0);
        let tag = arr(&v, "events")
            .last()
            .and_then(|e| e.get("event_id"))
            .and_then(Value::as_i64)
            .map(|id| format!(" (#{id})"))
            .unwrap_or_default();
        Ok(text(format!(
            "ok {} {} r{rev}: edit next with base_revision {rev}{tag}",
            s(&v, "id"),
            s(&v, "path"),
        )))
    }

    #[tool(
        description = "Upload a file and get att:<hash>, to embed in a document as ![name](att:<hash>)."
    )]
    async fn tracker_attach(
        &self,
        Parameters(args): Parameters<TrackerAttachArgs>,
    ) -> Result<CallToolResult, McpError> {
        let project = resolve_project(args.project.clone());
        let project = need_project(project.as_deref()).map_err(bad)?.to_string();
        let who = Author::resolve(args.agent.clone());
        let (bytes, name) = match (&args.path, &args.base64) {
            (Some(_), Some(_)) => return Err(bad("give path or base64, not both")),
            (None, None) => return Err(bad("give path (a local file) or base64")),
            (Some(path), None) => {
                if self.transport == Transport::Gateway {
                    return Err(bad(
                        "the HTTP gateway cannot read your files: send the file as base64 \
                         with a name (at most 10 MB)",
                    ));
                }
                let meta = tokio::fs::metadata(path)
                    .await
                    .map_err(|e| bad(format!("cannot read {path}: {e}")))?;
                if meta.len() > UPLOAD_MAX_BYTES {
                    return Err(bad(format!(
                        "{path} is {} bytes; attachments are at most 50 MB",
                        meta.len()
                    )));
                }
                let bytes = tokio::fs::read(path)
                    .await
                    .map_err(|e| bad(format!("cannot read {path}: {e}")))?;
                let name = args.name.clone().unwrap_or_else(|| {
                    std::path::Path::new(path)
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "attachment".to_string())
                });
                (bytes, name)
            }
            (None, Some(b64)) => {
                let cap = match self.transport {
                    Transport::Gateway => GATEWAY_MAX_BYTES,
                    Transport::Stdio => UPLOAD_MAX_BYTES as usize,
                };
                let clean: String = b64.chars().filter(|c| !c.is_whitespace()).collect();
                if clean.len() / 4 * 3 > cap + 3 {
                    return Err(bad(format!(
                        "the file is over {} MB, the most this server takes",
                        cap / (1024 * 1024)
                    )));
                }
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(clean.as_bytes())
                    .map_err(|e| bad(format!("base64 does not decode: {e}")))?;
                if bytes.len() > cap {
                    return Err(bad(format!(
                        "the file is over {} MB, the most this server takes",
                        cap / (1024 * 1024)
                    )));
                }
                let name = args
                    .name
                    .clone()
                    .ok_or_else(|| bad("name is required with base64 (e.g. \"terrain.png\")"))?;
                (bytes, name)
            }
        };
        let media = args
            .media_type
            .clone()
            .or_else(|| guess_media(&name).map(String::from));
        let mut fields = vec![("author_email", who.email.as_str()), ("surface", "mcp")];
        if let Some(a) = &who.agent {
            fields.push(("agent", a.as_str()));
        }
        fields.push(("name", name.as_str()));
        let boundary = boundary_for(&bytes);
        let body = multipart_body(&boundary, &fields, &name, media.as_deref(), &bytes);
        let url = format!("{}/tracker/{}/attachments", self.base, enc(&project));
        let resp = self
            .http
            .post(&url)
            .header(
                reqwest::header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(body)
            .send()
            .await
            .map_err(|e| McpError::internal_error(format!("cannot reach rag-serve: {e}"), None))?;
        let status = resp.status();
        let answer = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(refusal(status.as_u16(), &answer));
        }
        let v: Value = serde_json::from_str(&answer).map_err(|e| {
            McpError::internal_error(format!("rag-serve answered with invalid JSON: {e}"), None)
        })?;
        Ok(text(format!(
            "ok {} {} {} {} B: embed as ![{}]({})",
            s(&v, "ref"),
            s(&v, "name"),
            s(&v, "media_type"),
            v.get("size").and_then(Value::as_i64).unwrap_or(0),
            s(&v, "name"),
            s(&v, "ref")
        )))
    }

    #[tool(
        description = "Fetch an attachment: over stdio it is written to a local file to Read; over the gateway it comes back inline."
    )]
    async fn tracker_attachment_get(
        &self,
        Parameters(args): Parameters<TrackerAttachmentGetArgs>,
    ) -> Result<CallToolResult, McpError> {
        let hash = attachment_hash(&args.reference).map_err(bad)?;
        if self.transport == Transport::Gateway && args.out_path.is_some() {
            return Err(bad(
                "the HTTP gateway cannot write to your disk: omit out_path",
            ));
        }
        let resp = self.send(&attachment_get_req(&hash).map_err(bad)?).await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(refusal(status.as_u16(), &body));
        }
        let header = |k: reqwest::header::HeaderName| {
            resp.headers()
                .get(k)
                .and_then(|h| h.to_str().ok())
                .map(String::from)
        };
        let media = header(reqwest::header::CONTENT_TYPE)
            .unwrap_or_else(|| "application/octet-stream".to_string());
        let name = header(reqwest::header::CONTENT_DISPOSITION)
            .as_deref()
            .and_then(disposition_name);
        let sha = header(reqwest::header::ETAG)
            .map(|e| e.trim_matches('"').to_string())
            .filter(|e| !e.is_empty())
            .unwrap_or(hash);
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| McpError::internal_error(format!("reading the attachment: {e}"), None))?;
        let about = format!(
            "att:{} · {} · {media} · {} bytes",
            sha.chars().take(12).collect::<String>(),
            name.as_deref().unwrap_or("attachment"),
            bytes.len()
        );
        match self.transport {
            Transport::Stdio => {
                let out = args
                    .out_path
                    .map(PathBuf::from)
                    .unwrap_or_else(|| default_out_path(&sha, name.as_deref()));
                if let Some(dir) = out.parent().filter(|d| !d.as_os_str().is_empty()) {
                    tokio::fs::create_dir_all(dir)
                        .await
                        .map_err(|e| bad(format!("cannot create {}: {e}", dir.display())))?;
                }
                tokio::fs::write(&out, &bytes)
                    .await
                    .map_err(|e| bad(format!("cannot write {}: {e}", out.display())))?;
                Ok(text(format!("{about}\nWritten to {}", out.display())))
            }
            Transport::Gateway => {
                if bytes.len() > GATEWAY_MAX_BYTES {
                    return Err(bad(format!(
                        "{about}: over 10 MB, the most the HTTP gateway returns; use the local \
                         (stdio) server, or GET /tracker/attachments/<hash> on rag-serve"
                    )));
                }
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                if is_raster(&media) {
                    Ok(CallToolResult::success(vec![
                        Content::text(about),
                        Content::image(b64, media),
                    ]))
                } else {
                    Ok(text(format!("{about}\nbase64:\n{b64}")))
                }
            }
        }
    }

    #[tool(description = "Acknowledge every done ticket of a project, when the owner asks.")]
    async fn tracker_ack_done(
        &self,
        Parameters(args): Parameters<TrackerAckDoneArgs>,
    ) -> Result<CallToolResult, McpError> {
        let project = resolve_project(args.project);
        let who = Author::resolve(args.agent);
        let v = self
            .call(ack_req(project.as_deref(), &who).map_err(bad)?)
            .await?;
        Ok(text(write_line(&v)))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for TrackerServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions(INSTRUCTIONS)
    }
}

#[cfg(test)]
mod tests;
