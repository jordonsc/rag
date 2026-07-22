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
  are re-embedded; removed/archived repos are purged).
- **Retrieves** via embed → ANN search → Voyage rerank → ranked, **citable** results
  (`repo` + `rel_path` + line range).
- **Exposes** retrieval three ways: an HTTP API, an MCP server (`search_corpus`),
  and a Claude Skill — all sharing one pipeline.
- **Records** decisions/incidents in a SQLite-backed ledger, indexed alongside the
  corpus (`corpus = ledger`) and reachable via MCP tools.

## Architecture

A single Cargo workspace:

```
crates/
├── core/    # shared: data model, figment config, Qdrant + Voyage clients, retrieval pipeline, ledger store
├── ingest/  # corpus walk → chunk → embed → upsert  (binary: rag-ingest)
├── serve/   # axum HTTP retrieval + ledger CRUD       (binary: rag-serve)
└── mcp/      # stdio MCP server(s)                      (binary: rag-mcp)
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
- A running Qdrant instance (a Quadlet unit is provided under `deploy/`).
- A [Voyage AI](https://voyageai.com) API key.
- For the GitHub source: a fine-grained `GITHUB_TOKEN` with read access to the repos you want indexed.

## Configuration

Two layers, both with committed examples and gitignored real files:

| File | Purpose |
|---|---|
| `rag.toml` (from `rag.toml.example`) | Non-secret config: Qdrant URL, corpus roots, GitHub account, chunk sizes, server bind. Env overrides via `RAG_*` (e.g. `RAG_QDRANT__URL`). |
| `.env` | Secrets only: `VOYAGE_API_KEY`, `GITHUB_TOKEN`, optional `QDRANT_API_KEY`. Never committed. |
| `deploy/deploy.env` (from `deploy/deploy.env.example`) | Deploy target: `DEPLOY_HOST` (SSH host of the server). |
| `.mcp.json` (from `.mcp.json.example`) | Registers the MCP servers with Claude Code. |

**Secrets are read from the environment only** — never put an API key in `rag.toml`.

## Build & test

```bash
make all          # fmt-check + clippy (-D warnings) + tests
make build        # cargo build --workspace
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
and an append-only event log (state/status change only by appending). It's derived
into Qdrant as `corpus = ledger` by a pull-based reconciler, so a normal
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
