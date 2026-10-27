m05: search, and the trial
==========================
**State: Built** (2026-10-27): TS-01 to TS-04 done, tested, lint-clean, not deployed. TS-02's web UI filter moved
to m04 (the manager's call). Acceptance 1 waits for the release (a live reconcile against Qdrant and Voyage);
acceptance 2 is the trial itself, with the owner. Spec: [`master.md`](master.md),
D13, R15, R16.


Work items
----------
| WP | Work | Size | Files |
|---|---|---|---|
| TS-01 | **`corpus = tracker`** (D13): a reconcile in the style of `ledger_reconcile` (token-safe batches, the circuit breaker, incremental): each document chunked by the markdown chunker with its project, path, kind, title and revision; each item one point (title, body, notes, status, type); stale points purged when a document is edited, renamed or an item changes. Triggered after tracker writes as the ledger's is, and by the timer | M | `crates/ingest/src/tracker_reconcile.rs` (new), `crates/core` (the corpus enum and payload), `crates/serve` (the trigger) |
| TS-02 | **Search surfaces**: `search_corpus` takes `corpus: "tracker"`; a result cites `<project>:<path>@r<revision>` or the item id; the MCP tool's description names the corpus; the web UI's search can filter to it | S | `crates/mcp`, `crates/serve`, `web/app` |
| TS-03 | **Docs**: `README.md`, `user-claude.md` (search the tracker before re-planning work), `deploy/RUNBOOK.md` (`make reconcile-tracker`) | S | as listed |
| TS-04 | **The trial** (R16): the owner tells the first project's manager the tracker is ready; it loads the project's in-flight and queued work, the specs and concepts it is working from, and their attachments, through the MCP tools. This milestone's agent writes the **hand-over brief** the manager follows (what to load, the paths to keep, how to record approvals already given, what to leave in git), and records what the trial found (friction, missing tools, refusals) as follow-up items in the tracker's own project | S | `specs/tracker/trial-brief.md` (new) |


Tests
-----
* A document edit replaces its points (none left from the old revision); a rename moves them; an item's status
  change updates its point.
* A `search_corpus` call with `corpus: "tracker"` returns a fixture document's chunk with its citation.


Acceptance
----------
1. A phrase from a concept written in m04 is found by `search_corpus` with `corpus: "tracker"` within one
   reconcile.
2. The first project's queue, specs and concepts are in the tracker, its manager works from `tracker_queue`, and the
   owner reorders its queue from the dashboard.


As built
--------
2026-10-27. Ledger rag-0043 (the point layout), rag-0044 (the sync's repo purge), rag-0045 (`body_path`), rag-0046
(R14 against ubu's art pipeline).

**TS-01, the reconcile.** `rag-ingest reconcile-tracker` (`crates/ingest/src/tracker_reconcile.rs`, tests in
`tracker_reconcile/tests.rs`), reading `TrackerStore::all_for_index` (`crates/core/src/tracker/index.rs`: every
document at its current revision and every item with its notes, in one read transaction). A **unit** is one document
or one item; its `tracker_id` (`ubu-d0007`, `ubu-t0042`) and `tracker_hash` drive the diff, as `topic_id` and
`topic_hash` do for the ledger. Token-safe batches, each unit written the moment its vectors arrive and its stale
points pruned only after, a breaker beside `tracker.db` (`.rag-tracker-breaker.json`), units gone from the store
purged. The reconcile is generic over a `TrackerIndex` trait (Qdrant in production), so its tests run a real
temporary store against an in-memory index and a fake embedder: no Qdrant, no Voyage. Choices:

* **No `path` or `file_hash` on tracker points.** Those are the corpus sync's keys: an unscoped `rag-ingest run`
  would have taken every tracker point for a deleted file and purged it. `tracker_id` is a new keyword index
  (`rag-ingest init` adds it; deploy step 4 runs `init`).
* **Point ids are keyed on the unit's id, not its path**, so an edit or a rename overwrites the same points and the
  prune removes the tail. The unit hash includes an `INDEX_FORMAT` version: changing how points are built re-indexes
  every unit on the next run.
* **A document chunk's text starts with a heading line**, `<title> · <project>:<path>`, so a chunk from deep inside a
  long spec says what it is part of, to the embedder and to the reader. Its `start_line`/`end_line` are the chunk's
  lines in the body (`Chunker::chunk_text_lines`). An empty document is one point of that heading, so it settles
  instead of being "changed" every run.
* **An item is one point** (title; `<project> <id> · <type> · <status>`; body; `Notes:`), chunked only if it
  outgrows a chunk. Its notes are the bodies of its `note`, `status`, `block`, `unblock` and `approve` events; the
  generated bodies of other events ("Set title, body.") add nothing the item's text lacks. **Every item is indexed**,
  done and cancelled ones included (D14: they "remain in history and in search"); `status` and `type` are filterable
  payload fields.
* **`rel_path` is the document's path, or the item's id**, so `path_prefix` works on documents and leaves items out.
* **No collapse by unit in retrieval**: code hits are not collapsed per file either; the ledger's topic collapse is
  untouched.
* **The trigger** is a middleware on the tracker router: any `POST` answered 2xx touches
  `server.tracker_reindex_trigger` (`RAG_SERVER__TRACKER_REINDEX_TRIGGER=/triggers/tracker-reindex` in the unit); a
  `GET` or a refused write does not. Units `deploy/rag-tracker-sync.{service,timer}` (timer at `:11/15`, offset from
  the corpus `:0/15` and the ledger `:7/15`) and `rag-tracker-reindex.path`; `deploy.sh` installs and enables them and
  creates the trigger file; `make reconcile-tracker`.
* **Found on the way, fixed (rag-0044):** `VectorStore::delete_by_repo`, which the corpus sync runs for every archived
  or excluded repo on every run, deleted every corpus's points for that name, so a ledger project named like an
  archived repo was purged every 15 minutes and re-embedded by its reconcile. It now deletes `code` and `wiki` points
  only.

**TS-02, the search surfaces.** `Corpus::Tracker` (`"tracker"`) in `core::model`; `POST /search` takes it (its 400
names the four corpora); `search_corpus`'s description, its `corpus` argument and the corpus server's instructions
name it, and the tracker server's instructions point at it. A hit carries `citation` (`<project>:<path>@r<revision>`,
or the item id), `tracker_id`, `kind`, `revision`, `title`, and for items `type` and `status`, all mapped from the
payload by one function (`hit_from_payload`) shared by every corpus. **The web UI's filter is m04's** (the manager
moved it; `web/` was not touched): the contract it needs is [`api.md`](api.md) § *Search (m05)*, and the change is a
corpus value on a route that already takes it.

**TS-03, the docs.** `README.md` (*What it does*, *Architecture*, *Run*, *Tracker* § Search), `user-claude.md`
(search the tracker before re-planning work; tracker citations; `body_path`), `deploy/RUNBOOK.md` (*Tracker: reconcile
now*, the breaker, the restore), `deploy/README.md` (*Ledger and tracker reconciles*, the payload indexes),
`rag.toml.example` (the two triggers), `CLAUDE.md` (*Where things live*), [`api.md`](api.md) § *Search (m05)*.

**TS-04, the brief.** [`trial-brief.md`](trial-brief.md), written against ubu's tree: what to load (every spec and
concept markdown file, live and archived), the paths to keep (milestone `name` for the file name; a create then a
rename where the tracker's naming cannot produce the repository's path: the inception index, nested and archived
concepts), the queue from the manager's scratch files, approvals already given (`owner` and `agent`, each note citing
where), attachments, what stays in git, a byte-level check that keeps documents out of the agent's context, and how
to file friction as items in the `rag` project (three known before the first call). Two findings changed the build:

