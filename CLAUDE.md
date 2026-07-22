# RAG + Ledger — setup guide

This repo is a self-hosted **Retrieval-Augmented Generation** backend for coding agents
(semantic code/doc search with reranking) plus an append-only **ledger** for recording
decisions/incidents. It exposes retrieval + the ledger over an HTTP API, MCP servers, and
an optional Claude Skill. See `README.md` for architecture; `deploy/README.md` and
`deploy/RUNBOOK.md` for full ops.

This file is the **quick-start**: what you need and how to stand up a fresh system.

## What you need

- **A Linux server** you can SSH to — runs Qdrant + the retrieval service + the index/ledger
  timers. It uses **rootless Podman** and **systemd user units**, so no root beyond enabling
  linger. A trusted/private network is assumed (Qdrant runs without auth by default).
- **A [Voyage AI](https://voyageai.com) API key** — for embeddings + reranking. This is the
  only mandatory secret; it lives only on the server (`rag-serve` holds it; clients never see it).
- **A GitHub fine-grained token** (`GITHUB_TOKEN`) with read access to the repos you want
  indexed — only if you use the GitHub source (`--source github`). Not needed for `--source local`.
- **The GitHub account/org name** whose repos form the corpus (`RAG_GITHUB__ACCOUNT`).
- **A Rust toolchain** (1.94+) on your dev/build box — to bootstrap the Qdrant collection and,
  for the stdio MCP option, to build `rag-mcp`. The server builds its container image from
  `Containerfile` during deploy.

## Quick setup

Full detail is in `deploy/RUNBOOK.md` ("Bootstrap a fresh box"); the short version:

1. **Server prep.** `sudo loginctl enable-linger <user>`, create the data dirs
   (`~/rag/{qdrant/{storage,snapshots},corpus,backups,ledger,triggers}`), and install Qdrant
   (`deploy/qdrant.container` — see `deploy/README.md`).
2. **Env file** `~/.config/rag/env` on the server (chmod 600) — config + secrets, never committed:
   ```
   VOYAGE_API_KEY=...
   GITHUB_TOKEN=...                          # only for --source github
   RAG_GITHUB__ACCOUNT=your-github-account   # REQUIRED — an empty account purges the corpus
   RAG_EMAIL=you@example.com                 # ledger author for writes over the HTTP gateway
   ```
3. **Deploy target.** Copy `deploy/deploy.env.example` → `deploy/deploy.env` and set
   `DEPLOY_HOST` (the server's SSH host).
4. **Bootstrap the collection** from your dev box: `cargo run -p rag-ingest -- init` (idempotent;
   creates the vector collection + payload indexes, pointing `RAG_QDRANT__URL` at the server).
5. **Deploy** everything with one command: `./deploy/deploy.sh` (ships source → builds the image
   on the server → installs units → starts `rag-serve` + the MCP gateway → enables the corpus +
   ledger timers → health-checks).
6. **Fill the index:** `ssh "$DEPLOY_HOST" systemctl --user start rag-sync.service` (or wait for
   the 15-min timer). The ledger starts empty and fills as agents log to it.
7. **Register the tools with your agent** — see next section.

Non-container / local dev (index a local filesystem tree, run the service by hand) is covered in
`README.md` → "Run".

## Connecting an agent

Configure `rag.toml` (from `rag.toml.example`) and register the MCP servers via
`.mcp.json` (from `.mcp.json.example`). Two transports — pick one:

- **stdio** (per-client subprocess): `cargo build --release -p rag-mcp`, then register two servers
  from the one binary — `--server corpus` and `--server ledger`. Captures the client's git identity
  automatically (best for a workstation that writes a lot of ledger entries).
- **Streamable HTTP gateway** (no local binary): point the client at the `rag-mcp` gateway on the
  server (`http://your-server:17794/corpus` and `.../ledger`).

Then teach the agent to actually *use* it: add the corpus-first + ledger guidance to your
user-level `~/.claude/CLAUDE.md`. A ready-to-adapt example is in
[`user-claude.md`](user-claude.md).

### Skill is optional — prefer MCP only

The repo also ships a Claude **Skill** (`skill/corpus-search/`). It is **optional** and only
advised if you'd rather *not* use the MCP server (e.g. a harness without MCP support) — it hits
the same `rag-serve` HTTP API. **Do not install both the MCP and the Skill**: they overlap, and
loading both consumes extra context for no benefit. **Recommendation: stick with the MCP alone**
unless you explicitly want the Skill instead.

## Where things live

| Concern | File(s) |
|---|---|
| Architecture, requirements, local run | `README.md` |
| Per-component deploy reference | `deploy/README.md` |
| Day-to-day ops (deploy, backup/restore, re-index, key rotation) | `deploy/RUNBOOK.md` |
| Non-secret config (Qdrant URL, corpus roots, chunk sizes) | `rag.toml.example` |
| MCP registration | `.mcp.json.example` |
| Example user-level agent instructions | `user-claude.md` |
