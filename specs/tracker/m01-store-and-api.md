m01: the store and the HTTP API
===============================
**State: Done** (2026-10-27): built, tested, lint-clean; acceptance 2 and 3 (on the deployed server) wait for the
release. Spec: [`master.md`](master.md), D1–D11, D18. **The HTTP contract is [`api.md`](api.md).**

*Written before rag-t0050 (2026-10-28) named a queue record a **ticket**: this milestone's plan, its as-built and
the addenda before that date keep the word *item* as they were written. The API keeps `item` ([`api.md`](api.md)).*

Everything the other milestones build on: `core::tracker` and its routes on `rag-serve`. No UI and no MCP tools
here; it is driven and tested through the store's API and the HTTP routes.


Work items
----------
| WP | Work | Size | Files |
|---|---|---|---|
| TR-01 | **The schema** (D1–D4, D7, D8): `projects` (name, head, tail, seq counters), `items` (D3, with `prev_id`, `next_id`), `item_links`, `specs`, `milestones`, `concepts`, `concept_links`, `documents` (project, path, kind, title, revision, owner record), `revisions`, `redirects`, `attachments`, `events`. Typed enums for every type, status, state, reason, intensity, approval, surface and event kind, refused at the boundary. Opened like the ledger (`sqlx`, WAL, `CREATE … IF NOT EXISTS`); `[tracker] db_path` and `attachments_dir` in `rag.toml.example` and the config | M | `crates/core/src/tracker.rs` (new; split into a module directory if it passes ~1500 lines), `crates/core/src/config.rs`, `rag.toml.example` |
| TR-02 | **The linked list** (D5): create at the tail or at a named place, move (`before`, `after`, `top`, `bottom`), unlink on done and cancel, relink at the top on reopen; each one transaction. A move onto itself, or relative to an item of another project or one not queued, is refused. The integrity check | M | `tracker.rs` |
| TR-03 | **Items** (D3, D6, D7, D10): create (id minting `<project>-t<seq:04>`), get with links and history, update (status, block and unblock with a reason, approval, assignee, title, body, links, gate fields) with a required note on a status, block or approval change; acknowledge-all-done; the transitions allowed (`pending` ↔ `in_progress` → `done` or `failed`; any queued → `cancelled`; `done`, `failed` or `cancelled` → `pending` as a reopen); gate fields only on gates | M | `tracker.rs` |
| TR-04 | **Documents and revisions** (D4, D9): create at a path (refused if taken, or if a redirect holds it), get by path (following a redirect, and saying so) or id, at a revision; edit by exact replacements (each `old` must occur exactly once, all or none) or a whole body, against a base revision (stale: refused with the current revision); rename with a redirect; list revisions; diff two revisions (unified, line-based); restore | M | `tracker.rs` |
| TR-05 | **Specs, milestones and concepts** (D4): create with their documents in one transaction (a spec's master at `specs/<slug>/master.md`, a milestone's at `specs/<slug>/<code>-<title>.md`, a concept's at `concepts/<slug>.md`); update state, approval, title and links; milestones ordered within their spec | S | `tracker.rs` |
| TR-06 | **Attachments** (D8): store by sha256 under `attachments_dir`, deduplicated; the row; fetch by full hash or 12-character prefix (an ambiguous prefix is refused); 50 MB cap; media type from the upload, checked against the content's magic bytes for images | S | `tracker.rs` |
| TR-07 | **The routes** (D11): `/tracker/{project}` (the queue view: done unacknowledged, queued in order, blocked), `/tracker/{project}/items` (create), `/tracker/items/{id}` (get, update), `/tracker/items/{id}/move`, `/tracker/{project}/ack-done`, `/tracker/{project}/docs` (list, create), `/tracker/{project}/doc?path=…` and `/tracker/docs/{id}` (get, edit, rename, revisions, diff, restore), specs, milestones and concepts, `/tracker/{project}/attachments` (upload as multipart; list) and `/tracker/attachments/{hash}`, `/tracker/{project}/check`. 503 when the store is not open; 400 with the store's message on a refusal; 409 on a stale base revision, carrying the current one. The queue view returns an `ETag` and honours `If-None-Match` (D14's polling) | M | `crates/serve/src/main.rs` or a new `crates/serve/src/tracker.rs` |
| TR-08 | **Deploy** (D18): `~/rag/tracker/` created and bind-mounted; `deploy/backup-qdrant.sh` copies `tracker.db` beside `ledger.db` (the interim local copy, Risks) | S | `deploy/`, `Containerfile` if needed |
| TR-09 | **Docs**: `README.md` (the tracker in the architecture and the API), `CLAUDE.md` (*Where things live*), `deploy/RUNBOOK.md` (the data directory, the interim backup) | S | as listed |


