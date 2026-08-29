# RAG Runbook

Terse ops for the RAG stack on the server (reached over SSH; set `$DEPLOY_HOST` in
`deploy/deploy.env`). All services are **rootless Podman** managed by **systemd
user units**; they auto-start on boot via linger. See `README.md` for first-install
of Qdrant.

## What runs where

| Component | Host | Unit | Image | Port |
|---|---|---|---|---|
| Qdrant | server | `qdrant.service` (Quadlet) | `docker.io/qdrant/qdrant:v1.18.2` | 6333/6334 |
| Indexer (sync) | server | `rag-sync.{service,timer}` | `localhost/rag:latest` (`rag-ingest`) | — |
| Ledger reconcile | server | `rag-ledger-sync.{service,timer}` + `rag-ledger-reindex.path` | `localhost/rag:latest` (`rag-ingest reconcile-ledger`) | — |
| Retrieval API + ledger CRUD | server | `rag-serve.service` (Quadlet) | `localhost/rag:latest` (`rag-serve`) | 17793 |
| MCP gateway (Streamable HTTP) | server | `rag-mcp.service` (Quadlet) | `localhost/rag:latest` (`rag-mcp --transport http`) | 17794 |
| MCP server (stdio) | **dev / client box** | none (stdio subprocess) | local release binary | — |

The **ledger** is a SQLite DB at `~/rag/ledger/ledger.db` (the **source of truth** for
decisions/incidents/defects/investigations). `rag-serve` owns writes (`POST /ledger*`);
`rag-ingest reconcile-ledger` derives the searchable `corpus = ledger` points in Qdrant.
Unlike the corpus index, **the ledger DB cannot be rebuilt from elsewhere — back it up.**

**`rag-mcp` has two transports — pick by where the client runs.** Both are thin
**HTTP clients of `rag-serve`** and hold **no key**.

- **Streamable HTTP gateway (`--transport http`, on the server).** One long-lived
  service (`rag-mcp.service`, port **17794**) exposing **both** tool sets under
  distinct paths — `/corpus` and `/ledger`. Remote clients register two URLs and
  need **no local binary**:

  ```bash
  claude mcp add --transport http rag    http://your-server:17794/corpus
  claude mcp add --transport http ledger http://your-server:17794/ledger
  ```

  Caveat — **ledger attribution**: a shared server has no client git context, so
  writes are stamped with the gateway's `RAG_EMAIL`/`RAG_AGENT` (set in
  `rag-mcp.container`) and `ledger_create` needs an explicit `repo` arg. Fine for a
  single-operator estate; for a workstation that authors a lot of ledger entries,
  prefer the stdio binary below (it captures the real git identity + repo).

- **stdio subprocess (`--transport stdio`, the default, on the client box).**
  Spawned per-client by Claude Code; captures the client's git `user.email`/repo
  automatically. Set `RAG_AGENT` to **`Unknown`** rather than a model name — one
  process serves a whole session including subagents on other models, so no static
  value is right, and a stale model name stamps every unattributed write with a
  confident lie. Agents pass `agent` per call. Build + register locally:

  ```bash
  cargo build --release -p rag-mcp          # on the client box
  claude mcp add rag --scope user --env RAG_SERVE_URL=http://your-server:17793 \
    --env RAG_AGENT=Unknown -- /path/to/rag/target/release/rag-mcp
  ```

All agent surfaces — the HTTP gateway, the stdio binary, and the HTTP Skill
(`skill/corpus-search`) — go through `rag-serve`, so the Voyage key lives only on
the server.

## Secrets + required config

`~/.config/rag/env` on the server (chmod 600), delivered to units via `EnvironmentFile`
/ `--env-file`. Never in an image or the repo.

```
VOYAGE_API_KEY=...
GITHUB_TOKEN=...
RAG_GITHUB__ACCOUNT=your-github-account   # REQUIRED: the account whose repos are indexed
RAG_EMAIL=you@example.com                 # ledger author for writes over the HTTP gateway
```

`RAG_GITHUB__ACCOUNT` is not a secret but lives here because the containers ship no
`rag.toml` — an empty account selects 0 repos and the reconcile purges the corpus.

## Deploy a new version

From the dev repo root — one command (ship → build → install units → restart →
prune → health-check):

```bash
./deploy/deploy.sh
```

It rsyncs source to `$DEPLOY_HOST:~/rag/src`, builds `localhost/rag:latest`, installs the
unit files, restarts `rag-serve`, reloads `rag-sync.timer`, prunes old images, and
verifies `/health` + `/info`. Idempotent.

## Rollback

Podman keeps the previous image as a dangling layer **until pruned**. To roll back
quickly, redeploy the previous git revision:

```bash
git checkout <prev-sha> && ./deploy/deploy.sh && git checkout -
```

(There's no in-place image tag history once pruned — a rebuild from the prior
revision is the reliable rollback. The build is a few minutes.)

## Restart / status / logs

```bash
ssh "$DEPLOY_HOST" systemctl --user restart rag-serve.service
ssh "$DEPLOY_HOST" systemctl --user status  rag-serve.service
ssh "$DEPLOY_HOST" journalctl --user -u rag-serve.service -f
ssh "$DEPLOY_HOST" systemctl --user list-timers rag-sync.timer
ssh "$DEPLOY_HOST" journalctl --user -u rag-sync.service -n 50   # last sync's change summary
```

## Health

```bash
ssh "$DEPLOY_HOST" curl -fsS http://localhost:17793/health    # -> ok
ssh "$DEPLOY_HOST" curl -fsS http://localhost:17793/info      # collection, points, models, config (no secrets)
```

`/info.points` should track the corpus. A sudden drop signals a bad sync —
check `rag-sync.service` logs.

## Run a sync now / full re-index

