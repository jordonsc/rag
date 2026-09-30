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
| Retrieval API + ledger CRUD + web UI | server | `rag-serve.service` (Quadlet) | `localhost/rag:latest` (`rag-serve`) | 17793 |
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

## Ledger web UI

`rag-serve` also serves the ledger viewer at **`http://<server>:17793/`** — the same
port and the same origin as the JSON API, so there is no CORS to configure and none
should be added. The API paths (`/health`, `/info`, `/search`, `/reindex`, `/ledger*`)
are excluded from the single-page fallback, so a mistyped endpoint still answers a
JSON 404 rather than an HTML document. There is no auth on it, exactly as there is
none on the API: it is a trusted-LAN tool, and anyone who can reach the port can
write to the ledger.

**The bundle is baked into the image.** The Node stage in `Containerfile` runs
`npm ci && npm run build` over `web/` and the runtime stage copies the result to
`/usr/local/share/rag/web`, which is what `RAG_SERVER__WEB_ROOT` in
`rag-serve.container` points at. Two consequences worth internalising:

- A UI change needs a **redeploy** (`./deploy/deploy.sh`, which rebuilds the image),
  **not** a `systemctl --user restart` — a restart re-runs the same bundle.
- An already-open browser tab does pick the new bundle up: assets are content-hashed
  and served `immutable`, while `index.html` revalidates on every navigation. Nobody
  needs to be told to press ctrl-shift-R.

**To turn it off:** empty (or delete) the `Environment=RAG_SERVER__WEB_ROOT=…` line in
**`deploy/rag-serve.container` in the repo** and redeploy. An empty web root disables
static serving entirely and `rag-serve` runs as the JSON API alone. Editing the unit
only on the server works until the next `deploy.sh`, which reinstalls it from the repo.

The image itself needs no change to do that — the same one serves the API alone when
the web root is empty. Nor is a missing bundle an error: `rag-serve` logs a warning at
startup and carries on. `/health` is green either way, which is why `deploy.sh` reports
a missing UI as a warning rather than failing the deploy.

## Saved Summarise prompts

The Summarise tab's system prompt can be chosen from a small library. **A prompt is a
plain Markdown file**: `~/rag/prompts/Terse.md` is the prompt named "Terse", bind-mounted
into the container at `/prompts` (`RAG_SERVER__PROMPTS_DIR`). There is no database and no
metadata, so the UI's chooser and a text editor are two views of the same directory:

```bash
ssh "$DEPLOY_HOST" ls ~/rag/prompts                       # what the chooser will offer
ssh "$DEPLOY_HOST" cat ~/rag/prompts/Terse.md             # one prompt
ssh "$DEPLOY_HOST" rm ~/rag/prompts/Terse.md              # same as Delete in the UI
```

- **`~/rag/prompts`, not `~/.config/rag/prompts`** — that directory holds the secrets env
  file, and bind-mounting it would put the secrets on the container filesystem for no gain.
- **The built-in default prompt needs no file.** It is a constant in the binary served to
  the UI by `/info`, always offered, never deletable, and never written here. An empty or
  missing directory means the library is empty and only the built-in is offered — a
  fallback, not something to seed.
- **To turn the library off:** empty (or delete) the `Environment=RAG_SERVER__PROMPTS_DIR=…`
  line in `deploy/rag-serve.container` **in the repo** and redeploy. The UI then offers the
  built-in alone and `POST /prompts/save` / `/prompts/delete` answer 503. Nothing else
  changes and no startup fails.
- A name may hold only letters, digits, spaces, `-` and `_` (≤ 64 characters); bodies are
  capped at 32 KiB and the library at 200 prompts. A file that breaks those rules — a
  `.txt`, a dotted name, a symlink — is ignored by the listing rather than offered as
  something the UI could not save back.

## Secrets + required config

`~/.config/rag/env` on the server (chmod 600), delivered to units via `EnvironmentFile`
/ `--env-file`. Never in an image or the repo.

```
VOYAGE_API_KEY=...
GITHUB_TOKEN=...
RAG_GITHUB__ACCOUNT=your-github-account   # REQUIRED: the account whose repos are indexed
RAG_EMAIL=you@example.com                 # ledger author for writes over the HTTP gateway
ANTHROPIC_API_KEY=...                     # OPTIONAL: the web UI's Summarise tab
```

`RAG_GITHUB__ACCOUNT` is not a secret but lives here because the containers ship no
`rag.toml` — an empty account selects 0 repos and the reconcile purges the corpus.

`ANTHROPIC_API_KEY` is the one **optional** entry. It enables
`POST /ledger/{id}/summarise` and the Summarise tab in the web UI; without it that
route answers 503 (`summarise_ready: false` on `/info`) and nothing else is affected.
`rag-serve` logs which state it started in. Deliberately **not** in `deploy.sh`'s
preflight guard: that guard is there because a missing `RAG_GITHUB__ACCOUNT` purges the
corpus, and failing a deploy over a switched-off feature would be the wrong trade.
Adding or removing it takes effect on `systemctl --user restart rag-serve.service`,
with no re-index and no rebuild — the key is read once at startup.

Nothing about a summary is stored: there is no cache, no summaries table and no
backfill, so every press of Go is one billed call (~1p). The response carries its own
token counts, and `journalctl --user -u rag-serve.service` logs them per run.

