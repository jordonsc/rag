# Deploy

Infrastructure and service deployment for the server that hosts the RAG stack (a
Linux box reached over SSH; set its host in `deploy/deploy.env`).

> **Day-to-day ops live in [`RUNBOOK.md`](RUNBOOK.md)** — deploy, rollback, restart, re-index, key rotation, backup/
> restore, disk reclaim. This file is the per-component reference. **One-command deploy: `./deploy/deploy.sh`** (from
> the dev repo root) ships source, builds the unified image on the server, installs units, restarts `rag-serve`, retires
> its own superseded image (keeping one as `:previous`), and health-checks.

The deploy target host comes from `$DEPLOY_HOST` — copy `deploy/deploy.env.example` to `deploy/deploy.env` (gitignored)
and set it, or pass it inline (`DEPLOY_HOST=myhost ./deploy/deploy.sh`); an inline value beats the file.

**If the dev box is also the server**, use `./deploy/deploy-local.sh` — the same steps without the ssh/scp hop (which
would otherwise require the box to hold a key for logging into itself). It is a thin wrapper that sets
`DEPLOY_HOST=local` and execs `deploy.sh`, so there is only ever one list of deploy steps to keep correct.

## Qdrant

Runs as a **rootless** Podman container managed by a systemd **Quadlet** user unit.

| Item | Value |
|---|---|
| Image | `docker.io/qdrant/qdrant:v1.18.2` |
| Unit | `~/.config/containers/systemd/qdrant.container` → generates `qdrant.service` (user scope) |
| Data | `~/rag/qdrant/storage` (bind mount → `/qdrant/storage`) |
| Snapshots | `~/rag/qdrant/snapshots` (bind mount → `/qdrant/snapshots`) |
| Ports | `6333` REST, `6334` gRPC |
| Auth | none by default (intended for a trusted/private network). To enable: set `QDRANT__SERVICE__API_KEY` in the unit + `QDRANT_API_KEY` on clients. |
| Boot | requires `sudo loginctl enable-linger <user>` |

### First install

```bash
# on the server
sudo loginctl enable-linger <user>
mkdir -p ~/rag/qdrant/storage ~/rag/qdrant/snapshots ~/.config/containers/systemd
podman pull docker.io/qdrant/qdrant:v1.18.2
# copy deploy/qdrant.container → ~/.config/containers/systemd/qdrant.container
systemctl --user daemon-reload
systemctl --user start qdrant.service
```

### Manage

```bash
systemctl --user status qdrant.service
systemctl --user restart qdrant.service
journalctl --user -u qdrant.service -f
```

### Disk hygiene

`deploy.sh` retires rag's own superseded image itself. `deploy/prune-images.sh`
removes **every** unused image on the host — run it only on a box dedicated to rag.

## The image

One image, `localhost/rag:latest`, built on the server from `Containerfile` and used by every unit here. It carries the
three binaries (`rag-ingest`, `rag-serve`, `rag-mcp`) and the built ledger UI; the unit names the binary, so there is no
`ENTRYPOINT`.

`Containerfile` has two independent build stages and a slim runtime:

| Stage | Base | Produces |
|---|---|---|
| SPA | `node:22-bookworm-slim` | `web/app/dist` via `npm ci && npm run build` over the `web/` workspace |
| Binaries | `rust:1.94-bookworm` | `rag-ingest`, `rag-serve`, `rag-mcp` (release) |
| Runtime | `debian:bookworm-slim` | the three binaries + the bundle at `/usr/local/share/rag/web`, plus `git`, CA certs and `curl` |

Neither build stage copies the other's inputs, so a UI change does not recompile the workspace and a crate change does
not re-run `npm ci`. The bundle's destination is fixed by agreement with `rag-serve.container`'s
`RAG_SERVER__WEB_ROOT` — change one, change the other. Nothing from the Node stage other than `dist` reaches the runtime
image, so `node_modules` and the Node toolchain are not shipped.

**The server needs the npm registry as well as crates.io** at build time. Neither `node_modules/` nor `dist/` is
rsynced — the build makes both from the committed `package-lock.json`.

## Indexer + sync (polling)

The indexer (`rag-ingest`) runs **on the server** as a container, driven by a systemd timer that polls GitHub every
15 min. No public endpoint is needed.

