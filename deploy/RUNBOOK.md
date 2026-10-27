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
| Tracker reconcile | server | `rag-tracker-sync.{service,timer}` + `rag-tracker-reindex.path` | `localhost/rag:latest` (`rag-ingest reconcile-tracker`) | — |
| Retrieval API + ledger CRUD + tracker API + web UI | server | `rag-serve.service` (Quadlet) | `localhost/rag:latest` (`rag-serve`) | 17793 |
| MCP gateway (Streamable HTTP) | server | `rag-mcp.service` (Quadlet) | `localhost/rag:latest` (`rag-mcp --transport http`) | 17794 |
| MCP server (stdio) | **dev / client box** | none (stdio subprocess) | local release binary | — |
| Same-box backup (Qdrant snapshot, ledger + tracker DBs → `~/rag/backups`) | server | `rag-backup.{service,timer}` (00:00 UTC) | none (host script `deploy/backup-qdrant.sh`) | — |
| Off-box backup (ledger + tracker DBs, attachments → S3) | server | `rag-backup-offbox.{service,timer}` (01:33 UTC) | none (host script `deploy/backup-offbox.sh`) | — |

The **ledger** is a SQLite DB at `~/rag/ledger/ledger.db` (the **source of truth** for
decisions/incidents/defects/investigations). `rag-serve` owns writes (`POST /ledger*`);
`rag-ingest reconcile-ledger` derives the searchable `corpus = ledger` points in Qdrant.
Unlike the corpus index, **the ledger DB cannot be rebuilt from elsewhere — back it up.**

The **tracker** (`specs/tracker/`) is a second SQLite DB at `~/rag/tracker/tracker.db`
with its attachments under `~/rag/tracker/attachments/` (one file per sha256, as
`<sha[0..2]>/<sha>`), bind-mounted into `rag-serve` at `/tracker` (`RAG_TRACKER__DB_PATH`,
`RAG_TRACKER__ATTACHMENTS_DIR`). It is the **source of truth** for every project's queue,
specs and concepts, which no longer live in the repositories, so it is as irreplaceable as
the ledger. `rag-serve` owns every write (`POST /tracker/…`, contract in
`specs/tracker/api.md`); `deploy.sh` creates the directory. If the store cannot open,
`/tracker/…` answers 503 and `/info` reports `"tracker_ready": false`; the rest of the
service is unaffected. Check a project's queue is sound with
`curl http://localhost:17793/tracker/<project>/check` (`"ok": true`).

**`rag-mcp` has two transports — pick by where the client runs.** Both are thin
**HTTP clients of `rag-serve`** and hold **no key**.