Tests
-----
Rust, against a temporary database, as the ledger's are; after **every** list operation in every test, the
integrity check passes.

* **The list**: create five items, the walk is their creation order; move the last before the first, the third to
  the bottom, the second after the fourth; each walk is as expected. Done unlinks; reopen puts it at the top;
  cancel unlinks. A blocked item stays in the walk; unblocked, it is where it was.
* **Refusals**: a move relative to itself, to another project's item or to a done item; an unknown type, status or
  approval; a status change with an empty note; gate fields on a non-gate; `done` → `in_progress`.
* **A property test**: 1000 random creates, moves, completions, reopens and cancels on one project; the integrity
  check after each, and the walk equals a reference `Vec` model.
* **Concurrency**: two connections moving and creating in the same project at once; the list is intact and every
  item appears once.
* **Documents**: an edit with two replacements applies both; one whose `old` occurs twice or not at all changes
  nothing; an edit on a stale base is refused with the current revision; a rename leaves a redirect that a get
  follows; restore writes a new revision equal to the old body; the diff of two revisions is correct.
* **Specs**: creating a spec with two milestones makes three documents at the expected paths, in one transaction
  (a clash on the second path creates nothing).
* **Attachments**: the same bytes uploaded twice make one file and two rows' worth of references to one hash; a
  12-character prefix fetches it; an ambiguous prefix is refused; a file over 50 MB is refused.
* **Events**: every write appends exactly one event with its surface and agent; the history explains every field's
  current value.
* **Routes**: one happy path and one refusal per route through `axum`'s test harness; the queue view's `ETag`
  changes with a write and a matching `If-None-Match` answers 304.


Acceptance
----------
1. `cargo test` passes, clippy clean with `-D warnings`, as the repository's other crates.
2. Deployed on the server: `curl` creates a project's items, moves them, marks one done, and reads the queue view in
   the expected order; `/check` reports the list intact.
3. A spec with two milestones and a concept are created through the API, edited twice each, and their revisions
   and diffs read back.
4. `ledger.db` and the ledger's routes are untouched (the ledger's tests pass unchanged).


As built
--------
2026-10-27. Code: `crates/core/src/tracker/` (`mod.rs` types, enums, schema; `list.rs` the linked list and the
check; `items.rs`; `docs.rs`; `records.rs` specs, milestones, concepts; `attachments.rs`; `tests.rs`) and
`crates/serve/src/tracker.rs` (+ `tracker/tests.rs`). 36 store tests (the property test runs 1000 operations; the
concurrency test runs two stores on one file) and 21 route tests. Where the spec was silent or ambiguous, the
choice made:

* **The web UI's pages are not under `/tracker/`.** D11 puts the API there and D14/D16 (and m03, m04) put the
  dashboard and documents pages there too; an API path never falls back to the SPA, so the pages would have been
  JSON. The pages are `/projects/<project>…` ([`api.md`](api.md) § *Web UI paths*); D14, D16, m03 and m04 are
  amended. `/tracker` joined `web.rs`'s API prefixes.
* **Every write is a `POST`**, in the ledger's style: `POST /tracker/items/{id}` updates an item; documents have
  `edit` (exact replacements) and `write` (a whole body) as separate routes (D11 lists both).