| Item | Value |
|---|---|
| Image | `localhost/rag:latest` (unified image, `rag-ingest` binary; built on the server from `Containerfile`) |
| Env file | `~/.config/rag/env` (chmod 600): `VOYAGE_API_KEY`, `GITHUB_TOKEN`, and **`RAG_GITHUB__ACCOUNT`** (required — the GitHub user/org whose repos are indexed; the unit ships no default, so an empty account purges the corpus) |
| Corpus volume | `~/rag/corpus` → `/work/corpus` (shallow clones persist between runs) |
| Units | `~/.config/systemd/user/rag-sync.{service,timer}` (rootless) |
| Schedule | every 15 min (`OnCalendar=*:0/15`, `Persistent=true`, 30 s jitter) |

### Build / deploy

`./deploy/deploy.sh` does all of this (and the serve service). Manually, the indexer pieces are:

```bash
# from dev: ship source (no target/.git/.env/node_modules/dist), then build on the server
rsync -az --exclude target --exclude .git --exclude .env --exclude corpus \
    --exclude node_modules --exclude dist ./ "$DEPLOY_HOST:rag/src/"
ssh "$DEPLOY_HOST" 'cd ~/rag/src && podman build -t localhost/rag:latest -f Containerfile .'

# env file (once): ~/.config/rag/env -> VOYAGE_API_KEY=... / GITHUB_TOKEN=... / RAG_GITHUB__ACCOUNT=your-github-account
# install + enable the timer (copy deploy/rag-sync.{service,timer} -> ~/.config/systemd/user/)
ssh "$DEPLOY_HOST" 'systemctl --user daemon-reload && systemctl --user enable --now rag-sync.timer'
```

### Manage

```bash
systemctl --user list-timers rag-sync.timer
systemctl --user start rag-sync.service     # run a sync now
journalctl --user -u rag-sync.service -f
```

## Ledger and tracker reconciles

Two cheap, incremental jobs keep the SQLite-backed corpora in Qdrant current. Each diffs its store against the index
and embeds only what changed; each has its own circuit breaker, kept beside its database.

| | Ledger (`corpus = ledger`) | Tracker (`corpus = tracker`) |
|---|---|---|
| Command | `rag-ingest reconcile-ledger` | `rag-ingest reconcile-tracker` |
| Units | `rag-ledger-sync.{service,timer}`, `rag-ledger-reindex.path` | `rag-tracker-sync.{service,timer}`, `rag-tracker-reindex.path` |
| Trigger | `~/rag/triggers/ledger-reindex`, touched by `rag-serve` after each ledger write | `~/rag/triggers/tracker-reindex`, touched by `rag-serve` after each successful tracker write (`RAG_SERVER__TRACKER_REINDEX_TRIGGER`) |
| Backstop | every 15 min at `:7/15` | every 15 min at `:11/15` |
| Store | `~/rag/ledger` → `/ledger` | `~/rag/tracker` → `/tracker` |
| Breaker | `~/rag/ledger/.rag-ledger-breaker.json` | `~/rag/tracker/.rag-tracker-breaker.json` |
| Run now | `make reconcile-ledger` | `make reconcile-tracker` |

The tracker reconcile indexes each document at its current revision (chunked; a hit cites
`<project>:<path>@r<revision>`) and each ticket as one point (title, type, status, body and notes; a hit cites the
ticket id). An edit, a rename or a ticket change replaces that unit's points; nothing of an old revision or an old path
survives a run. The corpus sync never touches either corpus: its repo purge is limited to `code` and `wiki` points.

## Retrieval service

`rag-serve` runs **on the server** as a rootless Quadlet container, host-networked so it binds `:17793` and reaches
Qdrant at `localhost:6334`. It needs only Qdrant + the Voyage key (not the corpus files). It also serves the **ledger
web UI** at `/` on that same port, from a bundle baked into the image.

| Item | Value |
|---|---|
| Image | `localhost/rag:latest` (`rag-serve` binary) |
| Unit | `~/.config/containers/systemd/rag-serve.container` → generates `rag-serve.service` |
| Secrets | `~/.config/rag/env` (`VOYAGE_API_KEY`; `QDRANT_API_KEY` and `ANTHROPIC_API_KEY` optional) |
| Config | built-in defaults + `RAG_*` env (no `rag.toml` shipped); `RAG_QDRANT__URL=http://localhost:6334` |
| Port | `17793` (host networking) |
| Health | `GET /health` → `ok`; `GET /info` → collection stats + models + `retrieval_ready`/`summarise_ready`/`tracker_ready` (no secrets); always 200, `points: null` + `qdrant_error` when Qdrant is unreachable |
| Summarise | `POST /ledger/{id}/summarise` — needs `ANTHROPIC_API_KEY`; **optional**, and 503s without it. Nothing is cached: one billed call per press. |
| Web UI | `http://<server>:17793/` — from `RAG_SERVER__WEB_ROOT=/usr/local/share/rag/web` |
| Saved prompts | `GET /prompts`, `POST /prompts/save`, `POST /prompts/delete` — the Summarise tab's prompt library. `~/rag/prompts` → `/prompts` (`RAG_SERVER__PROMPTS_DIR`), one `.md` file per prompt. Unset/empty dir = only the built-in prompt; the write routes 503. |
| Boot | auto-starts via linger (Quadlet `WantedBy=default.target`) |

