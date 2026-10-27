m02: the MCP server
===================
**State: Done** (2026-10-27): built, tested, lint-clean, driven end to end headlessly over both transports;
acceptance 1 and 2 (a live Claude Code session) wait for the release. Spec: [`master.md`](master.md), D12, R4. **Build from
[`api.md`](api.md)**, the HTTP contract m01 built: every tool forwards to a route documented there.

The agents' surface: a `tracker` mode of `rag-mcp`, so tracker calls show as their own server, as the ledger's do.


Work items
----------
| WP | Work | Size | Files |
|---|---|---|---|
| TM-01 | **`--server tracker`** and the gateway's `/tracker` route, beside `corpus` and `ledger`; identity (`author_email` from git, `agent` resolved as the ledger tools resolve it) and `surface: mcp` on every write | S | `crates/mcp/src/main.rs` (or a `tracker.rs` beside it) |
| TM-02 | **The tools** (D12's table): `tracker_queue`, `tracker_get`, `tracker_create`, `tracker_update`, `tracker_move`, `tracker_doc_get`, `tracker_doc_edit`, `tracker_attach`, `tracker_attachment_get`, `tracker_ack_done`, each forwarding to m01's routes. `tracker_queue`'s text is compact and stable: one line an item (`● ubu-t0042 [dev] title · in progress · agent: dev-3 · approval: agent`), a gate as `── gate: standard · release ──`, then `Blocked:` and its lines; a refusal comes back as the server's message, never a stack trace | M | as above |
| TM-03 | **Descriptions that carry the rules** (R4, D10, D12): every write tool says who may call it (queue writes: the agent working with the owner, in practice the manager; document edits and a note on one's own task: any agent); that a status change, block or approval needs a note; that `agent` must be passed; that `owner` approval is recorded only when the owner gave it, with the note saying where; and that `tracker_doc_edit` needs the base revision from `tracker_doc_get` and is refused when stale | S | as above |
| TM-04 | **Attachments over both transports** (D12): stdio reads a local path for `tracker_attach` and writes `tracker_attachment_get` to a local path (default under the system temp directory, returned in the result) so the agent can `Read` an image; the gateway takes and returns base64, capped at 10 MB, and says so in the description | S | as above |
| TM-05 | **Docs**: `.mcp.json.example` (the third server), `user-claude.md` (a *Tracker* section in the style of the *Ledger* one: when to read the queue, who writes, notes and agent required, document paths), `README.md`, `CLAUDE.md` (*Connecting an agent*) | S | as listed |


Tests
-----
* Each tool's arguments map to the route's body (unit tests on the request builders, as the ledger tools have).
* `tracker_queue`'s text for a fixed queue matches a golden string (done, queued with a gate marker, blocked).
* `tracker_doc_edit` with a stale base returns the server's refusal and the current revision in its text.
* `tracker_attach` over stdio uploads a fixture image; `tracker_attachment_get` writes the same bytes back.


Acceptance
----------
1. In a Claude Code session with the `tracker` server registered, an agent creates three items and a gate in a
   scratch project, reorders them, marks one done, reads `tracker_queue`, creates a concept with an image attached,
   edits it twice and reads its history, with no help beyond the tool descriptions.
2. The calls show in the session as the `tracker` server's.
3. `cargo test` and clippy pass.


As built
--------
2026-10-27. Code: `crates/mcp/src/tracker.rs` (the server, its argument types, the request builders, the text
renderers) and `crates/mcp/src/tracker/tests.rs` (18 tests); `main.rs` gains `--server tracker` and `/tracker` on
the gateway. Each tool turns its arguments into a request with a pure builder (the unit-tested seam), so every
tool's argument-to-body mapping is pinned without a server; three tests run the tools against a stand-in
`rag-serve` (the stale edit, the stdio attachment round trip, the gateway's base64). Headless acceptance: the
stdio binary and the gateway were driven with JSON-RPC against a scratch `rag-serve` (scratch data, port 17893):
three items and a gate created, reordered, one marked done straight from pending, one blocked, the queue read; a
concept created with an image attached, edited twice (and once against a stale base, refused), its revisions,
diff, an old revision and its history read; the attachment fetched back byte for byte; a spec and a milestone
created and listed; done acknowledged. Where the spec was silent or ambiguous, the choice made:

* **TM-06 (the manager's decision): `pending` → `done` and `pending` → `failed` are allowed** in the store, so a
  manager records quick work without first marking it in progress. `failed` → `done` stays refused (reopen or
  cancel). [`api.md`](api.md) and m01's *As built* say so; one store test covers it, and the exhaustive table test
  was updated.
* **An eleventh tool, `tracker_list`** (projects, items, specs, concepts, docs, attachments, one line each). D12
  has no way to find a spec, concept or document without knowing its path; "with no help beyond the tool
  descriptions" needs one.
* **One reference syntax** for `tracker_get`, `tracker_update` and the document tools: an item id (`ubu-t0042`), a
  document id (`ubu-d0007`) or path (`….md`), `spec:<slug>`, `milestone:<slug>/<code>`, `concept:<slug>`. The
  document tools accept a record reference and read its `doc_id`, so `tracker_doc_get concept:terrain` works.
* **`project` defaults to the current git repository** over stdio, as `ledger_create`'s `repo` does; the gateway
  has no client git context, so it needs `project` (the error says so).
* **`tracker_create` has `kind`**: `item`, `gate` (an item with `type: gate` filled in), `spec`, `milestone`,
  `concept` and `doc` (a free-standing document; D12 lists only the first five, but the route exists). Its
  arguments are one flat set; a field that does not apply to the kind is **refused** before any request (as the
  API refuses unknown fields), never dropped.
* **`tracker_update` requires a note on every call** (D12: "a note is required"), stricter than the API, which
  needs one only for a status, block or approval change. A note alone is how a sub-agent reports on its task.
  *Superseded 2026-10-27, see the addendum below: the note is optional.*
* **`tracker_doc_edit` also restores and renames** (`restore_revision`; `new_path` / `new_title`), exactly one mode
  per call, rather than two more tools. A rename takes no `base_revision`; its `message` becomes the rename's note.
  The answer is one line, the new revision to edit against, not the whole document again.
* **`tracker_doc_get` has views**: `body` (default; the text, the revision to edit against, `history: true` for its
  events, `revision` for an older body), `revisions` and `diff`. Documents are rendered as text, never JSON, so the
  markdown reads as written.
* **Answers.** `tracker_queue`, `tracker_list` and documents are text; records from `tracker_get` are the server's
  JSON; a write answers with the record and **only the event it appended** (`event`), not the whole history, which
  grows with every write and is one `tracker_get` away.
* **`tracker_queue`'s text**: a header line (`ubu: 4 in the queue, 1 blocked, 1 done not acknowledged`; "in the
  queue" excludes blocked items, as the view does), then `Done:`, `Queue:` and `Blocked:` (`none` when empty). An
  item line is TM-02's (`agent:` is the assignee); `approval:` is shown unless `unapproved`, then `links:`; a
  blocked line adds `blocked: <reason>: <note>`. A gate marker carries its id (an agent needs it to move the gate)
  and, once it is no longer pending, its status and assignee: `── ubu-t0043 gate: standard · release ──`. The
  golden test pins it.
* **Refusals are tool errors carrying the server's message** (JSON-RPC `invalid_params`, as the ledger tools'); a
  stale edit's adds "the current revision is N … re-read it with tracker_doc_get". The current body the 409 carries
  is not repeated: it can be 4 MB.
* **Attachments.** The multipart upload is built by hand (no new crate). Images are sent with no declared type so
  the server recognises them by their bytes; common documents get a type from the extension. Over stdio,
  `tracker_attach` takes a path (or base64) and `tracker_attachment_get` writes to `out_path` or
  `<temp dir>/rag-tracker/<hash prefix>-<name>`. Over the gateway a path or `out_path` is refused, base64 is capped
  at 10 MB each way, and a raster image comes back as MCP **image content** (base64 on the wire, viewable at once)
  rather than base64 text; other files come back as base64 text.
* **Acceptance 1 and 2** (a live Claude Code session with the server registered) wait for the release, which also
  rebuilds `rag-mcp`; the user's MCP registration is not changed here. 3: `cargo test -p rag-mcp`, `-p rag-core`
  and clippy `-D warnings` pass.


### Addendum, 2026-10-27: `tracker_next` and a bounded `tracker_queue` (rag-t0006)

The owner asked that a manager should not pull the whole queue to find its next task. Both tools filter on the MCP
side from the queue view (`GET /tracker/{project}`); the API, the store and the dashboard are unchanged. Code in
`crates/mcp/src/tracker.rs` (`queue_opts`, `next_opts`, `not_shown`, `render_queue`, `render_next`), tests in
`tracker/tests.rs` (goldens for both, the options' refusals, both tools against the stand-in).

* **`tracker_queue`** takes `limit` (queue rows, top first, gates counted as rows; default 20, 0 refused),
  `until_gate` (the batch up to the next gate, that gate included) and `sections` (any of `done`, `queue`,
  `blocked`; default queue and blocked; `[]` gives the counts alone; an unknown name is refused). The header of
  totals is unchanged. A section not asked for is left out, not printed as `none`. A cut queue ends with
  `  … 18 more queued (limit 20)` or `  … 12 more queued below the gate (until_gate)`.
* **The footer** of both tools is one line, `Not shown: 38 pending · 2 in progress · 1 failed · 2 gates · 3 blocked
  · 5 done not acknowledged`: every item of the view **not printed above**, counted once under the first of
  blocked, gate (any status), then its status; zero counts are left out, and `Not shown: none` when everything was
  printed. "Not shown" rather than the brief's `+38 pending · 2 in progress`, which mixed a remainder with totals.
* **The batch's gate is the first gate not in progress.** A running gate has been dispatched, so `tracker_next`
  and `until_gate` pass over it into the batch after it (dev work goes on while a gate runs); it still counts as
  work above the next gate, so two gates back to back never both run.
* **`tracker_next`** walks the queue (blocked items are not in it) taking the first `n` (default 1, 0 refused)
  pending items of `type` (validated), passing over items in progress, failed ones and other types, and stops at
  that gate. The gate is itself returned only when **nothing** is queued above it (in progress, failed, pending of
  any type, a running gate) and the filter allows a gate. A failed item above a gate does not stop dispatch above
  it, but holds the gate. With nothing to dispatch the header says why, e.g. `ubu: nothing dispatchable: gate
  ubu-t0043 (gate: standard · release) waits on 1 in progress, 1 failed above it`, `… the next job is gate …`
  (filtered out), `… gate … is failed and holds the queue`, `… the queue holds 2 in progress`, `… the queue is
  empty`. Each item is its queue line then its body between `-----` rules (`(no body)` when empty); links and
  approval are on the line.

Example, a queue of one running item, two pending (dev, recon), a standard gate and one more dev item, one blocked
and two done:

```
p: the next 1 of 2 dispatchable items before gate p-t0004 (gate: standard)

○ p-t0002 [dev] Title p-t0002 · pending · approval: owner · links: ledger:rag-0033
-----
Brief for p-t0002.
-----

Not shown: 2 pending · 1 in progress · 1 gate · 1 blocked · 2 done not acknowledged
```

### Addendum, 2026-10-27: the note is optional (rag-t0007)

D7 was amended by the owner: a note is optional on every change, required only for *Add note*. `tracker_update` no
longer refuses a call without one; a blank note is dropped before the request, and a call with no field and no note
is refused before any request (`nothing to update: give a field to change, or a note …`). The tool and server
descriptions now say a note is optional and to give one when the reason is not obvious from the change (the history
otherwise records the change itself, `Status: pending → done.`); `tracker_create`'s approval and note fields no
longer say a note is required. The rule "owner only when the owner approved, the note saying where" stands as
guidance. Test: `update_maps_each_target_and_takes_an_optional_note`.

### Addendum, 2026-10-27: deferred (rag-t0017)

The status enums and the `tracker_update` / `tracker_list` / `tracker_move` descriptions name `deferred` and its
transitions. `tracker_queue` prints a `Deferred:` section after `Blocked:` (glyph `◌`); `sections` accepts
`deferred`, which is listed by default with queue and blocked; the header reads `N in the queue, N blocked, N
deferred, N done not acknowledged`, and the `Not shown:` footer counts deferred items after the statuses and
before done. `tracker_next` never returns a deferred item (the server keeps them out of `queue`, and the walk only
takes `pending` rows in any case), so a deferred gate does not end a batch. `tracker_list what=projects` shows the
deferred count apart from the queue and blocked. A view without `deferred` (an older server) reads as none. Tests:
the queue goldens, `next_never_returns_a_deferred_item`,
`the_project_list_counts_deferred_apart_from_the_queue_and_blocked`, the sections options.

### Addendum, 2026-10-27: parallel past a gate, and dependencies (rag-t0013, rag-t0018)

`tracker_create` takes `parallel` (items, not gates); `tracker_update` takes `parallel` and `depends_on`, and its
`block_reason` names `dependency`. **`tracker_next`**: after the batch above the first gate not in progress, while
fewer than `n` items are picked, it walks the rest of the queue below that gate for **parallel** items (pending, of
the wanted `type`; blocked and deferred items are not in `queue`), each listed in full under `Below the gate: K of
M parallel items, which may start now and land after the gate named`, its line saying `parallel: lands after gate
<id>` with the nearest gate above it. When the batch fills `n`, a line says `Below the gate: M parallel items not
listed (raise n)`. A gate at the top, returned as the next job, counts towards `n`. **`tracker_queue`** marks a
parallel row `· parallel`, and a blocked row with reason `dependency` reads `blocked: dependency: waits on <a>, <b>`
(its note after). Tests: `next_offers_parallel_items_below_the_gate_after_the_batch` (golden, n leaving room or not,
the type filter, a running batch), `next_offers_nothing_below_a_gate_that_is_not_parallel` (and never a blocked
parallel item), `queue_lines_mark_parallel_and_say_what_a_dependency_waits_on`,
`create_and_update_carry_parallel_and_depends_on`.

### Addendum, 2026-10-27: review, and the block reason approval retired (rag-t0024)

The status enums and the `tracker_update` / `tracker_list` / `tracker_queue` / `tracker_next` descriptions name
`review` and its transitions; `block_reason` is `redesign | review | dependency`, and the description says work
waiting on the owner is status `review`, not a block (the server refuses `approval` with its own message).
`tracker_queue` prints a `Review:` section **first**, before the queue (and before `Done:` when that is asked for),
glyph `◆`; `sections` accepts `review` and lists it by default; the header reads `N in review, N in the queue, N
blocked, N deferred, N done not acknowledged`, and the `Not shown:` footer counts `N in review` after deferred and
before done. `tracker_next` never returns a review item, and a review item above a gate does not hold it, exactly
as a blocked one does not: both are outside the `queue` array the walk reads (the rule in `render_next`, mirrored,
not changed). `tracker_list what=projects` shows `N in review` first and takes it out of the queue's count. A view
without `review` (an older server) reads as none. Tests: the queue goldens (a review row first),
`next_never_returns_a_review_item_and_it_holds_a_gate_as_a_blocked_one_does`,
`the_review_section_is_asked_for_by_name`, `the_project_list_counts_deferred_apart_from_the_queue_and_blocked`.

### Addendum, 2026-10-27: labels (rag-t0027)

`tracker_create` (kind item or gate) and `tracker_update` (an item) take `labels: [string]`; on a spec, milestone or
concept it is refused before any request, as every field that does not apply is. The update's description says
the set is wholesale (send the full list), that any agent may label an item (labelling is not a queue write), and to
reuse the project's labels, matched case-insensitively with the project's casing winning. `tracker_queue` and
`tracker_next` show an item's labels in its line after the assignee, `● ubu-t0042 [dev] title · in progress · agent:
dev-3 · [Physics, Biomes] · approval: agent` (`item_extras`, so a gate marker shows them too); an item without
labels shows nothing. `tracker_list` gained `what: labels` (`GET /tracker/{project}/labels`, one line a label:
`Physics · 3 items · 2 queued`, or `No labels.`) and a `label` filter on `items` (refused on any other list). Tests:
`queue_and_next_show_labels_after_the_assignee`,
`create_and_update_carry_labels_and_list_filters_by_label`.