* **`body_path` on `tracker_create` (and each milestone in it) and `tracker_doc_edit`** (rag-0045). ubu's specs are
  about 4 MB of markdown with files over 200 KB: as a pasted `body`, each would cost twice its size in context and the
  largest would not fit in one call, so the brief could not have been followed through the MCP tools. The stdio
  server reads the file (UTF-8, at most 4 MB); with `body`, or over the gateway, it is refused.
* **R14 meets a pipeline** (rag-0046): ubu's `concepts/art/` is read and written by its art tooling and `review/` is
  the owner's review inbox, so the brief keeps both in git and attaches only the images a loaded document names. The
  manager files it for the owner at the start of the trial.

**Tests.** `rag-ingest`: the reconcile (indexed with citations and line ranges; an unchanged store embeds nothing; an
edit leaves no point of the old revision; a rename leaves nothing at the old path; a status change and a note rewrite
the item's point in place; a unit gone from the store is purged; a failed embed keeps the old points; an empty
document settles; the item text) and `chunk_text_lines`. `rag-core`: the snapshot (current body, item notes without
generated bodies), the payload-to-hit mapping with its citation, the repo purge's filter, the point ids. `rag-serve`:
`/search` takes `tracker` and refuses an unknown corpus; a successful write touches the trigger, a read and a refused
write do not. `rag-mcp`: `search_corpus` with `corpus: "tracker"` sends the filter and returns the fixture document's
chunk with its citation (against a stand-in `rag-serve`); the description names the corpus; `body_path` reads the
file and is refused with `body`, over the gateway, unreadable or not UTF-8.

**Not done here.** Acceptance 1 needs the release: a live reconcile against Qdrant and Voyage, then a concept
phrase found within one reconcile. The optional Skill (`skill/corpus-search`) still offers `--corpus code|wiki`
only, as it did before the ledger.


### Addendum, 2026-10-27: labels in the index (rag-t0027)

An item's text (`item_text`) carries a `Labels: Physics, Biomes` line after its `<project> <id> · <type> ·
<status>` line, **only when it has labels**; `ItemForIndex` gained `labels` (read in the snapshot's one
transaction). `INDEX_FORMAT` is **not** bumped (rag-0064): the unit hash is taken over the text, so an unlabelled
item's text and hash are what they were and its point is not rewritten, while a labelled item, and every later
label change, re-indexes by its own hash. Bumping would have re-embedded the whole tracker corpus for no change in
any unlabelled point. Labels are not a payload field (no filter by label in search; the API's `?label=` serves
that). Test: `item_text_carries_its_labels_only_when_it_has_some`.
