# RAG

A self-hosted **Retrieval-Augmented Generation** backend for coding agents. It
indexes your code repositories and a Markdown document library into a vector store
and serves semantic search (with reranking) over HTTP, an MCP server, and a Claude
Skill. It also includes a typed, append-only **ledger** for recording
decisions/incidents/defects so an agent's prior reasoning isn't lost.

Built for single-developer use: one box runs the vector DB, the indexer, and the
retrieval service; agents query it from anywhere on the network.

## What it does

- **Indexes** your repos (GitHub shallow-clone, or a local filesystem source) and a
  wiki repo, chunking code with tree-sitter and Markdown/text with size-based
  splitters.
- **Embeds + stores** chunks in [Qdrant](https://qdrant.tech) using
  [Voyage AI](https://voyageai.com) embeddings, incrementally (only changed files
  are re-embedded; removed/archived repos are purged). Spend is bounded: batches
  are sized by a hard per-request token bound, each file is persisted as soon as it
  is embedded (a failed run keeps its progress), token-dense generated data is
  skipped, and a circuit breaker stops re-attempting work that keeps failing — see
  *Controlling what is indexed* below.
- **Retrieves** via embed → ANN search → Voyage rerank → ranked, **citable** results
  (`repo` + `rel_path` + line range).
- **Exposes** retrieval three ways: an HTTP API, an MCP server (`search_corpus`),
  and a Claude Skill — all sharing one pipeline.
- **Records** decisions/incidents in a SQLite-backed ledger, indexed alongside the
  corpus (`corpus = ledger`) and reachable via MCP tools.
- **Tracks** each project's work queue, specs and concepts in a second SQLite-backed
  store, also indexed alongside the corpus (`corpus = tracker`).
- **Serves** a small web UI for that ledger — search, read and amend topics on the
  same terms an agent gets — and for the tracker's queue (`/projects/<project>`) and its
  specs and concepts (`/projects/<project>/docs`), from the same origin as the API.

## Controlling what is indexed

Discovery honours `.gitignore`, skips build/vendor directories, lockfiles, minified,
binary and over-size files, plus:

- **`.ragignore`** — gitignore syntax, at a repo's root or in any directory. It
  excludes paths from the index **without** excluding them from git: generated
  data, recorded fixtures, anything committed but not worth retrieving. A path
  that becomes ignored is removed from the index on the next sync.
- **The density guard** — a file of at least `ingest.density_min_bytes` (4 KiB)
  whose *estimated* characters per token fall below `ingest.min_chars_per_token`
  (1.7) is skipped and logged. Generated SVG path data estimates at 1.3–1.6 and
  hand-written source and prose at 1.8 and above; such data costs about three
  times as much per byte to embed and is useless to search. `0` disables it.

Embedding is guarded so that one bad input cannot become an open-ended bill:

- **Batches** hold at most 128 inputs and 80 % of Voyage's 120k per-request token
  ceiling, counted as one token per UTF-8 byte — a bound no content can exceed,
  unlike a characters-per-token guess. A `TOO_MANY_TOKENS_IN_BATCH` refusal that
  still happens is split in half and retried, a bounded number of times.
- **Incremental persistence** — each file (or ledger topic) is written the moment
  its last vector arrives, and its old points are deleted only after its new ones
  are written. A failed run keeps everything it finished and never leaves a file
  with fewer points than it had.
- **Circuit breaker** — the pending work is fingerprinted; after
  `ingest.breaker_threshold` (3) consecutive runs fail on the same work with the
  same error, the indexer refuses to attempt it (exit non-zero, logged as
  `CIRCUIT BREAKER OPEN`) until the pending files or the config change.
  `rag-ingest run --force` overrides it once. State lives in
  `<github.work_dir>/.rag-ingest-breaker.json` (ledger: beside `ledger.db`).

## Architecture

A single Cargo workspace, plus an npm workspace for the UI:

```
crates/
├── core/    # shared: data model, figment config, Qdrant + Voyage clients, retrieval pipeline, ledger + tracker stores
├── ingest/  # corpus walk → chunk → embed → upsert  (binary: rag-ingest)
├── serve/   # axum HTTP retrieval + ledger CRUD + tracker API + web UI  (binary: rag-serve)
└── mcp/      # stdio MCP server(s)                      (binary: rag-mcp)

web/
├── ui/      # @rag/ui  — design system: one theme, components, icon registry
└── app/     # @rag/app — the ledger viewer (React + Vite); its dist/ is what rag-serve serves
```

- **Vector DB:** Qdrant (self-hosted, rootless Podman), 1024-dim cosine, int8 quantization.
- **Embeddings:** Voyage `voyage-4-large` (`input_type=document` at ingest, `query` at search).
- **Reranking:** Voyage `rerank-2.5`.
- **Chunking:** Rust `text-splitter` + tree-sitter grammars, character-sized (calibrated to a token target).
- **Ledger:** SQLite (`sqlx`, WAL) as source of truth, reconciled into Qdrant (`rag-ingest reconcile-ledger`).
- **Tracker:** a second SQLite file (`tracker.db`) plus a content-addressed attachments directory, served under `/tracker/…` by `rag-serve`, reconciled into Qdrant (`rag-ingest reconcile-tracker`).

`rag-serve` holds the Voyage API key server-side; `rag-mcp` and the Skill are thin
clients of it, so the key never reaches an agent's machine.

## Requirements

- Rust 1.94+ (see `rust-toolchain.toml`).
- Node 22+ / npm 10+ — to build the ledger web UI. The container build runs it in its
  own Node stage, so the deployment box needs nothing beyond Podman; you need Node
  locally only for `npm run dev`, the frontend tests, or a hand-built bundle.
- A running Qdrant instance (a Quadlet unit is provided under `deploy/`).
- A [Voyage AI](https://voyageai.com) API key.
- For the GitHub source: a fine-grained `GITHUB_TOKEN` with read access to the repos you want indexed.
- **Optional:** an `ANTHROPIC_API_KEY`. It enables one route — `POST /ledger/{id}/summarise`,
  behind the web UI's *Summarise* tab — and nothing else depends on it. Without it that route
  answers 503 (`/info` reports `summarise_ready: false`) and the rest of the system is
  unchanged; a deployment that never wants an LLM in it needs no key and no configuration.
- **Optional:** a **prompts directory** (`server.prompts_dir` / `RAG_SERVER__PROMPTS_DIR`) for
  the Summarise tab's library of system prompts. See *Saved Summarise prompts* below. Unset =
  only the built-in prompt is offered, which is a valid configuration, not a degraded one.

## Configuration

Two layers, both with committed examples and gitignored real files:

| File | Purpose |
|---|---|
| `rag.toml` (from `rag.toml.example`) | Non-secret config: Qdrant URL, corpus roots, GitHub account, chunk sizes, server bind, web UI root, saved-prompts dir, tracker DB and attachments dir. Env overrides via `RAG_*` (e.g. `RAG_QDRANT__URL`). |
| `.env` | Secrets only: `VOYAGE_API_KEY`, `GITHUB_TOKEN`, optional `QDRANT_API_KEY`, optional `ANTHROPIC_API_KEY`. Never committed. |
| `deploy/deploy.env` (from `deploy/deploy.env.example`) | Deploy target: `DEPLOY_HOST` (SSH host of the server). |
| `.mcp.json` (from `.mcp.json.example`) | Registers the MCP servers with Claude Code. |

**Secrets are read from the environment only** — never put an API key in `rag.toml`.

## Build & test

```bash
make all          # fmt-check + clippy (-D warnings) + tests
make build        # cargo build --workspace

cd web && npm install
npm run typecheck # tsc --noEmit across both packages
npm test          # vitest
npm run build     # app/dist — the bundle rag-serve serves
```

## Run

```bash
# 1. Bootstrap the Qdrant collection (idempotent)
cargo run -p rag-ingest -- init

# 2. Index a corpus
cargo run -p rag-ingest -- run --source github      # clone + index a GitHub account's repos
cargo run -p rag-ingest -- run --source local --full # or index a local filesystem corpus

# 3. Query from the CLI
cargo run -p rag-ingest -- query "where is retry/backoff implemented"

# 4. Serve retrieval over HTTP (POST /search, /reindex; GET /health, /info)
cargo run -p rag-serve

# 5. Index the ledger and the tracker (each an incremental diff of its SQLite store)
cargo run -p rag-ingest -- reconcile-ledger
cargo run -p rag-ingest -- reconcile-tracker
```

`GET /info` describes the server: the collection and its `points`, the model ids, the
non-secret config and the readiness flags (`retrieval_ready`, `summarise_ready`,
`tracker_ready`). It always answers 200. When Qdrant cannot be reached, `points` is
`null` and `qdrant_error` says why (and `rag-serve` logs a warning), so the flags stay
readable during a Qdrant outage — the ledger and the tracker work without Qdrant.
`points` is also `null`, with no error, when the server has no retriever (`--check`
without a Voyage key); it is never a guessed `0`.

### The ledger web UI

`rag-serve` also serves the **ledger web UI** at `/` when `server.web_root`
(`RAG_SERVER__WEB_ROOT`) points at a built bundle — same port, same origin, so no
CORS. Left empty (the default) it serves the JSON API alone; the container
deployment sets it, and an image built without the bundle just logs a warning.

Two ways to run it, and they are not alternatives — one is the dev loop, the other is
how it ships:

```bash
# Dev: Vite on :5173, hot reload, API calls proxied to a real rag-serve — so no
# local Qdrant and no Voyage key are needed. See web/README.md.
cd web && npm install
RAG_SERVE=http://your-server:17793 npm run dev

# Production: no Vite, no dev server. The Node stage in `Containerfile` builds
# web/app/dist and bakes it into the image at /usr/local/share/rag/web, which is
# where the Quadlet unit points RAG_SERVER__WEB_ROOT. rag-serve reads it off disk.
./deploy/deploy.sh          # remote server
./deploy/deploy-local.sh    # or, when this box is the server
```

To serve a bundle from a plain `cargo run -p rag-serve` — no container — build it and
point the config at it: `cd web && npm run build`, then
`RAG_SERVER__WEB_ROOT=$PWD/app/dist cargo run -p rag-serve`.

Because the bundle is part of the image, **a UI change ships by redeploy, not by
restart**.

### Saved Summarise prompts

The Summarise tab sends a system prompt with every run, and it is editable — *summarise
this* and *list only what changed* are different questions of the same entry. Those
instructions can be kept as a small library:

- **A prompt is a plain Markdown file** in `server.prompts_dir`
  (`RAG_SERVER__PROMPTS_DIR`; `~/rag/prompts` → `/prompts` in the container deployment).
  `~/rag/prompts/Terse.md` *is* the prompt named "Terse". There is no database and no
  metadata, so an operator can add, edit or delete one with a text editor and the UI
  shows the result on its next read.
- **The built-in default prompt is not a file and never becomes one.** It is a constant
  in `core::anthropic`, served to the UI by `/info`, always offered and never deletable.
  An empty or missing directory simply means the library is empty — it is a fallback,
  not a missing file to be seeded.
- Unset (the default) = no library: only the built-in is offered and the two write
  routes answer 503. Nothing fails to start.
- `~/rag/prompts`, deliberately **not** `~/.config/rag/prompts` — that directory holds
  the secrets env file, and bind-mounting it into the container would put the secrets on
  the container filesystem for no gain.

| Route | |
|---|---|
| `GET /prompts` | `{ "configured": bool, "prompts": [ { "name", "body" } ] }` — bodies included, so the chooser needs one round trip |
| `POST /prompts/save` | `{ "name", "body" }` → the saved prompt. An upsert. |
| `POST /prompts/delete` | `{ "name" }` → `{ "name", "deleted": true }` |

**These are the only routes in the service that write a file, and it has no
authentication.** A name is checked against an allow-list — letters, digits, spaces, `-`
and `_`, at most 64 characters — so it cannot be a path; the resolved path is re-checked
to be inside the directory; only `.md` is ever written; symlinks are never followed; the
body is capped at 32 KiB and the library at 200 prompts. See
`crates/serve/src/prompts.rs`.

The bundle is served with cache headers that make a redeploy actually take
effect (content-hashed assets immutable, `index.html` revalidating on an `ETag`)
and with `X-Content-Type-Options: nosniff` on every response plus a
`Content-Security-Policy` on the document. The policy is the one barrier in
front of client-written ledger prose that the browser enforces rather than the
rendering code — see `crates/serve/src/web.rs`, which reasons through each
directive, including why inline **styles** must be allowed and inline **script**
must not.

### Agent surfaces

- **MCP** — two transports, both thin HTTP clients of `rag-serve` (`RAG_SERVE_URL`; no key
  on the client). See `.mcp.json.example`.
  - *stdio* (per-client subprocess): `cargo build --release -p rag-mcp`, then register three
    servers from the one binary — `--server corpus` (`search_corpus`, `reindex_corpus`),
    `--server ledger` (`ledger_search`/`get`/`create`/`append`/`move`/`archive`) and
    `--server tracker` (the `tracker_*` tools, see *Tracker*). Captures the client's git
    identity automatically.
  - *Streamable HTTP* (`--transport http`): one long-lived **shared server** exposing every
    tool set under `/corpus`, `/ledger` and `/tracker`, so remote clients register URLs and
    need no local binary (`claude mcp add --transport http rag http://host:17794/corpus`). Run
    it on the server via `rag-mcp.container` (see `deploy/`).
- **Skill** *(optional)* — copy `skill/corpus-search/` into `~/.claude/skills/`; it `POST`s to
  `rag-serve`. See `skill/README.md`. Only needed if you'd rather not use the MCP server — don't
  install both (they overlap and waste context). Prefer the MCP alone unless you specifically want
  the Skill.

### Agent instructions (CLAUDE.md)

Registering the tools isn't enough — the agent also needs to be *told* to reach for the corpus
before grepping, and to record decisions in the ledger. Add that guidance to your user-level
`~/.claude/CLAUDE.md`. [`user-claude.md`](user-claude.md) is a ready-to-adapt example of exactly
that (corpus-first rule + ledger write/read reflexes). For a from-scratch setup walkthrough, see
[`CLAUDE.md`](CLAUDE.md).

## Ledger

A cross-project, append-only record of decisions, incidents, defects, and
investigations — so prior reasoning and "don't repeat this" lessons survive. SQLite
is the source of truth; topics have an immutable summary, a mutable current state,
an amendable title and tag set, and an append-only event log. **Every mutable field
changes only by appending an event, and the event records the value it installed**,
so the log always explains the change and nothing is ever silently rewritten. The
summary is the exception with no setter at all: it is the original framing, and a
topic that was framed wrongly is worth more than one tidied to match its outcome.
It's derived into Qdrant as `corpus = ledger` by a pull-based reconciler, so a normal
`search_corpus` surfaces it alongside code. Written only through the typed
`ledger_create` / `ledger_append` MCP tools; read via `ledger_search` / `ledger_get`.
Housekeeping: `ledger_move` refiles a topic under another project (minting a new id;
the reconciler purges the old points and indexes the new), and `ledger_archive`
soft-deletes a topic — retained in SQLite but excluded from `all_for_index` so the
reconciler drops it from the index entirely, hidden from `ledger_search` unless
`archived = true` (a substring search over the soft-deleted set), and restorable.

**Topic ids are `<repo>-l<seq:04>`**: `ubu-l1652`, *l* for ledger, which sets a topic
apart from the tracker's `ubu-t0042` tickets and `ubu-d0007` documents. Topics minted
before rag-t0051 keep their unmarked ids (`ubu-1651`, `shq-suite-0001`) for ever: none
is migrated, and every reader (the routes, the MCP tools, the web UI's id boxes, the
tracker's `ledger` links and their titles, search citations) takes both. The sequence
is one per repo across both forms, so `ubu-1651` is followed by `ubu-l1652`, and a
moved-away number is never reissued (the store reads the number back out of tombstones
written before it recorded one). An id splits at its **final** hyphen, since a repo
name may hold hyphens of its own; the one parser is `core::ledger::parse_topic_id`
(`web/app/src/ledger/ids.ts` in the UI).

## Tracker

An agent-first task tracker beside the ledger (`specs/tracker/master.md`; ledger
rag-0033, rag-0034): per project, the **development queue** (tickets of type `dev`,
`design`, `recon`, `analysis` and `gate`), the **specs** with their milestones, and the
**concept documents**, all with their history. It is the source of truth for all three:
specs and concepts move out of the project's repository into it, keeping their paths
(`specs/<spec>/master.md`, `specs/<spec>/m03-music.md`, `concepts/<slug>.md`).

- **Store:** `core::tracker`, its own SQLite file (`[tracker] db_path`, default
  `~/rag/tracker/tracker.db`) and an attachments directory (`[tracker] attachments_dir`)
  storing each file once by sha256. Typed enums at the boundary; every change appends an
  event (who, which agent, `web` or `mcp`). A note is optional on every change (without one
  the history records the change itself, `Status: pending → done.`); only *Add note* needs
  text.
- **The queue is a doubly linked list**, reordered by `before` / `after` / `top` /
  `bottom` moves, never by position numbers. Done and cancelled tickets leave it; a reopen
  goes back in at the top; a blocked or deferred ticket keeps its place (`deferred`, work put
  aside on purpose, is a status apart from the blocked flag and has its own section; a
  resume puts it back where it was; rag-t0017), and so does a `review` ticket (work waiting on
  the owner to confirm or review it, shown red above the queue; confirmed it is done, sent
  back it is in progress where it was; rag-t0024, which retired the block reason `approval`).
  A **request** (`type: request`, rag-t0044) is the owner's idea, filed with *Add request*:
  queued but listed apart, never dispatched; the manager breaks it into tickets linked
  `from:<request id>` (the server writes `became` on the request, and the tickets default to
  `agent` approval), then marks it done.
  A ticket blocked with reason `dependency`
  names what it waits on (`depends_on`, tickets of its project) and unblocks itself when the
  last of them is done (rag-t0018); a `parallel` ticket may start before the gates above it
  and still lands after them (rag-t0013). `GET /tracker/{project}/check` proves the list
  sound.
- **Labels** (rag-t0027): free-text subject tags on a ticket (`Physics`, `Biomes`), at most
  10, matched case-insensitively within a project whose existing casing wins, set wholesale;
  `GET /tracker/{project}/labels` lists a project's vocabulary with counts and
  `…/items?label=` filters by one. They show on the dashboard's rows (a filter in the URL),
  in `tracker_queue` / `tracker_next` as `[Physics, Biomes]`, and in tracker search.
- **Documents are revisioned**: an edit names the revision it read and is refused (409)
  when that is stale, never merged; a rename leaves a redirect; any revision can be diffed
  or restored.
- **Approval is a track record** (`unapproved`, `agent`, `ratified`, `owner`), not a lock.
- **HTTP API:** `/tracker/…` on `rag-serve`, documented route by route, with every request
  and response body, in [`specs/tracker/api.md`](specs/tracker/api.md). The routes answer
  503 when the store cannot open; `/info` reports `tracker_ready`.
- **Live event feed** (rag-t0036): `GET /tracker/{project}/events/ws` is a WebSocket that
  sends one line per event as its write commits (`#13901 rag web approve rag-t0040 "Title"
  {approval: agent → ratified}: Go ahead. [Owner]`: each change from → to, since rag-t0038;
  `format=json` for the whole event, its `fields` and their prior values in `before`), by
  default only the owner's web actions; `since=<event id>` replays what came after it first,
  so a client that reconnects with the last id it saw loses and repeats nothing. `*` for the
  project watches every project. `GET /tracker/{project}/events` reads the same events once
  and gives the starting id. Built so Claude Code's `Monitor` tool wakes an idle manager
  (the pattern is in [`user-claude.md`](user-claude.md)); fed from the store's write path, no
  polling; a 30 s ping; a lagging client is closed with the id to resume from. Text frames
  coalesce a **burst** (rag-t0039): one project's and surface's events within 3 s
  (`coalesce=<s>`, 0 to 60; `0` for one frame per event) share one frame starting with the
  burst's last id (`#13950 rag web burst #13946–#13950, 5 events: queue reordered: 5 moves
  (…) [Owner]`), so resuming by id stays exact; a note past 200 characters is cut with
  `… (+812 chars in #13950)`. Monitor's `ws` source refuses private addresses, so on the
  server host the URL is `ws://127.0.0.1:17793/…`.
  `rag-serve` now also stops cleanly on SIGTERM.
- **Drafts** (owner, 2026-10-30): a ticket or a document (and with it its spec, milestone or
  concept) can be the owner's **draft**: created with `draft: true`, published with `draft:
  false` (`POST /tracker/items/{id}`, `POST /tracker/docs/{id}/draft`). An event written while
  its record is a draft is stamped a draft event and **left out of the feed** unless the client
  passes `drafts=true`, so the owner can write and rework without waking a monitoring agent;
  publishing is the record's first frame (`{draft: yes → no}`). A queued draft ticket sits in
  the queue view's `drafts`, never in the queue `tracker_next` or a gate's batch reads. The web
  UI has **Save as draft**, **Publish** and **Make draft**, and **Ctrl+S / Cmd+S** saves the
  ticket edit, the document editor, New concept and the add dialogs.

- **MCP tools** (m02): `rag-mcp --server tracker` (stdio) or `/tracker` on the gateway, each
  forwarding to the API (`crates/mcp/src/tracker.rs`): `tracker_queue` (the dashboard as
  compact text: requests first, then review, then the queue with gate markers, blocked and deferred, bounded by `limit` (default 20),
  `until_gate` and `sections`, done only counted unless asked for, a `Not shown:` count
  footer), `tracker_next` (the next `n` dispatchable tickets in full, stopping at the first
  gate; rag-t0006; then any `parallel` tickets below the gate, which may start now and land
  after it, rag-t0013), `tracker_list`, `tracker_get` (history only when asked: `history:
  true` or `N`, rag-t0039), `tracker_create` (tickets and gates), `tracker_create_record`
  (specs, milestones, concepts, documents), `tracker_update` (tickets),
  `tracker_update_record` (specs, milestones, concepts), `tracker_move`, `tracker_doc_get`,
  `tracker_doc_edit`, `tracker_attach`, `tracker_attachment_get` and `tracker_ack_done`.
  Every write carries `surface: mcp`, the git email and the `agent` passed, and answers with
  one line (`ok ubu-t0042 status: in_progress → done (#13950)`). Who may write what (the
  manager writes the queue; a sub-agent edits documents and notes its own task) and the
  rules every write shares are in the server's instructions, once, not in each tool, and
  are not enforced. The fourteen tool definitions come to about 10k characters (~2.6k
  tokens), down from 32k for twelve (rag-t0039). Over stdio, attachments are local files;
  over the gateway, base64 of at most 10 MB.

- **The dashboard** (m03) in the web UI, at `/projects/<project>` (never `/tracker/…`, the
  API's prefix): the owner's view of the queue, read like the manager's status report.
  **Done** (green, oldest first and the latest just above the queue, until *Acknowledge all done*), **Requests**
  (the accent, the owner's ideas waiting to be broken down, filed with *Add request*; rag-t0044), **Review** (red, a diamond,
  *Confirm* and *Send back*; rag-t0024), **the queue** in list order
  (blue in progress, white pending, red failed, each colour beside its word; gates as
  full-width markers labelled with their intensity and *release*), and **Blocked** (amber,
  with reason, note and *Unblock*). Rows are two lines (status, id, title, approval; then
  type, assignee and labels; rag-t0026; no link chips, which are on the ticket's page,
  rag-t0031), an in-progress row filled with
  the owner's blue, its text lightened to read on it (rag-t0023, rag-t0029).
  Rows and markers are dragged to reorder, by mouse or
  touch (each drop one `move`), or moved with Alt+↑ / Alt+↓ and the row menu's *Move to
  top* / *Move to bottom*; *Add ticket* and *Add gate* join the bottom, *Remove* cancels (a
  note optional). A filter shows the agent approvals not yet ratified. It refreshes every 10 s while
  the tab is visible (a conditional request, 304 when nothing changed). Each ticket has a page,
  `/projects/<project>/ticket/<id>` (the older `…/item/<id>` still opens it): its body rendered (`att:` images resolved), links, history
  with the surface and agent on every entry, and the writes: note, status, block or unblock,
  approve or ratify, edit. The bar's **Tracker** opens the project last used. See
  `web/README.md` § *The tracker*.

- **The documents pages** (m04) in the web UI: `/projects/<project>/docs` lists the
  **concepts** by state (open, refining, refined; archived folded), with **New concept**, the
  **specs** with their milestones (code, title, state, approval), other documents and the
  project's **attachments** (a preview, the uploader, the `att:` reference to copy). Each
  document is at `/projects/<project>/doc/<path>`: rendered (`att:` images resolved; a link to
  another document's path, relative or from `specs/`/`concepts/`, opens it in place), its
  record's state, approval and links with their writes, a rename's redirect followed, and
  **Edit**: markdown beside a live preview, where a pasted or dropped image uploads and its
  `att:` reference lands at the cursor. Save sends the whole body against the revision it
  read; a **stale save** (an agent edited meanwhile) keeps the owner's text and shows the
  newer revision's diff against it, with *Overwrite* and *Discard mine*. An unsaved draft is
  kept in the browser and survives a reload. **History** lists the revisions (author, agent,
  surface, message), each one's line diff and body, and *Restore* (with a message). The
  search view's **Corpus** filter searches the tracker (`corpus=tracker`).

- **Search** (m05): every document (at its current revision, chunked) and every ticket (its
  title, type, status, body and notes, done and cancelled ones included) is indexed as
  `corpus = tracker` by `rag-ingest reconcile-tracker`, a pull-based incremental reconcile in
  the ledger's style. `rag-serve` touches a trigger file after each successful tracker write
  (`server.tracker_reindex_trigger`), so a change is searchable within seconds; a 15-minute
  timer is the backstop. `search_corpus` takes `corpus: "tracker"` (and `repo` for the
  project), as does `POST /search` (`"filters": {"corpus": "tracker"}`). A tracker hit
  carries `repo` (the project), `rel_path` (the document path, or the ticket id), `title`,
  `kind` (`spec`, `milestone`, `concept`, `doc` or `item`), `tracker_id` (what `tracker_get`
  takes), `revision`, `type` and `status` (tickets), a line range (documents), and
  **`citation`**: `<project>:<path>@r<revision>` for a document chunk, the ticket id for a
  ticket. The corpus sync never purges tracker or ledger points.

Built so far: the store and the API (m01), the MCP tools (m02), the dashboard (m03), the
documents pages (m04) and search (m05). Off-box backups (m06) are to come; until then the
only copy beyond the live file is the nightly same-box one in `~/rag/backups`.

## Deployment

Designed to run on one Linux box as rootless Podman containers managed by systemd
user units. `./deploy/deploy.sh` is a one-command deploy (ship source → build image
→ install units → restart → health-check). Set `DEPLOY_HOST` in `deploy/deploy.env`
first. Full ops — backup/restore, rollback, key rotation, re-index — are in
[`deploy/RUNBOOK.md`](deploy/RUNBOOK.md); per-component reference in
[`deploy/README.md`](deploy/README.md).

## Agent Instructions

If you're an agent that's been instructed to install this project, start with the 
[`CLAUDE.md`](CLAUDE.md) — the quick-start covering what you need and how to stand up a
fresh RAG + ledger system.

## Status & scope

This is a single-developer tool, provided as-is. It assumes a trusted/private
network (Qdrant runs without auth by default) and is tuned for one user's corpus and
cost profile. Adapt the config to your own setup.

## License

MIT — see [`LICENSE`](LICENSE).