- **Streamable HTTP gateway (`--transport http`, on the server).** One long-lived
  service (`rag-mcp.service`, port **17794**) exposing **every** tool set under
  distinct paths — `/corpus`, `/ledger` and `/tracker`. Remote clients register
  URLs and need **no local binary**:

  ```bash
  claude mcp add --transport http rag     http://your-server:17794/corpus
  claude mcp add --transport http ledger  http://your-server:17794/ledger
  claude mcp add --transport http tracker http://your-server:17794/tracker
  ```

  Caveat — **ledger attribution**: a shared server has no client git context, so
  writes are stamped with the gateway's `RAG_EMAIL`/`RAG_AGENT` (set in
  `rag-mcp.container`), `ledger_create` needs an explicit `repo` arg and every
  tracker tool an explicit `project`, and tracker attachments travel as base64 (at
  most 10 MB) rather than local files. Fine for a single-operator estate; for a workstation that authors a lot of ledger entries,
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
  claude mcp add tracker --scope user --env RAG_SERVE_URL=http://your-server:17793 \
    --env RAG_AGENT=Unknown -- /path/to/rag/target/release/rag-mcp --server tracker
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
RAG_BACKUP__S3_URI=s3://rag-atlas-backups/atlas   # the off-box backup's destination
RAG_BACKUP__AWS_PROFILE=default           # the AWS CLI profile (in ~/.aws) it uploads with
RAG_BACKUP__AWS_REGION=ap-southeast-4
```

The three `RAG_BACKUP__*` entries are not secrets and **no AWS key goes in this file**:
`backup-offbox.sh` runs on the host as this user and the AWS CLI takes the credentials
from the named profile in `~/.aws`. They are read by the script, not by the containers
(which receive them through `--env-file` and ignore them: the config loader has no
`backup` section and rejects no unknown key). Without `RAG_BACKUP__S3_URI`, `deploy.sh`
leaves `rag-backup-offbox.timer` disabled and says so.

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
check `rag-sync.service` logs. `"points": null` means `rag-serve` could not reach
Qdrant: `/info` still answers 200 (the readiness flags, the ledger and the tracker
are unaffected), `qdrant_error` gives the reason, and retrieval is down until
`qdrant.service` is back. `deploy.sh`'s health step passes then but prints a warning.

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

The ledger reconcile has its own breaker, `~/rag/ledger/.rag-ledger-breaker.json`, and
the tracker reconcile its own, `~/rag/tracker/.rag-tracker-breaker.json`; delete one to
retry immediately.

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

## Tracker: reconcile now

The tracker's documents and queue items (Qdrant `corpus = tracker`, what
`search_corpus` with `corpus: "tracker"` finds) are reconciled from `tracker.db` by
`rag-tracker-sync.service`. It runs automatically after every successful tracker write
(rag-serve touches `~/rag/triggers/tracker-reindex`, watched by
`rag-tracker-reindex.path`) and on a 15-min backstop timer (`:11/15`). To force one:

```bash
make reconcile-tracker                                             # from the dev repo
ssh "$DEPLOY_HOST" systemctl --user start rag-tracker-sync.service # directly
ssh "$DEPLOY_HOST" journalctl --user -u rag-tracker-sync.service -n 30
```

Like the ledger's, it is a pull-based diff (`tracker_id → tracker_hash`, one unit per
document or item): only what changed is embedded, an edited or renamed document's points
are replaced (none of the old revision or path survive), and a unit gone from the store is
purged. Its summary line counts documents and items, and the units it changed, removed and
persisted. A burst of writes (a manager loading a project) costs one run, not one per write.

## Backup the index (+ ledger + tracker)

```bash
ssh "$DEPLOY_HOST" 'bash -s' < deploy/backup-qdrant.sh
# -> Qdrant snapshot + copies of ledger.db and tracker.db, under ~/rag/backups (keeps last 7 of each)
```

The script backs up the Qdrant collection (rebuildable, just saves a re-embed) **and**
`ledger.db` and `tracker.db` (NOT rebuildable — these are the ones that matter), each with
`sqlite3 .backup` when `sqlite3` is installed. **This is a same-box copy**: it survives a
bad write or a corrupted file, not a lost disk; the off-box copy is the next section. The
attachments are not copied here (content-addressed and never rewritten, so a second copy on
the same disk adds nothing). `rag-backup.timer` runs it daily at 00:00 UTC (+ up to 15 min).

**Install `sqlite3` on the server** (`apt install sqlite3`). Without it the script falls
back to a raw copy of a live WAL database, which can miss committed transactions still in
the WAL. Until 2026-10-27 atlas had no `sqlite3` on the systemd PATH (only the Android
SDK's, which interactive shells see), so the nightly timer's copies were raw ones; the
distro package is installed now.

## Off-box backups (S3)

`deploy/backup-offbox.sh`, run nightly at **01:33 UTC** by `rag-backup-offbox.timer`
(clear of `rag-backup` at 00:00, js_web's atlas backups at 03:00 and the sync timers'
minutes; `Persistent=true` catches a night the box was down). Per database (`tracker`,
`ledger`) it takes a `sqlite3 .backup` of the live file (never a raw copy), runs
`PRAGMA integrity_check` on the copy, writes a manifest (sha256 and size of the copy, the
row count of every table, the time), compresses with `zstd -10` and uploads:

```
s3://rag-atlas-backups/atlas/
  db/daily/<db>-<YYYYMMDD>.db.zst  + .json   newest 7 kept (pruned by the script)
  db/weekly/<db>-<GGGG>-W<VV>.db.zst + .json the first copy of each ISO week; newest 4 kept
  attachments/<sha[0..2]>/<sha256>           synced by hash; never deleted