* **Added routes** the later milestones need: `GET /tracker/projects` (m03's project picker),
  `GET /tracker/{project}/items` (every item, done and cancelled included), list routes for specs and concepts, and
  `tracker_ready` in `/info`.
* **Bodies are strict**: unknown fields are refused, and every malformed body or query is a 400 with the usual
  `{"error"}` rather than axum's plain-text 422.
* **Transitions were exactly TR-03's table**, so `pending` → `done` was refused (through `in_progress`). **Changed
  by the manager in m02 (TM-06):** `pending` → `done` and `pending` → `failed` are now allowed, so quick work is
  recorded without first being marked in progress ([`api.md`](api.md) § *Status transitions*). A `failed`
  item reopened to `pending` keeps its place: it never left the list, and "relink at the top" is for work that had
  left it. `done` and `cancelled` clear a block; only a queued item can be blocked.
* **`ratified` only follows `agent`**; nothing is created `ratified`. Creating anything with an approval needed a
  note (a milestone created with its spec may use the spec's); no longer, see the addendum below.
* **"Exactly one event per write"** is per record: creating a spec with two milestones appends a `create` event to
  each of the five records (spec, two milestones, three documents); acknowledge-all-done one per item. A list
  change records a `move` (or `status`) on the item moved, not on its neighbours, whose `prev_id`/`next_id` are list
  mechanics rather than fields with a history.
* **Document ids** are `<project>-d<seq:04>`. A milestone's file name is `<code>-<name>.md`, `name` defaulting to
  the title slugified, and settable so a repository's existing names (`m01-store-and-api.md`) survive the move.
  A rename back onto the document's own old path is allowed; any other redirected path is never reused. Bodies are
  capped at 4 MB.
* **A stale edit's 409 carries the current document**, so m04's conflict view needs no second request.
* **Attachments**: a prefix of 12 or more hex characters (or the `att:` reference) fetches; SVG and every
  non-raster type are served as downloads, with `nosniff` and a sandboxing CSP, since the API shares the UI's
  origin. The interim same-box backup copies `tracker.db` only: attachments are content-addressed and never
  rewritten, so a second copy on the same disk adds nothing (m06 takes them off the box).
* **Writes take SQLite's write lock up front** (`BEGIN IMMEDIATE`), so concurrent writers queue instead of failing
  with `SQLITE_BUSY` on a read-to-write upgrade.
* **Project names** are repository names; `items`, `docs`, `attachments` and `projects` are reserved (route
  segments).

### Addendum, 2026-10-27: notes optional except Add note (rag-t0007)

The owner, after using the web UI: notes were required on every action, and should be optional on all but *Add
note*. D7 is amended. The store no longer refuses a status change (done, cancel, reopen included), block, unblock,
approval (ratify included) or a create with an approval for want of a note; `require_note` is gone, and a blank
note counts as none (`given_note`). Without a note the event body is generated from the change, in the style of the
existing generated bodies: `Status: pending → done.`, `Blocked (review).`, `Unblocked.` (also when a blocked item
leaves the queue), `Approval: agent → ratified.`, `State: draft → ready.` for a spec, milestone or concept, then
`Set title, body.` for the other fields; a create with an approval says it (`Created dev item (approval: owner).`).
A block without a note leaves `block_note` null. Moves, renames and restores already took an optional note. The one
write still refused without a note is a bare note, an update that changes nothing else. Tests:
`a_change_without_a_note_gets_a_generated_body`, `a_bare_note_must_not_be_blank`,
`record_changes_without_a_note_get_a_generated_body`, `an_approval_at_creation_needs_no_note`, and the HTTP route
tests (`item_update_changes_fields_and_takes_optional_notes`, `specs_create_list_get_and_update`).

### Addendum, 2026-10-27: the `deferred` status (rag-t0017)

The owner: separate blocked work from work put aside on purpose. D3, D5 and D14 are amended. `ItemStatus` gains
`deferred`, which is **queued**: a deferred item keeps its `prev_id` / `next_id`, so resuming it (`deferred` →
`pending`) puts it back where it was, and it can be moved and used as an anchor. Transitions: `pending`,
`in_progress` or `failed` → `deferred`; `deferred` → `pending`, `in_progress`, `done` or `cancelled` (`deferred` →
`failed` is refused). It is independent of the blocked flag: a deferred item can be blocked, and keeps the block
when resumed. The queue view gains a `deferred` array after `blocked`, in list order, holding every deferred item
blocked or not; `queue` and `blocked` hold none. `GET /tracker/projects` gains `deferred`, and its `blocked` now
counts only items that are not deferred, so the counts match the sections. The queued statuses are one SQL list,
`items::QUEUED_IN`, used by the walk, the queue view and the project counts, and a test pins it to
`queued_status`. No schema change (`status` is free text). Tests: the exhaustive transition table,
`deferred_keeps_its_place_and_resumes_in_place`, `a_deferred_item_may_also_be_blocked_and_is_shown_as_deferred`,
`the_queued_sql_list_agrees_with_queued_status`, the property test (defer and resume ops; its final check splits
the walk into queue, blocked and deferred), and the routes (`the_queue_view_orders_sections_and_honours_if_none_match`,
`items_list_filters_by_status`). The search reconcile indexes it as any other status
(`a_deferred_item_stays_indexed_with_its_status`).

### Addendum, 2026-10-27: `parallel`, and block reason `dependency` with `depends_on` (rag-t0013, rag-t0018)

Two trial findings from ubu's manager; D3, D5 and D12 are amended. **`parallel`**: a new item column (`INTEGER NOT
NULL DEFAULT 0`), settable on create (`parallel: true`) and update (`parallel: true|false`, generated body
`Parallel: on.` / `Parallel: off.`, an `edit` event), refused on a gate either way ("a gate cannot be parallel"). It
is the store's first **migration**: `mod.rs`'s `ADDED_COLUMNS` lists `(table, column, declaration)`, and
`TrackerStore::open` adds each one missing (`pragma_table_info`, then `ALTER TABLE … ADD COLUMN`, a concurrent
opener's "duplicate column" tolerated), so an older `tracker.db` opens with every row reading the default; the
`CREATE TABLE` carries the column for a new database. **`dependency`**: `BlockReason` gains it, and a new table
`item_depends (item_id, depends_on)` (with an index on `depends_on`; a new table needs no migration) holds the
list, returned in the order given as `depends_on` on every item (empty when not so blocked). `ItemUpdate.depends_on`
replaces the list wholesale; it is accepted only when the reason after the write is `dependency` (given now, or
already held), which needs at least one entry; otherwise a non-empty list is refused ("depends_on goes with
block_reason dependency"). Entries are trimmed and de-duplicated, and each must be an item of the same project, not
the item itself; at least one must not be done; no cycle (a breadth walk over `item_depends` from the new list must
not reach the item: cheap, since only dependency-blocked items hold rows). A changed list is a `block` event
(`Blocked (dependency). Waits on ubu-t0001.`, or `Waits on ubu-t0002.` alone). Any unblock, another reason, or
the item leaving the queue clears the rows (`depends_on: []` in the event's fields). **Auto-unblock**: when
`update_item` moves an item to `done`, after its own event and in the same transaction, `unblock_dependents`
unblocks each item blocked with `dependency` whose dependencies are now all done: `blocked`, reason and note
cleared, rows deleted, and an `unblock` event by the same actor as the triggering write (email, agent and surface:
it is that write's consequence, so it carries its author rather than a made-up system identity), body `Unblocked:
<id> is done.` (`…, the last of <a>, <b>.` with several), fields `blocked`, `depends_on: []`, `unblocked_by`.
Cancelled or failed dependencies unblock nothing. The integrity check (`TrackerStore::check`) also reports
dependency faults (`items::dependency_problems`). HTTP: `POST /tracker/{project}/items` takes `parallel`, `POST
/tracker/items/{id}` takes `parallel` and `depends_on`. The search payload is unchanged (an auto-unblock body is
indexed as any unblock note). Tests: `parallel_is_set_on_create_and_update_and_refused_on_a_gate`,
`an_older_database_gains_the_parallel_column_and_keeps_its_items` (the old schema is `SCHEMA_SQL` without the
column, opened twice), `a_dependency_unblocks_itself_when_its_one_dependency_is_done`,
`a_dependency_on_two_items_waits_for_both`, `a_cancelled_or_failed_dependency_unblocks_nothing`,
`depends_on_is_refused_across_projects_empty_self_unknown_done_and_in_a_cycle`,
`depends_on_changes_in_place_and_clears_with_the_reason`, `the_integrity_check_finds_a_dependency_fault`, each
ending in the integrity check; routes `parallel_goes_through_create_update_and_the_queue_view` and
`a_dependency_block_unblocks_when_its_items_are_done`.

### Addendum, 2026-10-27: the `review` status, and the block reason `approval` retired (rag-t0024)

The owner: a status for work waiting on him to confirm or review it, shown red above the queue; and retire the block
reason `approval` ("Needs approval"), which the status replaces (it showed on approved rows and read as the approval
record). D3, D5, D12 and D14 are amended. `ItemStatus` gains `review`, which is **queued** like `deferred`: it keeps
its place, can be moved and used as an anchor. Transitions: `pending`, `in_progress` or `failed` → `review`;
`review` → `done` (confirmed), `in_progress` or `pending` (sent back, in place) or `cancelled`; `review` →
`failed`/`deferred` and `deferred` → `review` are refused. It is independent of the blocked flag. The queue view
gains a `review` array between `done` and `queue` (serde field order is the wire order), holding every review item
blocked or not; `queue`, `blocked` and `deferred` hold none. `GET /tracker/projects` gains `review`; `blocked` there
already counted only `pending`/`in_progress`/`failed`, so it excludes review. `QUEUED_IN` gains `'review'`.
**The retired reason**: `BlockReason` loses `Approval`. The `str_enum!` macro grew an optional `retired { "old" =>
"why" }` list, and `FromStr` and a hand-written `Deserialize` (it replaced the derive for every enum: a value goes
through `String`, unknown ones still get serde's `unknown variant` message) refuse a retired value with its own
message, here `the block reason approval was replaced by the status review (rag-t0024): set status review to put
work in front of the owner`; the HTTP 400 carries it. **The data migration**: `init_schema`, after `ADDED_COLUMNS`,
runs `migrate_retired_approval_blocks` in one write transaction: every item with `blocked = 1 AND block_reason =
'approval'`, if queued, becomes `review` with the block, reason and note cleared and its links untouched (so in
place), plus a `status` event `Moved to review: the block reason approval was replaced by the review status.`
(`MIGRATED_TO_REVIEW`), then ` The block note was: …` when it had one, fields `{status: "review", blocked:
false}`. An item not queued cannot hold a block (leaving the queue clears it); one that somehow does is only
unblocked (an `unblock` event). The events are authored by `MIGRATION_ACTOR`: email `system`, agent `Tracker
migration (rag-t0024)`, surface `mcp` (the server's code wrote it, not the owner at the keyboard, which `web` would
claim; the enum has no third surface and adding one for a one-off would ripple into every client). Idempotent: a
second open finds no row. Other reasons are untouched. A deferred item blocked with `approval` becomes `review` too
(the owner's rule says every one). Live data on the first open after deploy: rag-t0002, ubu-t0001, ubu-t0025,
ubu-t0050, ubu-t0051. Tests: the exhaustive transition table, `review_keeps_its_place_and_is_confirmed_or_sent_back`,
`the_retired_block_reason_approval_is_refused_pointing_at_review`,
`an_older_database_moves_approval_blocks_to_review_once` (four rows written straight into the schema, opened twice,
one event each time), the property test (review and send-back ops; its final check splits the walk into review,
queue, blocked and deferred), and the routes (`the_queue_view_orders_sections_and_honours_if_none_match`,
`items_list_filters_by_status`, `the_retired_block_reason_approval_is_refused_naming_review`).

### Addendum, 2026-10-27: labels on items (rag-t0027)

The owner: "custom labels, eg 'Physics', 'Biomes', 'Creatures', etc that we can add to the tickets." D3 is amended.
**Storage**: a new table `item_labels (item_id, project, label, label_key)`, primary key `(item_id, label_key)`,
indexed on `(project, label_key)`; `label_key` is the label lowercased (Rust `to_lowercase`, so not ASCII-only) and
`project` the item's, held so a vocabulary is one indexed query. A new table needs no `ADDED_COLUMNS` entry (rag-0056):
`CREATE TABLE IF NOT EXISTS` in `SCHEMA_SQL` adds it to an older `tracker.db` on open (rag-0063), and every existing item reads
`[]`; nothing else in the database changes. **Rules** (`tracker/labels.rs`): each label trimmed, inner whitespace
runs one space, non-blank, at most `MAX_LABEL_CHARS` = 32 characters, no comma (labels are listed comma-separated
in event bodies and the MCP text), no control character; at most `MAX_LABELS` = 10 per item after duplicates are
merged case-insensitively (the first kept). **Casing**: each label takes the casing another item of the project
already carries (`SELECT MIN(label) … AND item_id <> ?`); the item being written is left out, so an item that alone
carries a label can change its casing. **Order**: held sorted by key, so the same set in another order is not a
change (no event). `Item` gains `labels`; `NewItem` gains `labels: Vec<String>`; `ItemUpdate` gains
`labels: Option<Vec<String>>` (wholesale, `Some(vec![])` clears). A create records `labels` in its fields always and
appends ` Labels: Biomes, Physics.` to a generated body when there are some; an update that changes them is an
`edit` event with `fields.labels` the whole set and, without a note, `Labels: Biomes, Physics.` (`Labels: none.`).
`TrackerStore::project_labels(project)` is the vocabulary (`LabelCount { label, count, queued }`, sorted by key);
`list_items(project, status, label)` gained the label filter (case-insensitive, after the same trimming; blank is
none), applied after the load. HTTP: `labels` on create and update bodies and every Item, `GET
/tracker/{project}/labels`, `GET …/items?label=`. Tests: `labels_are_cleaned_sorted_and_recorded_on_create`,
`an_existing_labels_casing_wins_within_the_project_only`, `labels_are_set_wholesale_and_each_change_is_one_event`,
`bad_labels_are_refused_and_change_nothing` (blank, empty, 33 characters, a comma, a control character, 11 labels;
on create and update; exactly 10 with one at 32 characters and a duplicate is accepted),
`the_vocabulary_lists_each_label_once_with_its_counts`, `items_list_by_label_case_insensitively`,
`an_older_database_gains_the_labels_table_and_keeps_its_items` (the schema without the table, an old row, opened
twice), the snapshot test (labels sorted), and the route test
`labels_go_through_create_update_the_vocabulary_and_the_items_filter` (plus `/tracker/p/labels` in the 503 list).

### Addendum, 2026-10-27: the live event feed (rag-t0036)

The owner: wake an idle manager when he acts in the web UI, without polling. D11 is amended; the contract is
[`api.md`](api.md) § *The event feed*. **Store** (`tracker/feed.rs`): `TrackerStore` holds a `tokio::sync::broadcast`
channel of `Arc<FeedEvent>` (`FEED_CAPACITY` = 1024 per subscriber; `with_feed_capacity` replaces it, for the lag
tests). Every write that appends an event now ends `self.commit(tx)` instead of `tx.commit()` (items, specs,
milestones, concepts, documents: 14 sites), which commits and then **publishes**: under a mutex holding the last id
sent, it reads every event `event_id > last` (with its record's project, kind, id and **current title**, one query
with a `CASE` of sub-selects) and sends them in id order. With no subscriber it reads only `MAX(event_id)`, read
**before** the receivers are counted so a subscriber that arrives in between still replays everything up to it. A
failed read logs and leaves the mark, so the next write's publish catches up. `open` starts the mark after the
events already in the table (the open-time migrations' included). The index snapshot and the attachment upload
append no event and commit as before. `FeedEvent` is the event plus `project`, `target_kind`, `target_id` and
`title`; `line()` is the text frame and `moved()` its `{status=… approval=…}` part (status, state, approval, blocked,
block_reason, assignee; never on a create; replaced by `changed()`, from → to, in rag-t0038's addendum below). `FeedFilter { project, surfaces, kinds }` (`None` = any) is applied in
SQL by `events_after(filter, since, limit)` and `count_events_after`, and in Rust by `matches` for the live side;
`latest_event_id()`, `subscribe()`, `feed_closing()` / `close_feed()` (the shutdown signal) complete it.
`DEFAULT_FEED_KINDS` is create, status, block, unblock, approve, move, note, acknowledge, assign, edit. core's tokio
gains the `sync` feature.

**Routes** (`crates/serve/src/tracker/feed.rs`; axum's `ws` feature, serve's tokio `sync` and `time`): `GET
/tracker/{project}/events/ws` (`*` for every project) validates the filter, refuses a replay of more than
`MAX_REPLAY` = 500 events (400) **before** the upgrade, then subscribes, replays in pages of 200 and goes live,
dropping ids at or below the last sent; a 30 s ping; a 10 s send timeout; close 1013 on `Lagged`, 1012 on shutdown,
1011 on a replay error, each reason carrying `since=<last id sent>`. A request without the upgrade headers is a 426
in the routes' JSON error shape. `GET /tracker/{project}/events` is the one-shot read (`limit` 1–1000, default 100;
`latest_event_id`, `next_since`, `more`). `main.rs`: the shutdown signal now includes **SIGTERM** (`podman stop`;
`rag-serve` is the container's PID 1, which ignored it until podman's SIGKILL), then `close_feed()` and a 300 ms grace
when feeds are open. **Deploy**: nothing changes. The container uses host networking and binds 17793 itself, so no
proxy sits between a client and the upgrade.

Tests. Store (`tracker/tests.rs`): `the_feed_publishes_each_committed_event_after_its_write`,
`a_refused_write_publishes_nothing`, `a_spec_with_milestones_publishes_every_event_it_wrote_in_id_order` (each
record's label and title), `a_late_subscriber_gets_only_what_comes_after_it`,
`a_reopened_store_starts_its_feed_after_the_events_already_there`,
`events_after_applies_project_surface_and_kind_filters` (and `matches` agrees with the SQL),
`concurrent_writers_publish_every_event_once_in_id_order` (4 writers × 10, multi-threaded),
`a_feed_line_is_one_line_with_the_event_id_first`,
`a_feed_line_repeats_the_state_a_change_moved_to_but_not_a_creates_fields`. Routes, over a real loopback socket with
a `tokio-tungstenite` client (`tracker/feed/tests.rs`):
`the_feed_replays_after_since_then_sends_each_new_event_live`, `without_since_the_feed_sends_only_what_comes_next`,
`a_feed_resumed_by_id_loses_and_repeats_nothing_under_concurrent_writes` (60 writes, a third of them `mcp`, while
the client drops and resumes three times),
`by_default_a_web_write_reaches_the_feed_and_an_mcp_write_does_not` (through the HTTP routes; `surface=mcp` and
`any`), `kinds_choose_the_events_and_the_default_leaves_out_housekeeping`,
`a_project_feed_sends_its_own_project_and_star_sends_every_project`,
`format_json_sends_each_event_as_one_json_line`, `bad_feed_requests_are_refused_before_the_upgrade`,
`a_replay_longer_than_the_cap_is_refused_and_paged_by_the_read`,
`the_read_gives_the_starting_id_and_the_events_after_since`,
`a_lagging_client_is_closed_with_its_resume_id_and_resumes_without_loss` (capacity 4, a burst of 11 published at
once on the single-threaded runtime), `closing_the_feed_sends_a_restart_close_with_the_resume_id`; and both routes
in the 503 list. Proven by hand on a scratch `rag-serve`: Claude Code's `Monitor` (`ws` source) received the owner's
two frames and not the agent's, and surfaced the 1012 close and its resume id on SIGTERM.

### Addendum, 2026-10-27: from → to in every event, and web writes stamped Owner (rag-t0038)

The ubu manager reading the feed asked for both values of each change, so it can act on a frame without fetching the
item, and for the owner's web writes to stop reading `Unknown`.

**Prior values.** `events` gains `fields_before TEXT` (nullable; `ADDED_COLUMNS`, so an older `tracker.db` gains it
on open and every existing row reads `NULL`). `append_event` takes `before: Option<&Value>`, stored as JSON beside
`fields`; `Event` and `FeedEvent` carry it as `before` (`null` on a create and on every event written before the
column). Nothing is back-filled: the prior value of an old event is not recoverable without replaying the history,
and a replay that disagrees with the live record would be worse than an honest gap. Who records what:
`update_item` takes every key of `fields` from the item as loaded (`prior_values`, the item serialised), with
`blocked` and `block_reason` always together; `move_item` reads the new `prev_id` after relinking and records it in
`fields` beside `place`, the old one in `before`; `acknowledge_done` records `acknowledged_at: null`; the automatic
unblock records `blocked: true, block_reason: dependency, depends_on: [...]`; the rag-t0024 migration its prior
status and block. Specs, milestones and concepts record through `Changes::change(name, from, to, kind)` (title,
state, approval, order); `Changes::set` stays for `links_added`/`links_removed`, which have no prior value.
Documents: an edit or restore records the prior `revision`, a rename the prior `path` and `title`.

**The frame** (`FeedEvent::changed()`, which replaced `moved()`, over `changes()`, the list): `{status:
in_progress → done; blocked: dependency → no}`, `{labels: +Physics −Biomes}`, `{moved: after rag-t0010 → top}`,
each change a frame names in a fixed order, separated by `; ` (lists use `, `). `blocked` and `block_reason` read as
one field (the reason, or `no`). A move is named by the item's new neighbour (`top` or `after <id>`), not the place
asked for: `before rag-t0013` and `after rag-t0012` can be the same position, and the neighbour is what a manager
checks against its queue. A field with no recorded prior names its new value alone; an old move its requested
place; an old rename its `old_path`. `[<who>]` is now `agent` on both surfaces. The full contract is
[`api.md`](api.md) § *The event feed*.

**Owner.** `Actor::validated` records a blank or absent agent as `OWNER_AGENT` (`"Owner"`) on `web` and
`UNKNOWN_AGENT` (`"Unknown"`) on `mcp`: server-side, so every web write (items, specs, documents, revisions,
attachments) is covered whatever the client sends; a named agent on the web keeps its name. **Existing rows: a
migration, not a display rule** (`migrate_web_agent_to_owner`, run on every open after the column additions):
`UPDATE events|revisions|attachments SET agent = 'Owner' WHERE surface = 'web' AND agent = 'Unknown'`. One
statement per table, so every reader (the API, the web UI, the MCP tools, the feed, the search index, a hand-run
`sqlite3`) sees one value, where a display rule would have to be repeated in each, and the live database's web
rows were all written by the owner (D10: `web` is the owner at the keyboard). No event is appended: no record
changed, only the name of who changed it. Idempotent. The web item page is unchanged: it already labels a web
event by its email and "on the web" rather than by `agent`.

Tests. Store: `a_feed_line_is_one_line_with_the_event_id_first` (updated), `a_feed_line_names_each_change_from_to`
(every field kind), `an_event_from_before_its_prior_values_were_recorded_names_the_new_value_alone`,
`every_write_records_what_it_changed_from_and_the_feed_says_it` (real item writes: status, approval, dependency block
and the automatic unblock, labels, two moves, assignee/title/parallel, acknowledge, create; text and JSON),
`specs_and_documents_record_what_they_changed_from`, `a_web_write_without_an_agent_is_recorded_as_owner` (and the
negatives: a named agent on the web, an unnamed `mcp` write stays `Unknown`; documents, revisions, attachments),
`an_older_database_gains_the_prior_values_column_and_its_web_events_read_owner` (a pre-rag-t0038 schema with web
and mcp `Unknown` events, a revision and an attachment; opened twice). Routes:
`a_web_write_without_an_agent_is_recorded_as_owner_with_its_prior_values` (HTTP) and
`frames_say_what_a_change_moved_from_and_to_in_both_formats` (over the socket, text and JSON).

### Addendum, 2026-10-27: the `request` type, and `from` / `became` links (rag-t0044)

The owner files a **request**, a high-level idea with how to prioritise it; the manager, woken by the feed, breaks
it into tickets linked back to it, places them, and closes the request as done listing what it became.

**The type.** `ItemType::Request` (`"request"`). `create_item` refuses gate fields on it (as on any non-gate) and
`parallel` (on create and update: *a request cannot be parallel: it is never dispatched, only broken into tickets,
which may be*). It takes the statuses and transitions every item does, is queued and keeps its place in the list.
**The queue view** gains `requests`: every queued request, whatever its status or block, in list order, checked
first in the split, so a request is never in `queue`, `review`, `blocked` or `deferred`. `tracker_next` and a gate's
batch read `queue` only, so neither can see one. `ProjectSummary` gains `requests`; `blocked`, `deferred` and
`review` leave requests out, so each item is counted once. Done, a request is under `done` as any item is.

**The links.** `LinkKind::From` (`from:<request id>`) and `LinkKind::Became` (`became:<item id>`). No schema
change: `item_links.kind` is text, so nothing is migrated. `validate_link` refuses `became` always
(`BECAME_IS_THE_SERVERS`, pointing at `from`), and `from` on a concept, naming the item itself, naming no item, an
item of another project, or anything but a request. A request refuses a `from` of its own, on create and on
`add_links`. **Reciprocity** is one helper, `reciprocate_from`, run in the write's own transaction after the item's
event: adding a `from` (create, `add_links`) inserts `became` on the request and appends a `link` event there
(`Became ubu-t0051.`, `fields.links_added`, `before: {}`); removing it (`remove_links`) deletes the reverse
(`No longer became ubu-t0051: its from link was removed.`, `links_removed`). A `remove_links` naming `became` is
refused with the `from` to remove instead. `link` is housekeeping and outside the feed's default kinds, so the
manager's own breakdown does not wake it. **The integrity check** (`request_link_problems`) reports a `from` whose
request has no `became` back, a `became` whose item has no `from`, and a `from` naming anything but a request.

**Same project only.** A `from` must name a request of the item's own project: the manager, the feed and the
dashboard are all per project, and a `became` event belongs in the request's project's history, so a cross-project
breakdown would split one request's story across two feeds. Nothing asked for it.

**The default approval** is `rag_core::tracker::default_approval(&links)`: `agent` when the create carries a
`from`, else `unapproved`; `rag-serve` applies it when the body names no approval. An explicit `owner` (the request
says the work is approved) stands.

**The feed.** `describe_changes` says `{type: request}` for an item `create` of type `request`, and still nothing
for any other create, so the frame that wakes the manager says what it is:
`#13906 rag web create rag-t0044 "Weather" {type: request}: Created request item (approval: owner). [Owner]`.

Tests. Store: `a_request_has_its_own_section_and_is_never_in_the_queue` (pending, in progress and blocked, review,
deferred: only under `requests`; the project counts; done under Done), `a_request_has_no_gate_fields_and_is_never_parallel`,
`from_links_are_answered_by_became_on_the_request` (on create and on update, added and removed, with their events;
`default_approval`), `request_links_are_refused_where_they_do_not_belong` (every refusal above, and nothing left
behind), `the_integrity_check_finds_a_one_sided_request_link` (each side deleted by hand),
`a_requests_create_frame_says_request`. Routes: `a_request_has_its_own_section_and_its_tickets_link_back` (the
view, the counts, the default and the explicit approval, `became` in order, done with a note, the check),
`request_writes_are_refused_where_they_do_not_belong`, and over the socket
`a_web_request_reaches_the_default_feed_saying_request` (the frame; the `became` link event stays out of the
default feed).

### Addendum, 2026-10-28: a review ticket may be deferred

The owner could not defer a ticket in review from its page, and asked for it. `review` → `deferred` is now allowed
(`items::transition_allowed`); the ticket keeps its place, as every move between queued statuses does. `deferred` →
`review` and `review` → `failed` stay refused. The web's `TRANSITIONS` table offers it, so the ticket page shows
*Defer* beside *Confirm* and *Send back*. Tests: the exhaustive table in `disallowed_transitions_are_refused`,
`review_keeps_its_place_and_is_confirmed_or_sent_back` (defer and resume in place), and `trackerItem.test.tsx`.
