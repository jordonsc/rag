# RAG + Ledger — setup guide

This repo is a self-hosted **Retrieval-Augmented Generation** backend for coding agents
(semantic code/doc search with reranking) plus an append-only **ledger** for recording
decisions/incidents. It exposes retrieval + the ledger over an HTTP API, MCP servers, a web
UI for the ledger, and an optional Claude Skill. See `README.md` for architecture;
`deploy/README.md` and `deploy/RUNBOOK.md` for full ops.

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
- **Optionally, an Anthropic API key** (`ANTHROPIC_API_KEY`) — the *only* optional secret, and
  the only LLM call this project makes. It powers the web UI's **Summarise** tab
  (`POST /ledger/{id}/summarise`), which asks a model to compress one long ledger entry. Like
  the Voyage key it lives only on the server and never reaches a browser. Absent = that one
  route 503s; nothing else changes and no startup fails.
- **A Rust toolchain** (1.94+) on your dev/build box — to bootstrap the Qdrant collection and,
  for the stdio MCP option, to build `rag-mcp`. The server builds its container image from
  `Containerfile` during deploy.
- **A Node toolchain — but only if you build the web UI outside the container.** The image
  build compiles the SPA in its own `node:22` stage, so **the server needs nothing installed
  beyond Podman**; what it does need is outbound access to the **npm registry** as well as
  crates.io while building. Install Node 22+ / npm 10+ locally only to run `npm run dev`, the
  frontend tests, or a hand-built bundle (see `web/README.md`).

## Quick setup

Full detail is in `deploy/RUNBOOK.md` ("Bootstrap a fresh box"); the short version:

1. **Server prep.** `sudo loginctl enable-linger <user>`, create the data dirs
   (`~/rag/{qdrant/{storage,snapshots},corpus,backups,ledger,triggers,prompts,tracker/attachments}`), and install Qdrant
   (`deploy/qdrant.container` — see `deploy/README.md`).
2. **Env file** `~/.config/rag/env` on the server (chmod 600) — config + secrets, never committed:
   ```
   VOYAGE_API_KEY=...
   GITHUB_TOKEN=...                          # only for --source github
   RAG_GITHUB__ACCOUNT=your-github-account   # REQUIRED — an empty account purges the corpus
   RAG_EMAIL=you@example.com                 # ledger author for writes over the HTTP gateway
   ANTHROPIC_API_KEY=...                     # OPTIONAL — enables the web UI's Summarise tab
   RAG_BACKUP__S3_URI=s3://your-bucket/prefix   # the nightly off-box backup's destination
   RAG_BACKUP__AWS_PROFILE=default           # the host's AWS CLI profile it uploads with
   RAG_BACKUP__AWS_REGION=ap-southeast-4     # the bucket's region
   ```

   The `RAG_BACKUP__*` keys drive `deploy/backup-offbox.sh` (tracker m06): nightly, the tracker and ledger
   databases (`sqlite3 .backup`, compressed) and the tracker's attachments go to S3, 7 daily and 4 weekly copies
   kept. **No AWS key goes in this file**: the script runs on the host as your user and the AWS CLI reads the
   credentials of the named profile from `~/.aws`. The host needs `aws` (v2), `sqlite3` and `zstd`. Without
   `RAG_BACKUP__S3_URI` the off-box timer is simply not enabled. Bucket setup and restore: `deploy/RUNBOOK.md`.

   The Summarise tab's system prompt can also be picked from a small library of saved
   prompts — plain `.md` files in `~/rag/prompts` (`RAG_SERVER__PROMPTS_DIR=/prompts` in
   the container), editable from the UI or with a text editor. No directory, or an empty
   one, means only the built-in default prompt is offered; the built-in is a constant in
   the binary and is never written to disk. See `README.md` → *Saved Summarise prompts*.

   `ANTHROPIC_API_KEY` is the only optional one. Without it everything works exactly as
   before and `POST /ledger/{id}/summarise` answers 503 — the same way the retrieval routes
   answer without a Voyage key. It is deliberately **not** in `deploy.sh`'s preflight guard:
   that guard exists because a missing `RAG_GITHUB__ACCOUNT` destroys data, whereas a missing
   Anthropic key just switches one feature off.