Three ways to trigger an immediate incremental re-index (all run the same `rag-sync.service`, which systemd
serialises so two never overlap):

```bash
make reindex                                                     # from the dev repo (wraps the ssh below)
ssh "$DEPLOY_HOST" systemctl --user start rag-sync.service       # incremental, now
curl -fsS -X POST http://your-server:17793/reindex              # via rag-serve (what the MCP `reindex_corpus` tool calls)
```

The `POST /reindex` path: rag-serve writes `~/rag/triggers/reindex`, the `rag-reindex.path` user unit watches it and
starts `rag-sync.service`. Agents call this through the `reindex_corpus` MCP tool after pushing changes.

```bash
# Full re-embed (rare — e.g. after changing chunking/model). Forces all files:
ssh "$DEPLOY_HOST" 'podman run --rm --network=host --pull=never \
  --env-file=$HOME/.config/rag/env -e RAG_QDRANT__URL=http://localhost:6334 \
  -e RAG_GITHUB__WORK_DIR=/work/corpus -v $HOME/rag/corpus:/work/corpus \
  localhost/rag:latest rag-ingest run --source github --full'
```

A full re-embed spends Voyage tokens; a snapshot restore (below) is cheaper if you
only need to recover a lost index.

## Ledger: reconcile now

The ledger index (Qdrant `corpus = ledger`) is reconciled from SQLite by
`rag-ledger-sync.service`. It runs automatically after every ledger write (rag-serve
touches `~/rag/triggers/ledger-reindex`, watched by `rag-ledger-reindex.path`) and on a
15-min backstop timer. To force one:

```bash
make reconcile-ledger                                            # from the dev repo
ssh "$DEPLOY_HOST" systemctl --user start rag-ledger-sync.service # directly
ssh "$DEPLOY_HOST" journalctl --user -u rag-ledger-sync.service -n 30
```

The reconcile is a **pull-based diff** (`topic_id → topic_hash`), so a change made
outside the MCP/HTTP path — a manual `sqlite3` edit, a future CLI — is picked up on the
next run regardless of whether it fired the trigger. Inspect the DB directly:

```bash
ssh "$DEPLOY_HOST" 'sqlite3 ~/rag/ledger/ledger.db "SELECT topic_id, type, status, title FROM topics ORDER BY topic_id"'
```

## Backup the index (+ ledger)

```bash
ssh "$DEPLOY_HOST" 'bash -s' < deploy/backup-qdrant.sh
# -> Qdrant snapshot + a copy of ledger.db, under ~/rag/backups (keeps last 7 of each)
```

The script backs up **both** the Qdrant collection (rebuildable, just saves a re-embed)
**and** `ledger.db` (NOT rebuildable — this is the one that matters). Cron it if desired
(e.g. daily): add a `rag-backup.{service,timer}` modelled on `rag-sync.*`, or a crontab line.

## Restore the ledger DB

```bash
ssh "$DEPLOY_HOST" ls -lh ~/rag/backups/ledger-*.db
ssh "$DEPLOY_HOST" systemctl --user stop rag-serve.service       # release the DB
ssh "$DEPLOY_HOST" 'cp ~/rag/backups/ledger-<STAMP>.db ~/rag/ledger/ledger.db'
ssh "$DEPLOY_HOST" systemctl --user start rag-serve.service
make reconcile-ledger                                            # rebuild the Qdrant ledger points
```

## Restore the index from a snapshot

```bash
# list snapshots / backups
ssh "$DEPLOY_HOST" ls -lh ~/rag/backups ~/rag/qdrant/snapshots/rag_corpus
# put the .snapshot where Qdrant can read it (the snapshots bind mount), then:
ssh "$DEPLOY_HOST" 'curl -fsS -X PUT \
  "http://localhost:6333/collections/rag_corpus/snapshots/recover" \
  -H "content-type: application/json" \
  -d "{\"location\":\"file:///qdrant/snapshots/rag_corpus/<NAME>.snapshot\"}"'
```

(The index is also fully rebuildable from GitHub via `rag-sync` — restore is just
the fast path that skips a re-embed.)

## Rotate the Voyage / GitHub key

```bash
ssh "$DEPLOY_HOST" 'nano ~/.config/rag/env'                      # edit the key
ssh "$DEPLOY_HOST" systemctl --user restart rag-serve.service    # serve picks up new key
# the next rag-sync run picks up the new key automatically (fresh container per run)
```

## Reclaim disk

```bash
ssh "$DEPLOY_HOST" bash ~/rag/src/deploy/prune-images.sh   # dangling + unused images
ssh "$DEPLOY_HOST" podman system df                         # what's using space
# corpus clones (re-clonable) and old backups are the other big consumers:
ssh "$DEPLOY_HOST" du -sh ~/rag/corpus ~/rag/backups ~/rag/qdrant
```

## Bootstrap a fresh box (order)

1. `loginctl enable-linger <user>`; create `~/rag/{qdrant/{storage,snapshots},corpus,backups,ledger,triggers}`.
2. Install + start Qdrant (see `README.md`), then `cargo run -p rag-ingest -- init` from dev to create the collection (incl. the ledger `type`/`status`/`topic_id` payload indexes).
3. Populate `~/.config/rag/env` — `VOYAGE_API_KEY`, `GITHUB_TOKEN`, and **`RAG_GITHUB__ACCOUNT`** (required; an empty account purges the corpus), plus `RAG_EMAIL` for HTTP-gateway ledger attribution.
4. `./deploy/deploy.sh` (builds the image, runs `init`, starts `rag-serve`, enables the corpus + ledger timers and trigger watchers).
5. `ssh "$DEPLOY_HOST" systemctl --user start rag-sync.service` to fill the index (or wait for the timer). The ledger starts empty and fills as agents log to it.
