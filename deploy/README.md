# Deploy

Infrastructure and service deployment for the server that hosts the RAG stack (a
Linux box reached over SSH; set its host in `deploy/deploy.env`).

> **Day-to-day ops live in [`RUNBOOK.md`](RUNBOOK.md)** — deploy, rollback, restart, re-index, key rotation, backup/
> restore, disk reclaim. This file is the per-component reference. **One-command deploy: `./deploy/deploy.sh`** (from
> the dev repo root) ships source, builds the unified image on the server, installs units, restarts `rag-serve`, prunes
> old images, and health-checks.

The deploy target host comes from `$DEPLOY_HOST` — copy `deploy/deploy.env.example` to `deploy/deploy.env` (gitignored)
and set it, or pass it inline (`DEPLOY_HOST=myhost ./deploy/deploy.sh`).

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

Run `deploy/prune-images.sh` on the server after deploying a new image version.

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
# from dev: ship source (no target/.git/.env), then build on the server
rsync -az --exclude target --exclude .git --exclude .env --exclude corpus ./ "$DEPLOY_HOST:rag/src/"
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

## Retrieval service

`rag-serve` runs **on the server** as a rootless Quadlet container, host-networked so it binds `:17793` and reaches
Qdrant at `localhost:6334`. It needs only Qdrant + the Voyage key (not the corpus files).

| Item | Value |
|---|---|
| Image | `localhost/rag:latest` (`rag-serve` binary) |
| Unit | `~/.config/containers/systemd/rag-serve.container` → generates `rag-serve.service` |
| Secrets | `~/.config/rag/env` (`VOYAGE_API_KEY`; `QDRANT_API_KEY` optional) |
| Config | built-in defaults + `RAG_*` env (no `rag.toml` shipped); `RAG_QDRANT__URL=http://localhost:6334` |
| Port | `17793` (host networking) |
| Health | `GET /health` → `ok`; `GET /info` → collection stats + models (no secrets) |
| Boot | auto-starts via linger (Quadlet `WantedBy=default.target`) |

`rag-mcp` is **not** deployed here — it's a stdio MCP server run per-client on the box where Claude Code runs (build
locally with `cargo build --release -p rag-mcp`; register via `.mcp.json`). See [`RUNBOOK.md`](RUNBOOK.md).

## Backups

`deploy/backup-qdrant.sh` (run on the server) snapshots `rag_corpus` via the Qdrant API and keeps the last 7 tarballs
under `~/rag/backups`. Restore steps in [`RUNBOOK.md`](RUNBOOK.md). The index is also fully rebuildable from GitHub via
`rag-sync` — a snapshot just skips the re-embed.

## Collection bootstrap

Created from the dev machine, idempotently:

```bash
cargo run -p rag-ingest -- init
```

Vector size 1024 / cosine, int8 scalar quantization, payload indexes on
`corpus`, `repo`, `path`, `language`, `content_hash`.