3. **Deploy target.** Copy `deploy/deploy.env.example` → `deploy/deploy.env` and set
   `DEPLOY_HOST` (the server's SSH host).
4. **Bootstrap the collection** from your dev box: `cargo run -p rag-ingest -- init` (idempotent;
   creates the vector collection + payload indexes, pointing `RAG_QDRANT__URL` at the server).
5. **Deploy** everything with one command: `./deploy/deploy.sh` — or `./deploy/deploy-local.sh`
   if this box *is* the server, which runs the same steps without the ssh hop (ships source → builds the image
   on the server → installs units → starts `rag-serve` + the MCP gateway → enables the corpus,
   ledger and tracker timers, the same-box backup timer and, with `RAG_BACKUP__S3_URI` set, the off-box one → health-checks). The image build now covers **both** the Rust binaries and the
   ledger web UI, so the first one on a fresh box pulls two toolchain images and a dependency
   tree; later builds reuse the layers.
6. **Fill the index:** `ssh "$DEPLOY_HOST" systemctl --user start rag-sync.service` (or wait for
   the 15-min timer). The ledger starts empty and fills as agents log to it.
7. **Open the ledger UI** at `http://<server>:17793/` — same port and origin as the API. If it
   answers a JSON 404 instead, the bundle didn't reach the image; `deploy.sh` warns about this
   rather than failing, because the UI is optional and the API is unaffected.
8. **Register the tools with your agent** — see next section.

Non-container / local dev (index a local filesystem tree, run the service by hand) is covered in
`README.md` → "Run".

## Connecting an agent

Configure `rag.toml` (from `rag.toml.example`) and register the MCP servers via
`.mcp.json` (from `.mcp.json.example`). Two transports — pick one:

- **stdio** (per-client subprocess): `cargo build --release -p rag-mcp`, then register three servers
  from the one binary — `--server corpus`, `--server ledger` and `--server tracker`. Captures the
  client's git identity automatically (best for a workstation that writes a lot of ledger entries),
  and the tracker's project defaults to the current repository and its attachments are local files.
- **Streamable HTTP gateway** (no local binary): point the client at the `rag-mcp` gateway on the
  server (`http://your-server:17794/corpus`, `.../ledger` and `.../tracker`). Tracker calls then
  need an explicit `project`, and attachments travel as base64 (at most 10 MB).

Then teach the agent to actually *use* it: add the corpus-first, ledger and tracker guidance to your
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
| Non-secret config (Qdrant URL, corpus roots, chunk sizes, web UI root, prompts dir) | `rag.toml.example` |
| Serving the ledger web UI (`server.web_root` / `RAG_SERVER__WEB_ROOT`) | `crates/serve/src/web.rs`, `deploy/rag-serve.container` |
| Saved Summarise prompts (`server.prompts_dir` / `RAG_SERVER__PROMPTS_DIR`) | `crates/serve/src/prompts.rs`, `deploy/rag-serve.container` |
| Building the ledger web UI (dev loop, design system, tests) | `web/README.md`, the Node stage in `Containerfile` |
| The tracker store (`[tracker] db_path`, `attachments_dir`; queue, specs, concepts, attachments) | `crates/core/src/tracker/`, `deploy/rag-serve.container` |
| The tracker HTTP API (`/tracker/…`) and its contract | `crates/serve/src/tracker.rs`, `specs/tracker/api.md` |
| The tracker's live event feed (`/tracker/{project}/events/ws`: the broadcast after commit, replay and resume, burst coalescing, the `Monitor` pattern on `127.0.0.1`) | `crates/core/src/tracker/feed.rs`, `crates/serve/src/tracker/feed.rs`, `specs/tracker/api.md` § *The event feed*, `user-claude.md` § *Tracker*; the ticket page's live read: `web/app/src/tracker/useFeed.ts` |
| The tracker's design and milestones | `specs/tracker/master.md` |
| The tracker MCP tools (`--server tracker`, `/tracker` on the gateway; the shared rules in its `INSTRUCTIONS`, the definitions' size budget, one-line write replies) | `crates/mcp/src/tracker.rs`, `specs/tracker/m02-mcp-server.md` (rag-t0039 addendum) |
| Tracker search (`corpus = tracker`: the reconcile, its trigger and units, the citation) | `crates/ingest/src/tracker_reconcile.rs`, `crates/core/src/tracker/index.rs`, `deploy/rag-tracker-*`, `deploy/RUNBOOK.md` § *Tracker: reconcile now* |
| A project's manager loading its work into the tracker (the trial brief) | `specs/tracker/trial-brief.md` |
| The tracker dashboard, ticket page and documents pages (web UI at `/projects/…`: docs, a document, its editor, unsaved local text, history, attachments; its client for every `/tracker/…` route) | `web/app/src/tracker/`, `web/README.md` § *The tracker* |
| Drafts (a ticket's or document's `draft` flag; draft events stamped in `append_event` and left out of the feed unless `drafts=true`; the queue view's `drafts`; Save as draft / Publish / Make draft; the Ctrl+S save shortcut) | `crates/core/src/tracker/mod.rs` (`event_is_draft`), `crates/core/src/tracker/feed.rs` (`FeedFilter::drafts`), `specs/tracker/api.md` § Event, `specs/tracker/master.md` D11 amendment 2026-10-30, `web/app/src/tracker/saveShortcut.ts` |
| Attaching files to a note or body (paste, drop, Attach) and the image viewer (rag-t0053, rag-t0055) | `web/app/src/tracker/attach.tsx`, `ImageViewer.tsx`, `viewerMath.ts`; `specs/tracker/m03-dashboard.md` addendum 2026-10-28 |
| MCP registration | `.mcp.json.example` |
| Ledger topic ids (`<repo>-l<seq:04>` since rag-t0051, legacy `<repo>-<seq:04>` still read; the one sequence per repo) | `crates/core/src/ledger.rs` (`format_topic_id`, `parse_topic_id`), `web/app/src/ledger/ids.ts`, `README.md` § *Ledger* |
| Example user-level agent instructions | `user-claude.md` |