## Deploy a new version

From the dev repo root — one command (ship → build → install units → restart →
retire the superseded image → health-check):

```bash
./deploy/deploy.sh
```

It rsyncs source to `$DEPLOY_HOST:~/rag/src`, builds `localhost/rag:latest`, installs the
unit files, restarts `rag-serve`, reloads `rag-sync.timer`, keeps the replaced image as
`localhost/rag:previous` (removing the one before it, by id — never a blanket
`podman image prune`, which on a shared box deletes other projects' images), and
verifies `/health` + `/info` + that `/` returns the UI. Idempotent.

### When the dev box IS the server

On a single-box estate there is nothing to ssh to — or rather, ssh-ing to yourself
means the box must hold a key authorising a login to itself, an account added purely
to arrive back where it started. Use the local entry point instead:

```bash
./deploy/deploy-local.sh
```

Same steps, no ssh/scp hop. It is **not** a second implementation: it sets
`DEPLOY_HOST=local` and execs `deploy.sh`, whose `run`/`put` helpers then execute
here rather than over a connection — one list of deploy steps, so the two paths
cannot drift. `deploy.sh` also takes the local path on its own when `$DEPLOY_HOST`
matches this machine's `hostname -s`/`-f`; the wrapper exists so the intent is
explicit and so the deploy does not depend on `deploy.env` naming the right host.

An explicit `DEPLOY_HOST` in the environment beats `deploy/deploy.env`.

The rsync carries `web/` along with the crates but skips `node_modules/` and `dist/`
(as it already skips `target/`) — the image builds the SPA itself, so shipping either
would be megabytes of files the build discards. **The build therefore needs the npm
registry as well as crates.io** from the server. Rust and Node are separate stages
with separate inputs, so a crate-only change re-runs neither `npm ci` nor the bundle,
and a UI-only change does not recompile the workspace; the first build after a
dependency change is the expensive one.

## Rollback

Each deploy keeps the image it replaced as `localhost/rag:previous`. The fast
rollback is to re-point `:latest` at it and restart:

```bash
podman tag localhost/rag:previous localhost/rag:latest
systemctl --user restart rag-serve.service rag-mcp.service   # the sync units pick it up per run
```

Only one step back is kept. Further back, redeploy the prior git revision:

```bash
git checkout <prev-sha> && ./deploy/deploy.sh && git checkout -
```

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
ssh "$DEPLOY_HOST" curl -fsS http://localhost:17793/          # -> the UI's index.html (a JSON 404 means no bundle)
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

### The sync keeps failing: the circuit breaker

When the same pending work fails the same way three runs in a row, the indexer
stops attempting it and every later run exits non-zero with `CIRCUIT BREAKER OPEN`
in the journal — **no embedding spend** until the pending files or the config
change. Removed files and archived repos are still purged; only paid work waits.

```bash
journalctl --user -u rag-sync.service -n 50 | grep -iE 'breaker|error'
cat ~/rag/corpus/.rag-ingest-breaker.json            # the work's fingerprint + the error
```

Fix the cause (a file to add to that repo's `.ragignore`, a config value, a key),
then either push — changed inputs close the breaker — or retry by hand with
`rag-ingest run --source github --force` (the full-re-embed `podman run` above
with `--force` in place of `--full`), or delete the state file. A failed run
keeps every file it finished, so a retry pays only for what is left.

The ledger reconcile has its own breaker, `~/rag/ledger/.rag-ledger-breaker.json`;
delete it to retry immediately.

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
ssh "$DEPLOY_HOST" bash ~/rag/src/deploy/prune-images.sh   # ALL unused images — only on a box nothing else uses
ssh "$DEPLOY_HOST" podman system df                         # what's using space
# corpus clones (re-clonable) and old backups are the other big consumers:
ssh "$DEPLOY_HOST" du -sh ~/rag/corpus ~/rag/backups ~/rag/qdrant
```

## Bootstrap a fresh box (order)

1. `loginctl enable-linger <user>`; create `~/rag/{qdrant/{storage,snapshots},corpus,backups,ledger,triggers,prompts}`. (`deploy.sh` creates the trigger, ledger and prompts dirs itself; the rest are yours.)
2. Install + start Qdrant (see `README.md`), then `cargo run -p rag-ingest -- init` from dev to create the collection (incl. the ledger `type`/`status`/`topic_id` payload indexes).
3. Populate `~/.config/rag/env` — `VOYAGE_API_KEY`, `GITHUB_TOKEN`, and **`RAG_GITHUB__ACCOUNT`** (required; an empty account purges the corpus), plus `RAG_EMAIL` for HTTP-gateway ledger attribution and, optionally, `ANTHROPIC_API_KEY` for the UI's Summarise tab.
4. `./deploy/deploy.sh` (builds the image — Rust binaries **and** the web bundle, so the box needs crates.io and the npm registry — runs `init`, starts `rag-serve`, enables the corpus + ledger timers and trigger watchers).
5. `ssh "$DEPLOY_HOST" systemctl --user start rag-sync.service` to fill the index (or wait for the timer). The ledger starts empty and fills as agents log to it.
6. Open `http://<server>:17793/` — the ledger UI. It has nothing to show until step 5's ledger fills, but the shell loading confirms the bundle shipped.