```

A run on a day that already has a copy replaces that day's copy (the bucket keeps the old
one as a noncurrent version). Attachments: a blob is uploaded only when its name is not in
the bucket yet, after its bytes are checked against its name (a mismatch fails the run and
is not uploaded); in-flight `.tmp` files are skipped. One run at a time (`flock`).

**The bucket**: `rag-atlas-backups`, ap-southeast-4 (Melbourne), created 2026-10-27 with
the AWS CLI's `default` profile: private (all four public-access
blocks, bucket-owner-enforced ownership), versioning on, SSE-S3 (AES256, bucket key)
default encryption, and a lifecycle expiring noncurrent versions 30 days after they become
noncurrent (plus expired delete markers) and aborting incomplete multipart uploads after 7
days, as js_web's `js-web-atlas-backups`. So a pruned or overwritten copy stays recoverable
for 30 days: a second net under the 7 + 4 retention. Not in any Terraform; recreate it with:

```bash
P="--profile default --region ap-southeast-4"; B=rag-atlas-backups
aws $P s3api create-bucket --bucket $B --create-bucket-configuration LocationConstraint=ap-southeast-4 --object-ownership BucketOwnerEnforced
aws $P s3api put-public-access-block --bucket $B --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws $P s3api put-bucket-versioning --bucket $B --versioning-configuration Status=Enabled
aws $P s3api put-bucket-encryption --bucket $B --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
aws $P s3api put-bucket-lifecycle-configuration --bucket $B --lifecycle-configuration '{"Rules":[{"ID":"expire-noncurrent-30d","Status":"Enabled","Filter":{},"NoncurrentVersionExpiration":{"NoncurrentDays":30},"Expiration":{"ExpiredObjectDeleteMarker":true}},{"ID":"abort-incomplete-mpu-7d","Status":"Enabled","Filter":{},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}}]}'
```

**Credentials**: the AWS CLI profile named by `RAG_BACKUP__AWS_PROFILE` (`default` on
atlas, the owner's IAM user); no key is stored in `~/.config/rag/env`. The host needs
`aws` (CLI v2), `sqlite3` and `zstd`.

```bash
ssh "$DEPLOY_HOST" systemctl --user start rag-backup-offbox.service     # run it now
ssh "$DEPLOY_HOST" systemctl --user status rag-backup-offbox.service    # a failed run shows failed
ssh "$DEPLOY_HOST" journalctl --user -u rag-backup-offbox.service -n 40 # what it did, or why not
aws --profile default s3 ls --recursive s3://rag-atlas-backups/atlas/db/
bash deploy/test-offbox.sh   # 29 checks against a throwaway prefix (test/…), cleaned up after
```

**First run, 2026-10-27 11:16 UTC** (through the service): `tracker.db` 294,912 bytes →
40,281 compressed (81 items, 213 events); `ledger.db` 44,359,680 bytes → 9,021,836
(7,086 topics, 13,698 events); 0 attachments (none uploaded yet). About 9.1 MB a night in
all, 30 s of CPU, of which the ledger's `zstd -10` is most.

## Restore from S3

The live directories are only ever written with `rag-serve` stopped, and the old WAL and
shared-memory files are removed first: a `-wal` left beside a restored database is
replayed onto it when it is next opened (and `rag-serve` is SIGKILLed after its 10 s stop
timeout, so its WAL is not always checkpointed away).

```bash
# 1. fetch and verify into a scratch directory (newest daily copy; or give a stamp:
#    YYYYMMDD for a daily, GGGG-Www for a weekly). Checks each DB's sha256 and row counts
#    against the manifest written at backup time, and PRAGMA integrity_check; checks every
#    attachment against its name. Refuses the live directories.
ssh "$DEPLOY_HOST" 'bash ~/rag/src/deploy/restore-offbox.sh ~/rag-restore'
# 2. stop the writer, keep what is there, put the restored files in place
ssh "$DEPLOY_HOST" systemctl --user stop rag-serve.service rag-mcp.service
ssh "$DEPLOY_HOST" 'set -e; t=$(date -u +%Y%m%dT%H%M%SZ)
  for d in ledger tracker; do mkdir -p ~/rag/pre-restore-$t/$d; mv ~/rag/$d/$d.db* ~/rag/pre-restore-$t/$d/ 2>/dev/null || true; done
  cp ~/rag-restore/ledger/ledger.db ~/rag/ledger/ledger.db
  cp ~/rag-restore/tracker/tracker.db ~/rag/tracker/tracker.db
  cp -rn ~/rag-restore/tracker/attachments/. ~/rag/tracker/attachments/'