The UI shares the API's origin, so there is no CORS to configure — and there should not be. `RAG_SERVER__WEB_ROOT` is
optional: unset it, or point it at a directory with no `index.html`, and `rag-serve` logs a warning and serves the JSON
API alone. The API paths (`/health`, `/info`, `/search`, `/reindex`, `/ledger*`, `/prompts*`) are excluded from the UI's
single-page fallback, so a mistyped endpoint still answers a JSON 404 rather than an HTML document.

The **saved prompts** directory is bind-mounted rather than baked in, so prompts survive an image rebuild and can be
managed with a text editor: `~/rag/prompts/Terse.md` *is* the prompt named "Terse". `~/rag/` and deliberately not
`~/.config/rag/`, which holds the secrets env file — mounting that directory into the container would put the secrets on
the container filesystem for no gain. The built-in default prompt is a constant in the binary, is served to the UI by
`/info`, and is **never written to disk**: an empty directory is a fallback to it, not a missing file. Note that
`/prompts/save` and `/prompts/delete` are the only routes in the service that write a file, on a port with no auth — the
name allow-list and containment checks that make that acceptable are in `crates/serve/src/prompts.rs`.

Because the bundle lives in the image, **a UI change ships by redeploy, not by restart** — `./deploy/deploy.sh` rebuilds
the image; `systemctl --user restart` just re-runs the one already there.

`rag-mcp` is **not** deployed here — it's a stdio MCP server run per-client on the box where Claude Code runs (build
locally with `cargo build --release -p rag-mcp`; register via `.mcp.json`). See [`RUNBOOK.md`](RUNBOOK.md).

## Backups

`deploy/backup-qdrant.sh` (run on the server) snapshots `rag_corpus` via the Qdrant API and keeps the last 7 tarballs
under `~/rag/backups`. Restore steps in [`RUNBOOK.md`](RUNBOOK.md). The index is also fully rebuildable from GitHub via
`rag-sync` — a snapshot just skips the re-embed.

The same script copies `~/rag/ledger/ledger.db` and `~/rag/tracker/tracker.db` (the tracker's store, bind-mounted into
`rag-serve` at `/tracker`) beside the snapshots, keeping the last 7 of each, with `sqlite3 .backup` (install the
`sqlite3` package: without it the copy is a raw one). `rag-backup.{service,timer}` runs it daily at 00:00 UTC. Neither
database can be rebuilt, and this copy is on the same disk.

**Off the box** (tracker m06): `deploy/backup-offbox.sh`, run nightly at 01:33 UTC by
`rag-backup-offbox.{service,timer}`, uploads a `sqlite3 .backup` copy of each database (zstd-compressed, with a
manifest of its sha256 and every table's row count) to `RAG_BACKUP__S3_URI` (`s3://rag-atlas-backups/atlas` on
atlas: ap-southeast-4, private, versioned, 30-day noncurrent expiry), keeps 7 daily and 4 weekly copies of each, and
syncs the tracker's attachments by hash. It authenticates with the host's AWS CLI profile
(`RAG_BACKUP__AWS_PROFILE`, region `RAG_BACKUP__AWS_REGION`); no AWS key lives in `~/.config/rag/env`. Host needs:
`aws` v2, `sqlite3`, `zstd`. `deploy.sh` installs both units and enables the timer only when `RAG_BACKUP__S3_URI` is
set. `deploy/restore-offbox.sh DEST [STAMP]` fetches and verifies a copy into a scratch directory, and
`deploy/test-offbox.sh` exercises both scripts against a throwaway prefix. Bucket settings, the restore procedure and
the rehearsal: [`RUNBOOK.md`](RUNBOOK.md), "Off-box backups (S3)" and "Restore from S3".

## Collection bootstrap

Created from the dev machine, idempotently:

```bash
cargo run -p rag-ingest -- init
```

Vector size 1024 / cosine, int8 scalar quantization, payload indexes on
`corpus`, `repo`, `path`, `language`, `content_hash`, and for the ledger and tracker
`type`, `status`, `topic_id` and `tracker_id`. `init` adds any missing index to an
existing collection, and `deploy.sh` runs it on every deploy.
