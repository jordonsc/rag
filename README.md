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
- **Serves** a small web UI for that ledger — search, read and amend topics on the
  same terms an agent gets — from the same origin as the API.

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
├── core/    # shared: data model, figment config, Qdrant + Voyage clients, retrieval pipeline, ledger store
├── ingest/  # corpus walk → chunk → embed → upsert  (binary: rag-ingest)
├── serve/   # axum HTTP retrieval + ledger CRUD + web UI  (binary: rag-serve)
└── mcp/      # stdio MCP server(s)                      (binary: rag-mcp)

web/
├── ui/      # @rag/ui  — design system: one theme, components, icon registry
└── app/     # @rag/app — the ledger viewer (React + Vite); its dist/ is what rag-serve serves
```

- **Vector DB:** Qdrant (self-hosted, rootless Podman), 1024-dim cosine, int8 quantization.
- **Embeddings:** Voyage `voyage-4-large` (`input_type=document` at ingest, `query` at search).
- **Reranking:** Voyage `rerank-2.5`.
- **Chunking:** Rust `text-splitter` + tree-sitter grammars, character-sized (calibrated to a token target).
- **Ledger:** SQLite (`sqlx`, WAL) as source of truth, reconciled into Qdrant.

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
| `rag.toml` (from `rag.toml.example`) | Non-secret config: Qdrant URL, corpus roots, GitHub account, chunk sizes, server bind, web UI root, saved-prompts dir. Env overrides via `RAG_*` (e.g. `RAG_QDRANT__URL`). |
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
```

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
  - *stdio* (per-client subprocess): `cargo build --release -p rag-mcp`, then register two
    servers from the one binary — `--server corpus` (`search_corpus`, `reindex_corpus`) and
    `--server ledger` (`ledger_search`/`get`/`create`/`append`/`move`/`archive`). Captures the
    client's git identity automatically.
  - *Streamable HTTP* (`--transport http`): one long-lived **shared server** exposing both
    tool sets under `/corpus` and `/ledger`, so remote clients register two URLs and need no
    local binary (`claude mcp add --transport http rag http://host:17794/corpus`). Run it on
    the server via `rag-mcp.container` (see `deploy/`).
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