# 3. start, check, and bring the derived Qdrant points back in line
ssh "$DEPLOY_HOST" systemctl --user start rag-serve.service rag-mcp.service
curl -s http://<server>:17793/info                               # tracker_ready true
curl -s http://<server>:17793/tracker/<project>/check            # "ok": true for each project
make reconcile-ledger
make reconcile-tracker
```

On a fresh box (the disk is gone) do the bootstrap first, then this; `~/rag/backups` and
the Qdrant collection come back from `deploy/backup-qdrant.sh`'s next run and `rag-sync`.
`cp -rn` adds attachments without overwriting any (a blob's name is its hash, so an
existing one is already right). Remove `~/rag-restore` and `~/rag/pre-restore-*` once the
restored service has been checked.

**Rehearsed 2026-10-27 11:17 UTC** into a scratch directory (`/tmp/…/rag`), from the first
run's daily copies, in 15 s: both databases' sha256 matched their manifests,
`integrity_check` ok, and every table's row count matched the manifest (tracker: items
81, events 213, item_links 54, projects 2, the rest 0 bar sqlite_sequence 1; ledger:
topics 7,086, events 13,698, links 220, moves 10). Cross-checked against the live files
afterwards: the live ledger holds exactly 13,698 events up to the restored copy's newest
(event_id 13,698), and the live tracker 213 events up to its newest. Both refusals held
(the live `~/rag/tracker` as destination; a destination already holding a database).
Steps 2 and 3 were not run against the live service (not a drill to take the tracker
down for); `deploy/test-offbox.sh` covers the weekly path, the attachments and the
sha256/row-count refusals on synthetic data.

## Restore the ledger DB

```bash
ssh "$DEPLOY_HOST" ls -lh ~/rag/backups/ledger-*.db
ssh "$DEPLOY_HOST" systemctl --user stop rag-serve.service       # release the DB
ssh "$DEPLOY_HOST" 'rm -f ~/rag/ledger/ledger.db-wal ~/rag/ledger/ledger.db-shm && cp ~/rag/backups/ledger-<STAMP>.db ~/rag/ledger/ledger.db'
ssh "$DEPLOY_HOST" systemctl --user start rag-serve.service
make reconcile-ledger                                            # rebuild the Qdrant ledger points
```

## Restore the tracker DB

```bash
ssh "$DEPLOY_HOST" ls -lh ~/rag/backups/tracker-*.db
ssh "$DEPLOY_HOST" systemctl --user stop rag-serve.service       # release the DB
ssh "$DEPLOY_HOST" 'rm -f ~/rag/tracker/tracker.db-wal ~/rag/tracker/tracker.db-shm && cp ~/rag/backups/tracker-<STAMP>.db ~/rag/tracker/tracker.db'
ssh "$DEPLOY_HOST" systemctl --user start rag-serve.service
curl -s http://<server>:17793/tracker/<project>/check            # "ok": true for each project
make reconcile-tracker                                           # bring corpus = tracker back in line
```

The attachments directory is not part of the same-box backup and needs no restore after a
bad write: a restored DB refers to files by hash, and files are never deleted. After a lost
disk, they come back from S3 ("Restore from S3").

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

1. `loginctl enable-linger <user>`; create `~/rag/{qdrant/{storage,snapshots},corpus,backups,ledger,triggers,prompts,tracker/attachments}`. (`deploy.sh` creates the trigger, ledger, prompts and tracker dirs itself; the rest are yours.)
2. Install + start Qdrant (see `README.md`), then `cargo run -p rag-ingest -- init` from dev to create the collection (incl. the ledger and tracker `type`/`status`/`topic_id`/`tracker_id` payload indexes).
3. Populate `~/.config/rag/env` — `VOYAGE_API_KEY`, `GITHUB_TOKEN`, and **`RAG_GITHUB__ACCOUNT`** (required; an empty account purges the corpus), plus `RAG_EMAIL` for HTTP-gateway ledger attribution and, optionally, `ANTHROPIC_API_KEY` for the UI's Summarise tab. For the off-box backup, `RAG_BACKUP__S3_URI`, `RAG_BACKUP__AWS_PROFILE` and `RAG_BACKUP__AWS_REGION`, with that AWS CLI profile configured in `~/.aws` and `sqlite3` and `zstd` installed (`apt install sqlite3 zstd`).
4. `./deploy/deploy.sh` (builds the image — Rust binaries **and** the web bundle, so the box needs crates.io and the npm registry — runs `init`, starts `rag-serve`, enables the corpus, ledger and tracker timers and trigger watchers, the same-box backup timer and, when `RAG_BACKUP__S3_URI` is set, the off-box one).
5. `ssh "$DEPLOY_HOST" systemctl --user start rag-sync.service` to fill the index (or wait for the timer). The ledger starts empty and fills as agents log to it.
6. Open `http://<server>:17793/` — the ledger UI. It has nothing to show until step 5's ledger fills, but the shell loading confirms the bundle shipped.
