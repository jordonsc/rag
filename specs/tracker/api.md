Tracker HTTP API
================
**The contract m02 (MCP server), m03 (dashboard) and m04 (documents UI) build from.** Built in m01
(`crates/core/src/tracker/`, `crates/serve/src/tracker.rs`); the design is [`master.md`](master.md). Change this
document with the code.

All routes are on `rag-serve` (port 17793), under `/tracker/`. The web UI's own pages must **not** live under
`/tracker/` (that prefix is the API's, and an API path never falls back to the SPA): the pages are at
`/projects/…` (see *Web UI paths* at the end).

**A queue record is a *ticket*** (rag-t0050, 2026-10-28): the web UI, the MCP tools, the server's generated event
bodies and feed lines (`Created dev ticket.`, `acknowledged 2 done tickets`), its error messages and these documents
say ticket. **Event bodies written before 2026-10-28 say *item*** (`Created dev item.`): history is kept as written,
with no migration. **The API keeps the name `item`** wherever it is a name, so no client breaks: the routes
(`/tracker/{project}/items`, `/tracker/items/{id}`), the JSON (`"items": […]`, and the shape sketched below as
`Item`), the link kind `item`, `what=items` and `kind: "item"` on a search hit.
A ticket's id keeps its `t` (`ubu-t0042`). The integrity check's problem lines (`/check`) still say item.


Conventions
-----------
* **JSON in, JSON out**, UTF-8. Request bodies are `Content-Type: application/json`, except the attachment upload
  (multipart).
* **Every write carries its author** in the body:

  | Field | | |
  |---|---|---|
  | `author_email` | string, required | who is writing |
  | `agent` | string, optional | the acting agent's name; absent or blank is recorded as `"Owner"` on a `web` write (the owner at the keyboard; rag-t0038) and `"Unknown"` on an `mcp` one |
  | `surface` | `"web"` \| `"mcp"`, required | the web app sends `web`, the MCP server `mcp` (D10) |

* **Unknown fields are refused** (400), so a mistyped field name never becomes a silent no-op. Enum values are
  checked against the lists below; anything else is a 400.
* **Notes.** A `note` is optional on every write (D7, amended by the owner 2026-10-27); a blank one counts as none.
  Without one the event's body is generated from the change: `"Status: pending → done."`, `"Blocked (review)."`,
  `"Unblocked."`, `"Approval: agent → ratified."`, `"State: draft → ready."`, then `"Set title, body."` for the
  other fields, joined in that order (`"Status: in_progress → done. Unblocked."` when a blocked ticket leaves the
  queue). A create without one says what was created, with its approval when it starts approved (`"Created dev ticket
  (approval: owner)."`); a move, rename or restore says where it went (`"Moved to the top."`, `"Restored revision
  2."`). Give a note when the reason is not obvious from the change. Before 2026-10-27 a status, block, unblock or
  approval change, and a create with an approval, were refused without one.
* **One write, one event.** Every write appends exactly one event to the record it changes (creating a spec with
  milestones appends one `create` event to each record it creates: the spec, each milestone, each document).
  An update that changes nothing is refused unless it carries a non-blank note, which is then recorded as a `note`
  event (**Add note**: the one write a note is required for). A phase's **release** and **recall** append one event
  to each ticket they move and then one to the phase, in one transaction (see *Phases and the roadmap*).
* **Timestamps** are RFC 3339 UTC to the second (`2026-10-27T06:25:33Z`).
* **History.** Record reads (`GET` a ticket, document, spec, milestone, concept or phase) include `events`, oldest first.
  `?history=false` returns the record with `"events": []`. The MCP `tracker_get` sends `history=false` unless the agent asks for the
  history (`history: true`, or `history: N` for the last N, trimmed on the MCP side; rag-t0039).

### Errors
Every error is JSON: `{"error": "<message for a person>"}`.

| Status | When |
|---|---|
| 400 | Refused: a malformed body or query, an unknown field, a bad enum value, a disallowed transition, an update with nothing to change and no note, a taken path, a bad link target. The message says which |
| 404 | The record does not exist (ticket, document, revision, spec, milestone, concept, attachment, phase; a phase named under another project does not exist there) |
| 409 | A document edit, write or restore named a `base_revision` that is no longer current. Body: `{"error", "current_revision": <int>, "current": <Document view, events omitted>}` so a client can show the newer text without another request. Nothing was written |
| 503 | The tracker store did not open on this server (`/info` reports `"tracker_ready": false`) |
| 500 | Storage failure |

An unmatched path under `/tracker/` is a 404.

### Enumerations

| Name | Values |
|---|---|
| ticket `type` | `dev`, `design`, `recon`, `analysis`, `gate`, `request` (added 2026-10-27, rag-t0044: the owner's idea, broken into tickets by the manager; never dispatched) |
| ticket `status` | `pending`, `in_progress`, `done`, `failed`, `cancelled`, `deferred` (added 2026-10-27, rag-t0017), `review` (added 2026-10-27, rag-t0024: waiting on the owner to confirm or review it) |
| `block_reason` | `redesign`, `review`, `dependency` (added 2026-10-27, rag-t0018: waits on the tickets in `depends_on`). `approval` was retired 2026-10-27 (rag-t0024): a body sending it is 400, `the block reason approval was replaced by the status review (rag-t0024): set status review to put work in front of the owner` |
| `intensity` (gates) | `quick`, `standard`, `full` |
| `approval` | `unapproved`, `agent`, `ratified`, `owner` |
| `surface` | `web`, `mcp` |
| event `kind` | `note`, `create`, `status`, `block`, `unblock`, `approve`, `move`, `edit`, `link`, `assign`, `acknowledge`, `rename`, `release`, `recall` (spec:roadmap D18: a phase's, each the one frame its write sends) |
| event target kind (`target_kind` on the feed) | `item`, `spec`, `milestone`, `concept`, `document`, `phase` |
| phase `state` | `planned` (on the roadmap, its tickets frozen), `released` (its tickets have joined the queue, and keep their link), `archived` (out of the roadmap). `complete` is derived, never a state (D15) |
| spec `state` | `draft`, `ready`, `in_development`, `done`, `superseded` |
| milestone `state` | `not_started`, `in_progress`, `done` |
| concept `state` | `open`, `refining`, `refined`, `archived` |
| document `kind` | `spec` (a spec's master), `milestone`, `concept`, `doc` (free-standing) |
| link `kind` | `spec`, `milestone`, `concept`, `ledger`, `item`, `from` and `became` (added 2026-10-27, rag-t0044: a ticket's request, and its reverse on the request, written by the server only) |

### Names and ids
* **Project**: a repository name: letters, digits, `.`, `_`, `-`, starting with a letter or digit, at most 64
  characters. `items`, `docs`, `attachments` and `projects` are reserved. A project is created by its first write;
  reading an unknown project returns empty lists.
* **Ticket id**: `<project>-t<seq:04>` (`ubu-t0042`), minted by the server, never reused.
* **Document id**: `<project>-d<seq:04>` (`ubu-d0007`).
* **Phase id**: `<project>-p<seq:04>` (`ubu-p0001`), minted by the server, never reused.
* **Slugs** (spec, concept) and **milestone codes**: lowercase letters, digits and `-`, starting with a letter or
  digit (`tracker`, `power-generation`, `m03`).
* **Document path**: relative, `/`-separated segments of letters, digits, `.`, `_`, `-` (no `.` or `..`), ending in
  `.md`, at most 300 characters.
* **Links** are `{"kind": "<link kind>", "target": "<string>"}`:

  | kind | target | checked |
  |---|---|---|
  | `spec` | spec slug (`tracker`) | exists in the same project |
  | `milestone` | `<spec slug>/<code>` (`tracker/m01`) | exists in the same project |
  | `concept` | concept slug | exists in the same project |
  | `item` | ticket id, any project (`rag-t0003`) | exists, and is not the ticket itself |
  | `ledger` | ledger topic id, any project (`ubu-1592`) | non-blank, no whitespace (held as text) |


Records
-------
### Ticket
```json
{
  "id": "ubu-t0042",
  "project": "ubu",
  "type": "gate",
  "title": "Standard gate",
  "body": "markdown: the brief, the scope, the acceptance",
  "status": "pending",
  "blocked": false,
  "block_reason": null,
  "block_note": null,
  "approval": "agent",
  "assignee": "dev-3",
  "intensity": "standard",
  "release": true,
  "parallel": false,
  "draft": false,
  "depends_on": [],
  "phase": null,
  "frozen": false,
  "queued": true,
  "prev_id": "ubu-t0041",
  "next_id": null,
  "links": [{"kind": "ledger", "target": "ubu-1592"}],
  "labels": ["Biomes", "Physics"],
  "created_at": "2026-10-27T06:00:00Z",
  "updated_at": "2026-10-27T06:05:00Z",
  "done_at": null,
  "acknowledged_at": null,
  "events": [ Event, … ]
}
```
* `queued` means **in the queue's list**: true for `pending`, `in_progress`, `failed`, `deferred` and `review`, unless
  it is frozen, and `prev_id` / `next_id` are then its neighbours (`null` at an end). **False while frozen**, with
  `prev_id` / `next_id` its neighbours in the phase's list. Done and cancelled tickets have both `null`.
* **`phase`** (spec:roadmap R4, D2): the id of the phase it belongs to, `null` for none. **Kept for life**: a released
  ticket still names its phase, and so does a frozen one taken to done or cancelled. It is cleared only by a write
  that says so (`phase: ""`). A request never has one (D4).
* **`frozen`** (spec:roadmap R6, D4–D6): held out of the queue in a planned phase, and in **no queue figure**
  (D20): not in the queue view's lists, `tracker_next`, a gate's batch, the counts, a label's `queued`, or
  `GET …/items` without `?phase=`. Its events are **roadmap events** (see Event). Only a `pending` ticket can be frozen,
  blocked or not (D4; a deferred one is resumed first). **Its status moves only to `done` or `cancelled`**, which
  clears `frozen` and takes it off the phase's list, keeping `phase`; any other status is 400, naming "pull it to the
  queue first" (D5). Reopened, it joins the top of the queue, unfrozen. Its **block, draft, labels, links, body and
  assignee** are independent and editable while frozen (D6): a `dependency` block works across the boundary either
  way, and an automatic unblock fires as usual. A frozen ticket may be a draft (D16).
* `deferred` (rag-t0017) is work put aside on purpose. It is independent of `blocked`: a ticket can be both, and is
  then shown as deferred.
* `review` (rag-t0024) is work waiting on the owner to confirm or review it. It is independent of `blocked` too, and
  shown as review when both.
* `type: "request"` (rag-t0044) is the owner's idea with how to prioritise it. It never has gate fields and is
  never `parallel` (both 400); it is queued and keeps its place like any ticket, but the queue view lists it only
  under `requests`, whatever its status or block, so nothing that reads `queue` sees it.
* **`draft`** (added 2026-10-30, owner): the owner is still writing it. Created with `draft: true`, published with
  `draft: false` on an update (`true` makes it a draft again). A queued draft is listed only under the queue view's
  `drafts`, whatever its type, status or block, so nothing that dispatches work sees it; it keeps its list place,
  so publishing puts it there. Its events are **draft events** (see Event), left out of the feed by default.
* **`from` and `became` links** (rag-t0044): `{"kind": "from", "target": "<request id>"}` on a ticket names the
  request it was broken out of: a ticket of type `request` in the ticket's own project (else 400: `… names a
  request`, `… own project`, `no ticket …`), never on a request itself (400: `cannot come from another request`).
  Adding it (on create, or `add_links`) adds `{"kind": "became", "target": "<ticket id>"}` to the request in the
  same transaction, with a `link` event on the request (`Became ubu-t0051.`, `fields.links_added`); removing it
  (`remove_links`) removes the reverse (`No longer became ubu-t0051: its from link was removed.`). A body naming
  `became` (create, `add_links`, `remove_links`) is 400, pointing at `from`; a concept refuses both kinds. The
  integrity check reports a `from` without its `became`, a `became` without its `from`, and a `from` naming
  anything but a request.
* `block_reason` is set while `blocked`; `block_note` is the note the block was made with, `null` when it had none.
* `intensity` is set on a gate and `null` otherwise; `release` is only ever `true` on a gate.
* `parallel` (added 2026-10-27, rag-t0013): the ticket **may start before the gates above it clear, and still lands
  after them**. Never `true` on a gate. It changes nothing in the list or the queue view; `tracker_next` offers such
  a ticket while a gate above it is pending. An older database gains the column on open, every row `false`.
* `depends_on` (added 2026-10-27, rag-t0018): the ids of the tickets it waits on, in the order given, **only while it
  is blocked with reason `dependency`**; `[]` otherwise (any unblock, another reason, or leaving the queue clears
  it). When a ticket becomes `done`, every ticket blocked with `dependency` whose `depends_on` are now all `done` is
  unblocked in the same transaction, with an `unblock` event of its own (below). A dependency that is cancelled or
  fails unblocks nothing: a person decides then.
* `done_at` is set when it went `done` (cleared by a reopen); `acknowledged_at` when the owner acknowledged it.
* `links` are sorted by kind, then target.
* `labels` (added 2026-10-27, rag-t0027): free-text subject tags, `[]` when it has none. Each is trimmed (inner runs
  of whitespace become one space), non-blank, at most **32** characters, with no comma and no control character; a
  ticket carries at most **10**. They match **case-insensitively within the project, whose existing casing wins**: a
  write of `physics` when another ticket of the project carries `Physics` stores `Physics` (a ticket that alone
  carries a label may change its casing). Duplicates are merged, the first kept. Sorted case-insensitively, so the
  order a write gives never matters. An older database gains the `item_labels` table on open, every ticket `[]`.

### Event
```json
{
  "event_id": 17,
  "ts": "2026-10-27T06:05:00Z",
  "author_email": "you@example.com",
  "agent": "Claude Opus 5.5",
  "surface": "mcp",
  "kind": "status",
  "body": "dispatched to dev-3",
  "fields": {"status": "in_progress", "assignee": "dev-3"},
  "before": {"status": "pending", "assignee": null},
  "draft": false,
  "roadmap": false
}
```
`fields` holds every field the write set, with its new value, so replaying the events reconstructs the record.

**`draft`** (added 2026-10-30, owner) marks a **draft event**: written while its record was a draft, so the feed
leaves it out unless asked (`drafts=true`). It is stamped at write time: the record is a draft after the write,
except the write that made a published record a draft (`fields.draft: true`, `before.draft: false`), which is
announced once so whoever worked from it knows to stop. Publishing (`draft: false`) is never a draft event: it is
the record's arrival, an `edit` whose `fields` carry `draft: false` and, on a ticket, its `type` (so a published
request's frame says `{draft: yes → no; type: request}`). A ticket and a document hold their own flag; a concept
is a draft while **its document** is. **Specs and milestones are never drafts** (owner, 2026-10-30): a spec has
its own `draft` state and is the agents' work, so every change to one is sent. A replay after publishing still leaves the draft history
out. Every event written before drafts existed reads `false`.

**`roadmap`** (spec:roadmap D17, R8) marks a **roadmap event**: the feed leaves it out unless asked (`roadmap=true`), so
planning wakes no monitor. It is stamped at write time, as `draft` is, and it is true on:

* every event of a **phase**, except its `release` and `recall`, which are its one frame each (D18);
* every event of a **ticket frozen after the write** (read from the row), or **frozen before it** (`before.frozen` is
  true: every write that thaws a ticket records `frozen` in `fields` and `before`, which is a release, a pull, a
  removal from its phase, and a frozen ticket's done or cancel);
* every event **but a create** whose `fields` name `phase`: a link-only write on an unfrozen ticket is a roadmap change
  too.

It is false on a **create in a released phase** (a queue ticket arriving), on the **automatic unblock** of an unfrozen
ticket by a frozen one's done (that ticket is in the queue), and on a request's **`link`** event for a `from` on a
frozen ticket (the event is on the request, and `link` is out of the default kinds anyway). Unlike a draft's flip,
nothing is announced on the way in or out. A frozen draft's events carry both flags, and a feed needs `drafts=true`
**and** `roadmap=true` to see them. Every event written before the roadmap existed reads `false`.

`before` (added 2026-10-27, rag-t0038) holds what those fields were before the write, keyed the same way: the "from"
of each from → to. It is `null` on a `create` (nothing came before) and on every event written before it was
recorded (those name their new values only; nothing is back-filled). A key with no prior value to give is absent
from it (`links_added`, `links_removed`, `unblocked_by`); `blocked` and `block_reason` are recorded together, so an
unblock says which reason it lifted. A `move` records the ticket's new neighbour as `prev_id` in `fields` (`null`: the
top) and the old one in `before`. A document `edit` or `restore` records the prior `revision`, a `rename` the prior
`path` and `title`; spec, milestone and concept updates the prior `title`, `state`, `approval` and `order`.

**Who wrote it.** `agent` is `"Owner"` on every `web` write that named no agent, stamped by the server whatever
the client sends (rag-t0038); the web UI never sends one. Web events, revisions and attachments recorded before
that read `"Unknown"`, and are **rewritten to `"Owner"` by a one-off open-time migration** (idempotent: only a `web`
row whose agent is exactly `Unknown` changes, and no event is appended), so every reader sees one value. An `mcp`
write with no agent is still `"Unknown"`.
Ticket keys: `type`, `title`, `body`, `status`, `done_at`, `acknowledged_at`, `blocked`, `block_reason`,
`depends_on`, `unblocked_by`, `approval`, `assignee`, `intensity`, `release`, `parallel`, `labels` (the whole set,
on create and on every change: rag-t0027), `links` (on create),
`links_added`, `links_removed`, `place` (create and move: `"top"`, `"bottom"`, `{"before": id}`, `{"after": id}`),
`phase`, `frozen`.
Phase keys: `title`, `body`, `state`, `released_at`, `tickets` (a release's or recall's count of the tickets it moved),
`placed` (a release's place, in words: `bottom`, `top`, `before <id>`, `after <id>`), `place` (create and move, as on a
ticket), `prev_id` (a move: the phase's new neighbour on the roadmap, `null` for the top, with the old one in `before`).

**The automatic unblock** (rag-t0018) is an `unblock` event on the waiting ticket, written in the same transaction as
the write that finished its last dependency and **by that write's author** (its `author_email`, `agent` and
`surface`: the unblock is a consequence of that write, so it carries its author rather than an invented system
identity); its body is generated, `Unblocked: rag-t0012 is done.` (`Unblocked: rag-t0012 is done, the last of
rag-t0010, rag-t0012.` with several), and its fields are `{"blocked": false, "depends_on": [], "unblocked_by":
"rag-t0012"}`. It follows the triggering ticket's own event (a higher `event_id`). Document keys: `path`, `old_path`, `kind`, `title`,
`revision`, `base_revision`, `replacements` (a count), `restored_from`. Spec, milestone and concept keys: `title`,
`state`, `approval`, `order`, `path`, `milestones`, `links`, `links_added`, `links_removed`.

When one write changes several things, its `kind` is the first that applies of `status`, `block`, `unblock`,
`approve`, `assign`, `link`, `edit` (and `note` when only a note was given). A `phase` or `frozen` write is a `move`
when a list changed (with the ticket's new `prev_id`) and a `link` when only the link did.

### Document
```json
{
  "id": "ubu-d0007",
  "project": "ubu",
  "path": "specs/audio/m03-music.md",
  "kind": "milestone",
  "title": "Music",
  "revision": 4,
  "spec": "audio",
  "milestone": "m03",
  "concept": null,
  "created_at": "…",
  "updated_at": "…"
}
```
`revision` is always the **current** revision: what an edit names as its `base_revision`. `spec` / `milestone` /
`concept` name the record that owns it (`null` for a free-standing `doc`). `draft` (added 2026-10-30, owner) is
true while the owner is still writing it: its events, and its concept's, are draft events (see Event). Set it on
create (`draft: true` on the free-document and concept create routes) and change it with
`POST /tracker/docs/{id}/draft`. Always false on a spec's or a milestone's document.

The **document view** (every `GET` of one document, and every document write's response) adds:
```json
{
  "...Document fields...": "",
  "body": "# Music\n…",
  "body_revision": 4,
  "redirected_from": null,
  "events": [ Event, … ]
}
```
`body_revision` is the revision `body` is from (the current one unless `?revision=` asked for an older one);
`redirected_from` is the path asked for when it was an old path that redirected here.

### Revision
```json
{"revision": 3, "author_email": "…", "agent": "…", "surface": "web", "ts": "…", "message": "Tightened m03", "size": 4182}
```
`size` is the body's length in bytes. Bodies are read with `GET …?revision=N`.

### Spec, milestone, concept
```json
{
  "project": "ubu", "slug": "audio", "title": "Audio", "state": "in_development", "approval": "owner",
  "doc_id": "ubu-d0005", "path": "specs/audio/master.md",
  "milestones": [ Milestone, … ],
  "created_at": "…", "updated_at": "…",
  "events": [ Event, … ]
}
```
```json
{
  "project": "ubu", "spec": "audio", "code": "m03", "title": "Music", "order": 3,
  "state": "not_started", "approval": "unapproved",
  "doc_id": "ubu-d0007", "path": "specs/audio/m03-music.md",
  "created_at": "…", "updated_at": "…",
  "events": [ Event, … ]
}
```
```json
{
  "project": "ubu", "slug": "power-generation", "title": "Power generation", "state": "refined", "approval": "owner",
  "links": [{"kind": "spec", "target": "energy"}],
  "doc_id": "ubu-d0011", "path": "concepts/power-generation.md",
  "created_at": "…", "updated_at": "…",
  "events": [ Event, … ]
}
```
Milestones inside a spec carry no `events`; lists (`GET …/specs`, `GET …/concepts`) carry no `events` at all. A
spec's milestones are in `order` (ascending), then by code. `doc_id` and `path` follow the document through a
rename.

### Attachment
```json
{
  "id": 12, "project": "ubu",
  "sha256": "3fa9c2e1b07d…64 hex…", "ref": "att:3fa9c2e1b07d",
  "name": "terrain.png", "media_type": "image/png", "size": 48213,
  "author_email": "…", "agent": "…", "surface": "web", "uploaded_at": "…"
}
```
A document embeds one as `![terrain](att:3fa9c2e1b07d)`; a client resolves `att:<hash>` to
`GET /tracker/attachments/<hash>`.


Routes
------
### Projects and the queue

#### `GET /tracker/projects`
`{"projects": [{"name": "ubu", "created_at": "…", "queued": 12, "requests": 1, "drafts": 1, "blocked": 2, "deferred": 1, "review": 1, "done_unacknowledged": 3, "frozen": 45}]}`,
by name. `queued` counts requests, review, blocked and deferred tickets too; `requests` counts every queued request
(rag-t0044), whatever its status or block; `blocked` counts blocked tickets that are neither requests, deferred nor
in review, `deferred` every deferred ticket and `review` every ticket in review, blocked or not, requests excluded
(each as the queue view sections them; `deferred` added 2026-10-27, rag-t0017; `review` the same day, rag-t0024;
`requests` the same day, rag-t0044). `drafts` (added 2026-10-30) counts the queued drafts of any type; a draft is
counted under no other bucket but `queued`. **`frozen`** (spec:roadmap D20) counts the tickets frozen in a phase, drafts
included; a frozen ticket is in **no other bucket**, `queued` and `drafts` among them.

#### `GET /tracker/{project}` — the queue view (D14, R12)
```json
{
  "project": "ubu",
  "exists": true,
  "requests": [ Item, … ],
  "drafts":  [ Item, … ],
  "done":    [ Item, … ],
  "review":  [ Item, … ],
  "queue":   [ Item, … ],
  "blocked": [ Item, … ],
  "deferred": [ Item, … ],
  "frozen": 45
}
```
* **`frozen`** (spec:roadmap D20): how many of the project's tickets are frozen in a phase, drafts included. **Every
  list leaves them out**, so the view is the same with or without a planned phase but for this count. Read them with
  `GET …/phases/{id}?tickets=true` or `GET …/items?phase=<id>`.
* **`requests`** (added 2026-10-27, rag-t0044): the queued tickets of type `request`, **whatever their status or
  block**, in list order. A request is in no other array while queued (done, it is under `done`). The dashboard
  shows them above Review and `tracker_queue` first; `tracker_next` never reads them. A client that predates it
  may read its absence as empty.
* **`drafts`** (added 2026-10-30, owner): the queued tickets with `draft: true`, **of any type, status or block**
  (requests too), in list order. A draft is in no other array while queued (done, it is under `done`). The
  dashboard shows them first; `tracker_queue` and `tracker_next` count them in the footer only. A client that
  predates it may read its absence as empty.
* **`done`**: tickets with status `done` and no `acknowledged_at`, **oldest first, newest last** (by `done_at`, then
  id), so the latest finished sits just above the queue, as the queue reads (*changed 2026-10-27, rag-t0029*: it
  was newest first).
* **`review`** (added 2026-10-27, rag-t0024): the tickets in review, **blocked or not**, in list order, between
  `done` and `queue` (the dashboard and `tracker_queue` show them above the queue). Each keeps its place: sending
  it back (`review` → `in_progress` or `pending`) leaves it where it was. A client that predates it may read its
  absence as empty.
* **`queue`**: the linked list in order, head first, **gates included** as ordinary tickets of `type: "gate"` (draw
  them as markers from `intensity` and `release`), and **without requests, drafts, review, blocked or deferred tickets**. Statuses here are
  `pending`, `in_progress` or `failed`.
* **`blocked`**: the blocked queued tickets that are neither deferred nor in review, in list order. Each keeps its place in the list:
  unblocking puts it back where it was, and `prev_id` / `next_id` still name its true neighbours (which may be
  blocked or deferred too).
* **`deferred`** (added 2026-10-27, rag-t0017): the deferred tickets, **blocked or not**, in list order, after
  `blocked`. Each keeps its place: resuming it (`deferred` → `pending`) puts it back where it was. A client that
  predates it may read its absence as empty.
* Tickets carry their `links` and `body`; no `events`.
* The route always returns the whole view. The MCP tools bound what they print from it on their own side
  (`tracker_queue`'s `limit`, `until_gate`, `sections`; `tracker_next`, rag-t0006, which also lists the
  `parallel` tickets below the batch's gate, rag-t0013): there are no query
  parameters here, and the dashboard keeps the full list.
* **Conditional requests**: the response has a strong `ETag` (a hash of the body) and `Cache-Control: no-cache`.
  A request with a matching `If-None-Match` gets **304** with no body. Any write that changes the view changes the
  ETag.
* An unknown project is 200 with `"exists": false` and empty lists; an invalid project name is 400.

To reorder relative to what the dashboard shows, use the neighbours in `queue`: a drop between rows A and B is
`move` with `after: A` (or `before: B`). Review, blocked or deferred tickets sitting between them in the list are not
disturbed. A deferred or review ticket is a valid anchor and can itself be moved.

#### `GET /tracker/{project}/check` — the integrity check (D5)
`{"project", "ok": true, "queued": 5, "frozen": 45, "order": [ids, head first], "problems": []}`. `queued` and `order`
are the queue's list only; `frozen` counts the tickets frozen in a phase. `problems` lists each fault in
words (a broken link, a cycle, a queued ticket the walk misses, a stale head or tail; since rag-t0018 also a
`depends_on` on a ticket not blocked with `dependency`, one naming no ticket or another project's, a ticket blocked with
`dependency` on nothing, or one whose dependencies are all done); `ok` is `problems` being empty.
Always 200.

**The roadmap's problems** (spec:roadmap D3): a frozen ticket that is not `pending`, has no phase, or is in a phase not
planned; a ticket naming a phase of another project, or one that does not exist; a request with a phase; a planned
phase whose walk does not cover exactly its frozen tickets (a cycle, a stale head or tail, a ticket it reaches that is
not frozen in it, one it misses); a released or archived phase holding a head, a tail or a roadmap link; and a roadmap
whose walk, either way, does not cover exactly the planned phases (a cycle, a stale end, a phase it reaches that is not
planned or not of this project, one it misses, or two directions that disagree).

#### `GET /tracker/{project}/velocity` — how fast its tickets get done (spec:velocity D26)
```json
{
  "project": "ubu",
  "now": "2026-11-02T22:55:45Z",
  "in_progress": 4, "in_review": 0,
  "pending": 158, "blocked": 41,
  "deferred": 7,
  "remaining": 162,
  "windows": {
    "24h": {"done": 89, "active_seconds": 86400, "velocity_per_day": 89.0, "eta_days": 1.8202},
    "7d":  {"done": 380, "active_seconds": 486940, "velocity_per_day": 67.4, "eta_days": 2.4036}
  }
}
```
* The counts are the project's tickets **as they are now**, whatever the window: `in_progress` (of which
  `in_review`), `pending` (of which `blocked`), `deferred` and `remaining` = `in_progress` + `pending`. What each
  holds is in § *Velocity* below.
* `windows` are the last 24 hours and the last 7 days, ending at `now`: in each, `done` (tickets that reached done
  in it), `active_seconds`, `velocity_per_day` (unrounded; a client rounds it) and `eta_days`, `remaining ÷ velocity_per_day` in days,
  **unrounded** (a number with a fraction; a client words it, from hours to months: owner request rag-t0062,
  where it was an integer rounded up before), **`0` with nothing remaining** and **`null` when unknown** (work
  remains and nothing was done in the window).
* An unknown project answers the same shape with zeros (and `eta_days` 0.0), not a 404; an invalid project name is
  400. Read-only: it writes no event and takes no author fields.
* `Cache-Control: no-store` and **no `ETag`**: the windows move with the clock, so the figures change while
  nothing is written. The dashboard's widget reads it beside the queue view; `tracker_queue` ends with a line read
  from it (`Velocity (7 d): 67/day · 24 h: 89/day · ETA 2.4 days`), the ETA worded as the widget words it.

#### `GET /tracker/{project}/report?window=24h|7d` — the velocity report (spec:velocity D27)
```json
{
  "project": "ubu", "window": "7d",
  "start": "2026-10-26T22:55:45Z", "end": "2026-11-02T22:55:45Z",
  "velocity": {"done": 380, "active_seconds": 486940, "velocity_per_day": 67.4, "eta_days": 2.4036},
  "buckets": [
    {"start": "2026-10-26T22:55:45Z", "remaining": 171, "added": 0, "done": 1},
    {"start": "2026-10-26T23:00:00Z", "remaining": 168, "added": 2, "done": 5}
  ],
  "states": {
    "pending":     {"count": 412, "mean_seconds": 15840.5, "median_seconds": 3600.0, "p90_seconds": 52200,
                    "open": 158, "oldest_open_seconds": 1209600},
    "in_progress": {"count": 401, "mean_seconds": 2710.2, "median_seconds": 1800.0, "p90_seconds": 7260,
                    "open": 4, "oldest_open_seconds": 5400},
    "review":      {"count": 0, "mean_seconds": null, "median_seconds": null, "p90_seconds": null,
                    "open": 0, "oldest_open_seconds": null},
    "deferred":    {"…": "as above"},
    "blocked":     {"…": "as above"}
  },
  "mttc": {"count": 371, "mean_seconds": 3120.0, "median_seconds": 2400.0, "never_in_progress": 9},
  "mttr": {"count": 12, "mean_seconds": 900.0, "median_seconds": 600.0, "confirmed": 10, "sent_back": 2}
}
```
* `window` is `24h` or `7d`, **`7d` when absent**; anything else (and any other query parameter) is 400. The window
  ends at `end`, when the report was computed, and starts a day or seven before it, at `start`. **Every block but
  `buckets` follows the window**, and each carries its counts, so a small sample is plain.
* `velocity` is the window's figures exactly as `GET …/velocity` gives them (its `eta_days` from the remaining now).
* `buckets` are **hourly, on UTC hours, over the last 7 days whatever the window**, oldest first: the first runs
  from seven days before `end` to the next hour, the last from the hour before `end` to `end` (so 168 or 169). A
  bucket holds what happened at or after its `start` and before the next one's (the last up to and including
  `end`): `added` (tickets created in it, or first published from a draft in it), `done` (tickets that reached
  done in it, each once a bucket) and `remaining` (in progress + pending, as in the velocity counts) **at its end**,
  after everything in it. A client groups them into its own days (the web UI sums them into the browser's local
  days: `added` and `done` summed, `remaining` the day's last hour).
* `states` are `pending`, `in_progress`, `review` and `deferred` (a ticket's status) and `blocked` (its block, its
  own track: a blocked pending ticket is both for that time), each over the **stretches that ended in the window**:
  `count`, `mean_seconds`, `median_seconds` (for an even count the mean of the middle two) and `p90_seconds`
  (nearest rank, so one of the lengths), `null` when the count is 0; and those **still open now**, `open` and
  `oldest_open_seconds` (`null` with none open).
* `mttc` is over the tickets done in the window (each once, by its latest completion in it): the time each was in
  progress **since it was last reopened** (after its latest earlier `done` or `cancelled`), however long ago that
  was; `never_in_progress` counts those done without it, which are left out of the mean.
* `mttr` is over the review stretches that ended in the window: `confirmed` when the ticket went on to done,
  `sent_back` otherwise.
* Requests are in no figure, and neither is a draft (see § *Velocity*). An unknown project answers the same shape
  with buckets of zeros and `null`s in `states`, not a 404; an invalid project name is 400. Read-only, no author
  fields, `Cache-Control: no-store` and no `ETag`, as the velocity read.

#### `POST /tracker/{project}/ack-done`
Body: the author fields only. Stamps every done, unacknowledged ticket `acknowledged_at` (one `acknowledge` event
each). Response: `{"project": "ubu", "acknowledged": ["ubu-t0040", "ubu-t0041"]}`.

### Tickets

#### `GET /tracker/{project}/items?status=<status>&label=<label>&phase=<phase id>`
`{"project", "items": [Item, …]}`, oldest first, no events. Every ticket of the project **that is not frozen**, done and
cancelled included;
`status` filters (any ticket status, `deferred` and `review` included; `blocked` is a flag, not a status, and is 400).
`label` (rag-t0027) keeps the tickets carrying it, matched case-insensitively after the same trimming a write gets; a
blank one is no filter. Both may be given.

**`phase`** (spec:roadmap D20) lists that phase's linked tickets instead, **frozen ones included**, in the order a phase
read gives them: frozen in the phase's order, then unfrozen queued in the queue's order, then the rest by age. `status`
and `label` filter them as above. A phase that does not exist in this project is 404, a blank `phase=` included.

#### `GET /tracker/{project}/labels` — the label vocabulary (rag-t0027)
```json
{"project": "ubu", "labels": [{"label": "Biomes", "count": 3, "queued": 1}, {"label": "Physics", "count": 7, "queued": 4}]}
```
Every label the project's tickets carry now, once each in the project's casing, sorted case-insensitively. `count` is
the tickets carrying it, whatever their status, frozen ones included; `queued` how many of those are in the queue
(pending, in progress, failed, deferred, review, and not frozen). A label no ticket carries any more is not listed. An unknown project has `[]`; an invalid
project name is 400. The web app's label editors read it for their suggestions.

#### `POST /tracker/{project}/items` — create
| Field | | |
|---|---|---|
| `type` | required | ticket type |
| `title` | required | non-blank |
| `body` | optional | markdown, default `""` |
| `assignee` | optional | |
| `approval` | optional | default `unapproved`, or `agent` when `links` carries a `from` (rag-t0044: a ticket broken out of a request is the agent's breakdown); not `ratified`; an agent sets `owner` only when the owner approved (a request saying its work is approved counts), and says where in `note` |
| `links` | optional | `[Link]` |
| `intensity` | gate: required; others: refused | |
| `release` | optional, gate only | default `false` |
| `parallel` | optional, any type but gate or request | default `false`; `true` on a gate (rag-t0013) or a request (rag-t0044) is 400 |
| `draft` | optional | default `false`; `true` creates the owner's draft (2026-10-30): a draft event, body `Created draft dev ticket.`, `fields.draft: true` |
| `labels` | optional | `[string]`, default `[]` (rag-t0027); the rules under Ticket; a bad label or more than 10 is 400. A create event carrying labels says them in its generated body (`Created dev ticket. Labels: Biomes, Physics.`) and in `fields.labels` |
| `phase` | optional | a phase id, trimmed; **blank is 400** (`phase is a phase id`). Created in it (spec:roadmap D7), below |
| `before` / `after` / `top` / `bottom` | optional, at most one | where it joins: `"before": "<id>"`, `"after": "<id>"`, `"top": true`, `"bottom": true`; default the bottom. An anchor must be queued and not frozen, or, in a planned `phase`, frozen in that phase |
| `note` | optional | the create event's body |
| author fields | required | |

Response: the Ticket with its `create` event. The new ticket is `pending`.

**With `phase`** (D7, D16), by the phase's state:

| Phase | The ticket | Its place | Its event |
|---|---|---|---|
| `planned` | `frozen: true`, `queued: false` | in the phase's list | stamped `roadmap` |
| `released` | `frozen: false`, `queued: true`, linked | in the queue, as any ticket, so a phase grows naturally | not stamped: a queue ticket arriving |
| `archived` | 400: `phase <id> is archived: unarchive it to add a ticket` | | |

A request with a `phase` is 400 (`a request cannot have a phase: …`). An unknown phase is 404; another project's is 400
(`phase <id> belongs to project …`). It may be a draft either way. `default_approval` is as without one.

#### `GET /tracker/items/{id}`
The Ticket with `events`. 404 if unknown.

#### `POST /tracker/items/{id}` — update
Every field optional; absent leaves it alone; a value equal to the current one is not a change.

| Field | |
|---|---|
| `status` | a transition (below) |
| `blocked` | `true` blocks (needs `block_reason`), `false` unblocks |
| `block_reason` | with `blocked: true`, or alone to block or to change the reason |
| `depends_on` | `[ticket id]`, replacing the list (rag-t0018). Only when the reason after the write is `dependency` (given now or already held), which needs at least one; a non-empty list with any other reason, or none, is 400. Each a ticket of the **same project** (another project's id is 400), not the ticket itself, not forming a cycle (a ticket that already waits, directly or through others, on this one); at least one not yet `done`. Blank entries and repeats are dropped |
| `parallel` | `true` or `false`; any type but gate (on a gate, either is 400) |
| `draft` | `false` publishes a draft (`Published.`), `true` makes it a draft again (`Made a draft.`), as an `edit` event (2026-10-30). The same value is not a change |
| `labels` | `[string]`, **replacing the set wholesale** (rag-t0027); `[]` clears them. The rules under Ticket; a bad label or more than 10 is 400. The same set in another order, or with duplicates, is not a change. A change is an `edit` event with `fields.labels` the whole new set and, without a note, the body `Labels: Biomes, Physics.` (`Labels: none.` when cleared) |
| `approval` | `ratified` only from `agent` (the owner confirming an agent's approval). An agent may set `owner` when the owner approved in conversation, and its note says so |
| `assignee` | `""` clears it |
| `title`, `body` | `title` non-blank |
| `add_links`, `remove_links` | `[Link]`; removing a link the ticket does not have is refused |
| `intensity`, `release` | gates only |
| `phase` | a phase id, or `""` (trimmed) to remove the link. **Single-purpose**, below |
| `frozen` | `false` pulls a frozen ticket to the queue, `true` freezes it again. **Single-purpose**, below |
| `note` | optional (the body is then generated from the change); alone, it is recorded as a `note` event and must not be blank |
| author fields | required |

**`phase` and `frozen` are single-purpose writes** (spec:roadmap D8, D9): beside anything but a `note` and the author
fields, or beside each other, they are 400, `phase and frozen are written alone, with at most a note`, so a stamped
event can never hide a status change from the feed. (An empty `add_links` or `remove_links` is no field: it says
nothing.) One event, a `move` when a list changed and a `link` when only the link did, stamped `roadmap`, its generated
body saying which (`Frozen in ubu-p0001.`, `Pulled to the queue.`, `Moved to phase ubu-p0002.`, `Linked to phase
ubu-p0001.`, `Removed from ubu-p0001.`).

| Write | The ticket | |
|---|---|---|
| `phase: <planned>` | unlinked from the queue, or from another phase's list, and **frozen at this phase's tail**; so a ticket pulled from this phase freezes again | only a `pending` ticket (D4; `… only a pending ticket can be frozen`, and a deferred one says to resume it first), or one already frozen elsewhere |
| `phase: <released>` | **only the link is written**: it keeps its place in the queue, whatever its status. One frozen in another phase joins the queue's tail, unfrozen | |
| `phase: <archived>` | 400 (`phase <id> is archived: …`) | |
| `phase: ""` | a frozen ticket joins the queue's tail; an unfrozen one stays where it is | |
| `frozen: false` | a pull (D9): a frozen ticket joins the queue's tail, unfrozen, **keeping its link**. One event and **no frame**: it simply appears at the tail for the manager's next `tracker_next` (D18) | |
| `frozen: true` | a re-freeze: joins the tail of its own phase | a `pending`, unfrozen ticket whose phase is planned; else 400 |

Any change on a request is 400 (D4). A write that changes nothing (the phase it already has, `frozen` as it already
stands) is 400: `nothing to update on <id>: its phase already stands so`. An unknown phase or ticket is 404; another
project's phase is 400.

**Status transitions** (anything else is 400):

| From | To |
|---|---|
| `pending` | `in_progress`, `done`, `failed`, `deferred`, `review`, `cancelled` |
| `in_progress` | `pending`, `done`, `failed`, `deferred`, `review`, `cancelled` |
| `failed` | `pending` (stays where it is in the queue), `deferred`, `review`, `cancelled` |
| `deferred` | `pending` (a resume: stays where it is), `in_progress`, `done`, `cancelled` |
| `review` | `done` (confirmed), `in_progress` or `pending` (sent back: stays where it is), `deferred` (stays where it is), `cancelled` |
| `done` | `pending` (a reopen: back into the queue **at the top**) |
| `cancelled` | `pending` (a reopen: at the top) |

`pending` → `done` (and `pending` → `failed`) is allowed so a manager can record quick work without first marking
it in progress (the manager's change in m02; m01 refused it). `done` and `cancelled` take the ticket out of the queue
and clear any block. Only a queued ticket can be blocked; a deferred ticket can be (and keeps its block when resumed).
`deferred` (rag-t0017) never moves the ticket in the list; `deferred` → `failed` is refused (resume it first).
`review` (rag-t0024) never moves the ticket either; `review` → `failed` is refused (send it back first), and so is
`deferred` → `review`. `review` → `deferred` was refused too until the owner allowed it on 2026-10-28. A review ticket can be blocked, and keeps its block when sent back.
**A frozen ticket** (spec:roadmap D5) goes only to `done` or `cancelled`, unfrozen and off the phase's list, keeping its
link; any other status is 400, `<id> is frozen in phase <phase> and can only go to done or cancelled: pull it to the
queue first`, checked before the table above. Done this way is no completion (D22).
Response: the updated Ticket with `events`.

#### `POST /tracker/items/{id}/move`
Exactly one of `"before": "<id>"`, `"after": "<id>"`, `"top": true`, `"bottom": true`; optional `note`; author
fields. The ticket and the anchor must both be queued (deferred counts), in the same project, and different. A move never takes a
position number, so it cannot go stale. Response: the Ticket with `events` (a `move` event).

**Reorder within its own list** (spec:roadmap D10): a frozen ticket moves only within its phase, `top` and `bottom`
being the phase's (an anchor elsewhere is 400: `<anchor> is not in phase <id>: a frozen ticket moves only within its
phase`), and an unfrozen one only within the queue (a frozen anchor is 400: `<anchor> is frozen in phase <id>: place
<ticket> relative to a queued ticket`). A frozen ticket's move is stamped `roadmap`.

### Phases and the roadmap
A project's **roadmap** is an ordered list of **phases**: planned work, written up, ordered and reviewed out of the queue
and the default feed. A phase's tickets are **frozen** (see Ticket) until it is **released** into the queue; **recall**
undoes a release. The design is spec:roadmap in the tracker (R1–R8, D1–D29), built in
`crates/core/src/tracker/{phases,roadmap}.rs`.

Conventions, beside those at the head of this document:

* **Every write is a `POST`.** There is no `PATCH`: the reconcile trigger fires on a `POST` only, so a phase's search
  record would never refresh on anything else, and the MCP client has no other verb. `PATCH` on `/phases/{id}` is 405.
* `{project}` is validated (an invalid name is 400). **A phase whose project is not the path's is a 404, in every route
  below, a `GET` included**: `no phase "ubu-p0001" in project rag`. There is no list of phases but the roadmap read
  (`GET …/phases` is 405), and no delete: a phase is archived.
* Each write's reply carries `events`, so a client finds the event's id and kind in the last of them.

#### A phase
```json
{"id": "ubu-p0001", "project": "ubu", "title": "Creatures", "body": "…", "state": "planned",
 "prev_id": null, "next_id": "ubu-p0002", "head_id": "ubu-t0100", "tail_id": "ubu-t0139",
 "released_at": null, "created_at": "…", "updated_at": "…",
 "size": {"frozen": 40, "open": 0, "done": 0, "cancelled": 0, "drafts": 1, "blocked": 2, "total": 41, "complete": false},
 "events": [ Event, … ], "tickets": [ Ticket, … ], "would_wait": [{"ticket": "ubu-t0090", "on": "ubu-t0101"}]}
```
* `body` is markdown, and `state` as under Enumerations.
* `prev_id` / `next_id`: its neighbours on the roadmap, **planned phases only** (`null` otherwise and at an end).
* `head_id` / `tail_id`: the ends of its list of frozen tickets, **planned phases only** (`null` when it holds none).
* `released_at` is **always present**, `null` while it is not released; a client tells a phase from a ticket by it.
  A recall clears it. An archived phase keeps it, which is how unarchiving knows where to return.
* **`size`** (D25) is from its linked tickets now: `frozen`, `open` (unfrozen, not done or cancelled), `done` and
  `cancelled`, **each leaving drafts out**; `drafts` (every linked draft, whatever its status); `blocked` (of `frozen`
  and `open`); `total` (every linked ticket). `complete` (D15) is derived and not stored: a **released** phase whose
  linked tickets, at least one, are all `done` or `cancelled`, by status alone, so a pending draft is open and
  reopening a ticket makes it incomplete again. Show a released phase as `done of total`.
* **`tickets`** and **`would_wait`** are present **only with `tickets=true`**. `tickets` are its linked tickets in full,
  with no events: frozen in the phase's order, then unfrozen queued in the queue's order, then the rest by age.
  `would_wait` is below.

#### `GET /tracker/{project}/phases/{id}?history=<bool>&tickets=<bool>`
The phase. `history` defaults to true, `tickets` to false; any other query parameter is 400.

#### `POST /tracker/{project}/phases` — create
| Field | | |
|---|---|---|
| `title` | required | non-blank |
| `body` | optional | markdown, default `""` |
| `before` / `after` / `top` / `bottom` | optional, at most one | where it joins the roadmap, default the bottom; an anchor names a **planned phase of this project** |
| `note` | optional | the `create` event's body, else `Created phase.` |
| author fields | required | |

Response: the phase, `planned`, with its `create` event (`fields`: `title`, `state`, `place`). The project is created by
this write if it is new. Refused: a blank title, more than one place, an anchor that is unknown, of another project or
not planned. A refused create takes no id.

#### `POST /tracker/{project}/phases/{id}` — title and body
`title`, `body`, `note`, each optional, and the author fields, **in any state**. One `edit` event, or a `note` event when
only a note was given. A call that changes nothing and says nothing is 400 (`nothing to update on <id>: …`). A blank
`title` is 400; `state` is not a field here (400), and goes by the routes below. Response: the phase.

#### `POST /tracker/{project}/phases/{id}/move`
Exactly one of `before`, `after`, `top`, `bottom`, as a ticket's move; optional `note`; author fields. One `move` event
(`fields`: `place`, `prev_id`). Refused: a phase not planned (`… only a planned phase moves on the roadmap`, D10), no
place or more than one, an anchor that is the phase itself, unknown, of another project or not planned. Response: the
phase.

#### `POST /tracker/{project}/phases/{id}/release`
| Field | | |
|---|---|---|
| `before` / `after` / `top` / `bottom` | optional, at most one | where its tickets join the queue, default the bottom; an anchor names a **queued, unfrozen ticket of this project** |
| `note` | optional | follows `Phase released.` in the event's body, and never replaces it |
| author fields | required | |

In one transaction (D11): its list joins the queue, in order, at that place; `frozen` clears on its tickets; state
`released`, `released_at` now; it leaves the roadmap; its head and tail empty. A phase with no frozen tickets may be
released, and is marked so. A draft moves too, still a draft, so it is undispatched and under the queue view's `drafts`
(D16). Refused, with nothing changed: a phase not planned (`… only a planned phase can be released`), more than one
place, an anchor that is unknown, of another project, not queued or **frozen**.

Each moved ticket gets its own `move` event, stamped `roadmap` (`fields: {"frozen": false}`, `before: {"frozen":
true}`, body `Released with phase ubu-p0001.`), so its history explains its state. The phase's `release` event is written
**last**, so it holds the write's last id, and is the **one frame** a monitor sees (see *The event feed*).

Response:
```json
{ …the phase…, "moved": 40, "placed": "bottom", "waiting": [{"ticket": "ubu-t0090", "on": "ubu-t0101"}] }
```

#### `POST /tracker/{project}/phases/{id}/recall`
`note` (following `Phase recalled.`) and the author fields. In one transaction (D12): every linked ticket of status
`pending`, **blocked or a draft or neither**, freezes and returns to the phase's list **in its current queue order**;
state `planned`, `released_at` cleared; the phase joins the **top** of the roadmap, as it is next. Tickets of any other
status (in progress, in review, failed, deferred, done, cancelled) **stay where they are, keeping the link**; a later
release adds only the frozen tickets, at the tail unless placed. Refused: a phase not released (`… only a released phase
can be recalled`). Events as a release's (`Recalled with phase ubu-p0001.`, and `recall` last). A ticket's old place in
the queue is not kept. Response: as a release's, with `"placed": null`.

**`moved`, `placed`, `waiting`.** `moved` is how many tickets the write moved. `placed` is a release's place in words:
`bottom`, `top`, `before <id>` or `after <id>`. **`waiting`** (D13) names each ticket left waiting across the boundary
**after the write**, sorted by ticket then target: each unfrozen queued ticket with a `depends_on` on a frozen ticket,
where **either is linked to this phase** (a ticket outside the frozen set blocked on a frozen one, or a released ticket
waiting on a ticket of a phase still planned). It never refuses. **`would_wait`** on a read with `tickets=true` is the same
list for what the phase's **next** release (a planned phase) or recall (a released one) would leave, so a confirmation
can state it first; `[]` on an archived phase.

#### `POST /tracker/{project}/phases/{id}/archive`
`note` and the author fields. A **released** phase, or a **planned one with no open ticket**, becomes `archived`, and is
off the roadmap (D14). A planned phase with an open ticket is 400 (`… is planned and has 3 open tickets: cancel, move or
release them first`); so is one already archived. One `edit` event, `fields: {"state": "archived"}`, body `Phase
archived.` unless a note is given. Response: the phase.

#### `POST /tracker/{project}/phases/{id}/unarchive`
`note` and the author fields. It returns to `released` if it has a `released_at`, else to the **roadmap's bottom** as
`planned`. A phase not archived is 400 (`… only an archived phase can be unarchived`). One `edit` event, body `Phase
unarchived.` unless a note is given. Response: the phase.

#### `GET /tracker/{project}/roadmap?window=24h|7d` — the forward look (D24)
```json
{"project": "ubu", "window": "7d", "now": "…", "velocity_per_day": 8.0,
 "queue": {"remaining": 48, "eta_days": 6.0}, "frozen": 45, "planned_out_days": 11.6,
 "released": [Figures, …], "planned": [Figures, …], "complete": [Figures, …], "archived": [Figures, …]}
```
where Figures is, without a body as this reads many phases:
```json
{"id": "ubu-p0001", "project": "ubu", "title": "Creatures", "state": "planned", "released_at": null,
 "created_at": "…", "updated_at": "…", "size": { "…": "as above" }, "ahead": 88, "eta_days": 11.0}
```
**These are durations of active work, never dates (D24, R7), and nothing here is stored**: every figure is computed on
request from live velocity and live counts, so the queue and the phases change size and the ETAs follow. `Cache-Control:
no-store` and no `ETag`, as the velocity read and the report. Read-only, no author fields.

* `window` is `24h` or `7d`, **`7d` when absent**; any other value, and any other query parameter, is 400.
* `velocity_per_day` is the window's, exactly as `GET …/velocity` gives it. `queue.remaining` is its `remaining`, and
  `queue.eta_days` its `eta_days` for the window (fractional days, `0` with nothing remaining, `null` when unknown).
* `frozen` is the project's frozen tickets, drafts included.
* `planned_out_days` is how far out development is planned: the last planned phase's `eta_days`, or the queue's with
  none planned.
* A ticket is **counted** by the velocity rules: no requests and no drafts. **`ahead` is an ETA's numerator**, and
  `eta_days` is `ahead ÷ velocity_per_day` in fractional days, **`null` when unknown** (work ahead and a velocity of 0):
  * a **released, incomplete** phase: the counted tickets of status `pending`, `in_progress`, `failed` or `review`,
    blocked or not, not deferred, from the head of the queue down to and including the phase's last such ticket. With no
    such ticket (all drafts or deferred) `ahead` is 0 and `eta_days` is `null`, there being nothing to project;
  * a **planned** phase: `queue.remaining` plus the counted frozen tickets of this and every earlier planned phase
    (`eta_days` 0 with nothing ahead);
  * a **complete** or **archived** phase: `ahead` 0, `eta_days` `null`.

| List | Holds | In the order |
|---|---|---|
| `released` | released and incomplete | soonest first: by `ahead`, then `released_at`, then id, so it holds with a velocity of 0 |
| `planned` | planned | the roadmap's |
| `complete` | released and complete | newest release first |
| `archived` | archived | newest change first |

An unknown project answers the same shape, empty (and `eta_days` 0), not a 404; an invalid project name is 400.

### Documents

#### `GET /tracker/{project}/docs?kind=<kind>&prefix=<path prefix>`
`{"project", "documents": [Document, …]}` by path, without bodies.

#### `POST /tracker/{project}/docs` — a free-standing document (kind `doc`)
`{"path", "title", "body" (optional), "message" (optional), "draft" (optional, default false), author fields}`. Refused (400) when a document holds the
path, or a rename left it as a redirect. Specs', milestones' and concepts' documents are created with their records
(below), not here. Response: the document view at revision 1.

#### `GET /tracker/{project}/doc?path=<path>&revision=<n>&history=<bool>`
A document by path. An old path left by a rename redirects: the response is the document at its current path with
`"redirected_from": "<the path asked for>"`. `revision` reads an older body (`body_revision`); `revision` in the
response is still the current one. 404 if no document has or had the path, or the revision does not exist.

#### `GET /tracker/docs/{id}?revision=<n>&history=<bool>`
The same, by id.

#### `POST /tracker/docs/{id}/edit` — exact replacements
```json
{"base_revision": 3, "replacements": [{"old": "exact text", "new": "replacement"}], "message": "one line", …author}
```
Applied in order; each `old` must occur **exactly once** in the body as it stands when it is applied, or nothing
is written (400, naming the replacement). `base_revision` must be the current revision, or **409** with the current
document. An edit that leaves the body unchanged is 400. Response: the document view at the new revision.

#### `POST /tracker/docs/{id}/write` — a whole new body
`{"base_revision": 3, "body": "…", "message": "…", …author}`. Otherwise as `edit`. Bodies are limited to 4 MB.

#### `POST /tracker/docs/{id}/rename`
`{"path": "<new path>" (optional), "title": "<new title>" (optional), "note" (optional), …author}`. A new path
leaves the old one as a redirect to this document. Refused when another document holds the new path or it is a
redirect to another document; renaming back onto one of the document's own old paths is allowed (and drops that
redirect). A rename that changes nothing is 400. Response: the document view (a `rename` event).

#### `POST /tracker/docs/{id}/draft` — make a draft, or publish (2026-10-30)
`{"draft": true|false, "note" (optional), …author}`. One `edit` event, `fields: {"draft": …}`, body `Published.` or
`Made a draft.` without a note. Publishing is the document's (and its concept's) arrival on the feed; making a
published one a draft is announced once. Refused (400) when it is already so, and on a spec's or a milestone's
document (a spec has its own `draft` state). Response: the document view.

#### `GET /tracker/docs/{id}/revisions`
`{"doc_id", "revisions": [Revision, …]}`, oldest first.

#### `GET /tracker/docs/{id}/diff?from=<n>&to=<m>`
`{"doc_id", "from", "to", "diff"}`. `to` defaults to the current revision, `from` to `to - 1`. `diff` is a unified,
line-based diff with three lines of context:
```
--- revision 1
+++ revision 2
@@ -1,3 +1,4 @@
 a
-b
+B
+b2
 c
```
Empty when the bodies are the same. 404 for a revision that does not exist.

#### `POST /tracker/docs/{id}/restore`
`{"revision": 1, "base_revision": 4, "message" (optional), …author}`: writes revision 1's body as revision 5.
Checked against `base_revision` as an edit is (409 when stale). Restoring a body equal to the current one is 400.

### Specs and milestones

#### `GET /tracker/{project}/specs`
`{"project", "specs": [Spec with milestones, …]}` by slug, no events.

#### `POST /tracker/{project}/specs`
```json
{
  "slug": "audio", "title": "Audio", "state": "draft", "approval": "unapproved",
  "body": "master document markdown",
  "milestones": [
    {"code": "m01", "title": "Sound effects", "name": "sfx", "state": "not_started", "approval": "unapproved", "body": "…", "note": null},
    {"code": "m02", "title": "Music", "body": "…"}
  ],
  "note": "…",
  …author
}
```
One transaction: the spec, its master at `specs/<slug>/master.md`, and each milestone with its document at
`specs/<slug>/<code>-<name>.md`. `name` defaults to the title slugified (`"The store and the HTTP API"` →
`the-store-and-the-http-api`); pass it to keep a repository's existing file name. Milestones are ordered as
listed. `state` defaults to `draft` (`not_started` for a milestone). A clash on any path, a duplicate code or an
existing slug creates **nothing** (400). `note` is optional (a milestone without its own `note` uses the spec's).
Response: the Spec with milestones and events.

#### `GET /tracker/{project}/specs/{slug}`
The Spec with its milestones and events. 404 if unknown.

#### `POST /tracker/{project}/specs/{slug}`
`{"title", "state", "approval", "note", …author}`, each optional (without a `note` the body is generated, e.g.
`"State: draft → ready."`); `ratified` only from
`agent`. The master document is edited through the document routes, by its `doc_id`.

#### `POST /tracker/{project}/specs/{slug}/milestones`
`{"code", "title", "name", "state", "approval", "body", "note", …author}`: adds a milestone after the spec's last.
404 when the spec does not exist. Response: the Milestone with events.

#### `GET /tracker/{project}/specs/{slug}/milestones/{code}`
The Milestone with events.

#### `POST /tracker/{project}/specs/{slug}/milestones/{code}`
`{"title", "state", "approval", "order", "note", …author}`, each optional, as for a spec. `order` is any integer;
milestones sort by `order`, then code. Milestone states are set by the manager; nothing derives them from tickets.

### Concepts

#### `GET /tracker/{project}/concepts?state=<state>`
`{"project", "concepts": [Concept, …]}` by slug, no events.

#### `POST /tracker/{project}/concepts`
`{"slug", "title", "state" (default open), "approval", "body", "links", "draft" (default false), "note", …author}`: the concept and its
document at `concepts/<slug>.md`, in one transaction. Archiving is `state: "archived"`, not a move.

#### `GET /tracker/{project}/concepts/{slug}`
The Concept with events.

#### `POST /tracker/{project}/concepts/{slug}`
`{"title", "state", "approval", "add_links", "remove_links", "note", …author}`, each optional, as for a spec.

### Attachments

#### `POST /tracker/{project}/attachments` — upload (multipart/form-data)
| Part | |
|---|---|
| `file` | required; the file's bytes, with its `filename` and `Content-Type` |
| `author_email` | required |
| `agent` | optional |
| `surface` | required, `web` or `mcp` |
| `name` | optional; overrides the file name |

* At most **50 MB** (400 above it).
* The media type is the part's `Content-Type`, lower-cased, parameters dropped; `application/octet-stream` or none
  means *undeclared*, and an image is then recognised by its bytes.
* A declared `image/*` type is **checked against the content's magic bytes** (png, jpeg, gif, webp, avif, bmp,
  tiff, ico, svg); a mismatch, or an image type the bytes do not show, is 400.
* The bytes are stored once per sha256; every upload gets its own record. Response: the Attachment.

`curl -F file=@terrain.png -F author_email=me@example.com -F surface=web http://host:17793/tracker/ubu/attachments`

#### `GET /tracker/{project}/attachments`
`{"project", "attachments": [Attachment, …]}`, newest first.

#### `GET /tracker/attachments/{hash}`
`{hash}` is the full sha256, an `att:` reference, or any prefix of at least 12 hex characters. Returns the bytes
with the first upload's `Content-Type`; raster images `Content-Disposition: inline`, anything else (SVG included)
`attachment`; `ETag` the sha256; `Cache-Control: private, max-age=31536000, immutable`;
`X-Content-Type-Options: nosniff`; a sandboxing `Content-Security-Policy`. 404 unknown; 400 for an invalid hash or a
prefix that matches two different files.


Velocity (spec:velocity)
------------------------
How fast a project's tickets get done, measured over **active time**, so a project left alone does not read as
slow; the design is `specs/velocity/master.md` (D1–D10, D16–D27), built in `crates/core/src/tracker/spans.rs`,
`velocity.rs` and `report.rs`. Read by `GET /tracker/{project}/velocity` and `GET /tracker/{project}/report`
(above).

* **What is counted.** Tickets of type `dev`, `design`, `recon`, `analysis` and `gate`; **never a request**, and
  never a ticket while it is a **draft** (it is in no count, and reaching done while a draft is not counted).
* **The counts** (now): **in progress** is status `in_progress` or `review`, not blocked (review folds in, and is
  also given alone as `in_review`); **pending** is status `pending` or `failed`, plus **every blocked ticket** of
  status `pending`, `in_progress`, `failed` or `review` (a blocked ticket waits, whatever its status; given alone
  as `blocked`); **deferred** tickets are in neither, blocked or not. **Remaining** is in progress + pending.
* **Done** in a window: the tickets that reached status `done` in it, **each once** however often it was reopened
  and done again there, and **still counted if reopened since** (a past figure does not change). `cancelled` and
  `failed` are not completions.
* **Active time** in a window: the project's events in it, oldest first, of every kind of record and both
  surfaces, **draft events and roadmap events left out** (spec:roadmap D23: planning a roadmap while the fleet is idle
  does not read as a slow fleet; a release's or recall's own event counts). Each gap between consecutive events of **at most 2 hours** is active; a
  longer gap is idle and adds nothing. The window's start and `now` count as the ends of the first and last gap,
  so the minutes since the last write count while they are under 2 hours. A ticket left in progress overnight
  adds nothing: activity comes from writes, not from tickets in progress.
* **Velocity** = done ÷ active time, per 24 hours of active time, with active time **at least 1 hour** (so twenty
  minutes that closed three tickets is 72 a day, not 216); 0 with nothing done. For a project at work all day it
  is its calendar rate; for one that works an hour a week, the rate it works at when it works.
* **ETA** = remaining ÷ velocity, **rounded up**, in days of active work at that pace: 0 with nothing remaining,
  `null` (unknown) with work remaining and a velocity of 0. An idle project takes longer in calendar days.
* **The windows** are rolling: the last 24 hours and the last 7 × 24 hours, ending now.
* **Where the figures come from.** Every status, block and draft change of a ticket opens and closes an
  `item_spans` row (one a ticket a state, on the tracks `status`, `blocked` and `draft`) in the same transaction
  as its event; a database from before them is backfilled from its events when it is opened (the log says how many
  tickets it built spans for, and how many it set from their rows because their events disagreed). Every figure is
  a range read of spans and events by time, with no counters to keep in step.
* **The report and drafts.** A ticket that is **a draft now is in no figure**, in the report or in the velocity's
  `done`, whatever it did before it was made one; publishing it brings its history back, so a past figure can
  change when a ticket is drafted or published. A published ticket's time as a draft does not count either: it is
  in no bucket's `remaining` for that time, is `added` when it is first published, and a completion made while it
  was a draft is not `done`. A stretch (in `states`, `mttc`, `mttr`) that began while its ticket was a draft counts
  from the publication, and not at all if it ended under that draft; a stretch as a draft in the middle of one is
  taken out of its length, as far as the last 7 days' spans show it. Which of two writes in the same second came
  first is the events' order, never the timestamps'.
* **Frozen tickets** (spec:roadmap D20–D22). A frozen ticket is in **no count**: not `pending`, not `remaining`. Its
  `status` span reads `frozen` (a span state, never an item status), so a freeze closes its `pending` span and a release
  opens a new one, and neither `states` nor `remaining` holds that time, recall included. A ticket is **added** at its
  first entry into a counted state, so a ticket created frozen is `added` at its first release or pull, not at its
  creation, and not again if recalled and released; a recall lowers `remaining` with no `done`, which is correct. **A
  ticket taken straight from frozen to done is no completion**: it is in no `done` figure and not in `mttc`. Reopened, it
  is added then, and its next done counts.


The event feed (rag-t0036)
--------------------------
Every committed event, pushed as it happens, so a manager agent learns of the owner's actions on the web without
polling. Claude Code's **Monitor** tool opens the socket itself and turns each text frame into a notification; the
pattern a manager follows is in [`user-claude.md`](../../user-claude.md). **Monitor refuses a WebSocket URL in a
private, link-local or cloud-metadata range** ("the address is in a private, link-local, or cloud-metadata
range"), so on the server host it opens `ws://127.0.0.1:17793/…` (or `localhost`), never the LAN address; from
another host, forward the port over ssh and use the same `127.0.0.1` URL, or run a command-based Monitor (`websocat`
or any small client printing each text frame as a line). The one-shot read has no such limit. Built in `crates/core/src/tracker/feed.rs`
(the channel) and `crates/serve/src/tracker/feed.rs` (the routes).

**The web UI's ticket page reads it too** (2026-10-29): same origin, `surface=any&kinds=all&format=json&drafts=true&roadmap=true` (drafts since 2026-10-30, so the owner's own draft follows live; roadmap from spec:roadmap m04, D19, so a frozen ticket's page follows its own edits and the roadmap and phase pages read it too), no
`since` (it re-reads the ticket on every open instead), so a write over MCP shows on an open ticket as it commits.
See `web/README.md` § *The tracker*.

**Event ids are global** (one sequence across every project), increase in commit order, and are the cursor: a
client keeps the last id it was sent and resumes after it with `since`.

### The filter (both routes)
| Query | | |
|---|---|---|
| `{project}` (path) | a project, or **`*`** for every project | `*` cannot be a project name |
| `surface` | `web` (default), `mcp`, `any` | `web`: the owner's actions in the web UI |
| `kinds` | comma list of event kinds, or `all` | default: `create`, `status`, `block`, `unblock`, `approve`, `move`, `note`, `assign`, `edit`, `release`, `recall` (left out: `link`, `rename` and, since 2026-11-01, `acknowledge`) |
| `since` | an event id, `0` or more; exclusive | the events **after** it |
| `drafts` | `true` or `false` (default) | `true` includes **draft events** (2026-10-30, owner): those written while their ticket or document was a draft (see Event). Left out by default, so the owner's unfinished work wakes nobody |
| `roadmap` | `true` or `false` (default) | `true` includes **roadmap events** (spec:roadmap D17, R8): a phase's changes and a frozen ticket's (see Event). Left out by default, so planning wakes nobody. A frozen draft's events need `drafts=true` as well. A phase's `release` and `recall` are not among them: they reach every feed their kind and surface pass |

Label changes are `edit` events (with `labels` in `fields`), which is why `edit` is in the default. Unknown query
parameters, an unknown surface or kind, and a negative `since` are 400s, as everywhere. The filter is applied before
everything else, in the store's SQL and the live matcher alike: events left out do not count against the 500 of a
replay, and never join a burst.

#### `GET /tracker/{project}/events/ws` — the feed (WebSocket)
Upgrades to a WebSocket on the service's own port (17793). Nothing sits between the client and `rag-serve`: the
container uses host networking and binds the port itself (`deploy/rag-serve.container`), so the upgrade needs no
proxy configuration. With `since`, it first **replays** every matching event after it, oldest first, then sends each
new one **live** as its write commits; without `since` it sends only what comes next. Query: the filter above, plus `format=text` (default) or
`format=json`, and `coalesce=<seconds>` (text only, 0 to 60, default 3; rag-t0039). `limit` is refused here (it
belongs to the read below), as is a `coalesce` above 0 with `format=json`.

**Each event is one text frame, one line**, unless it is part of a burst (below). `text`:

    #<event_id> <project> <surface> <kind> <target> "<title>" {<changes>}: <body> [<who>]
    #13901 rag web approve rag-t0040 "Live event feed" {approval: agent → ratified}: Go ahead. [Owner]
    #13902 rag web status rag-t0040 "Live event feed" {status: in_progress → done; blocked: dependency → no}: Status: in_progress → done. Unblocked. [Owner]
    #13903 rag web edit rag-t0041 "Gas weight" {labels: +Physics −Biomes}: Set labels. [Owner]
    #13904 rag web move rag-t0041 "Gas weight" {moved: after rag-t0010 → after rag-t0012}: Moved before rag-t0013. [Owner]
    #13905 rag web create spec:feed "The feed": Created spec feed (approval: owner). [Owner]
    #13906 rag web create rag-t0044 "Weather" {type: request}: Created request ticket (approval: owner). [Owner]
    #13907 ubu web release phase:ubu-p0001 "Creatures" {state: planned → released; tickets: 40; placed: bottom}: Phase released. [Owner]

* `<target>`: a ticket's id; `spec:<slug>`, `milestone:<spec>/<code>`, `concept:<slug>`, `doc:<document id>` or
  `phase:<phase id>`.
* `"<title>"`: the record's **current** title (cut at 100 characters); left out when the record is gone. A **draft
  event**, sent only to a feed with `drafts=true` (2026-10-30), is marked after it: `rag-t0060 "Weather" (draft)`;
  so is a draft record named in a burst frame. A **roadmap event**, sent only to a feed with `roadmap=true`, likewise:
  `ubu-t0100 "Wolf" (roadmap)`, and after the draft mark when it is both (`(draft) (roadmap)`).
* `{<changes>}` (from → to since rag-t0038): on a `create`, nothing, but a request's says `{type: request}`
  (rag-t0044: the one create a manager acts on); on any other event each change it made, separated by `; `,
  in this order: `moved: <from> → <to>` (a move, by the ticket's neighbour: `top` or `after <id>`), `draft` (2026-10-30:
  `draft: yes → no` on a publish, then `type: request` when a request is published), `status`, `state`,
  `approval`, `frozen` (`frozen: yes → no`), `phase` (`phase: none → ubu-p0001`), `blocked` (the reason while blocked,
  `no` while not: `blocked: dependency → no`, `blocked: no → review`), `tickets` and `placed` (a release's and a
  recall's: `tickets: 40`, `placed: bottom`), `depends_on`, `assignee`, `labels` (what it added and removed: `+Physics −Biomes`), `links`
  (`+item:rag-t0002 −ledger:rag-0033`), `title`, `body: edited`, `intensity`, `release`, `parallel`, `order`,
  `path`, and a document edit's `revision`, each as `<field>: <from> → <to>`. Values: `none` for a cleared one or an
  empty list, `yes`/`no` for a flag, a list comma-separated, each cut at 40 characters. An event written before
  rag-t0038 recorded no prior values and names the new value alone (`status: done`, a move its requested place:
  `moved: before rag-t0013`). `done_at`, `acknowledged_at` and `unblocked_by` are left out (the status and the body
  say them). So a note given in place of the generated body still says what changed; left out when it changed
  none of these.
* `<body>`: the event's body (its note, or the generated description), whitespace and newlines folded to single
  spaces. Past 200 characters it is cut with `…` and says how much more there is and which event holds it,
  `… (+812 chars in #13950)` (rag-t0039): the whole note is that event's `body` in the read below
  (`?since=13949&limit=1&surface=any&kinds=all`) and in the record's history (`tracker_get`, `history: N`).
* `[<who>]`: the event's `agent`: `Owner` for the owner's web writes (rag-t0038; before it, the author's email),
  the agent's name for an `mcp` one.

**A release and a recall are one frame each** (spec:roadmap D18), on the phase, in the default kinds: the moved
tickets' events are stamped `roadmap`, and the filter comes before the grouping, so they never join a default frame.
The body always begins `Phase released.` or `Phase recalled.`, a note following it and never replacing it, so it
cannot be read as a build release. The channel carries stamped events to whoever asked, so a release of more than 1024
tickets makes a live subscriber lag, whatever it asked for: it is closed with 1013 and resumes by id, and no frame is
lost. A **pull to the queue** (`frozen: false`) is one stamped event and sends no frame.

    #13908 ubu web release phase:ubu-p0001 "Creatures" {state: planned → released; tickets: 40; placed: bottom}: Phase released. Go. [Owner]
    #13909 ubu web recall phase:ubu-p0001 "Creatures" {state: released → planned; tickets: 38}: Phase recalled. [Owner]

**Bursts are one frame** (rag-t0039, text only). Events of one project and one surface committed within `coalesce`
seconds of the first of them (by their own timestamps, to the second) share a frame, so a drag reorder or a run of
edits notifies a monitoring agent once. Live, the burst is sent when its window has passed since its first event
arrived, or as soon as an event from another project or surface arrives; a replay groups the same way by the events'
timestamps. A burst of one is the event's own line. A burst of several:

    #<last id> <project> <surface> burst #<first id>–#<last id>, <n> events: <summary> [<who>, …]
    #13950 rag web burst #13946–#13950, 5 events: queue reordered: 5 moves (rag-t0042, rag-t0040, rag-t0051, rag-t0049, rag-t0050) [Owner]
    #13953 rag web burst #13951–#13953, 3 events: rag-t0042 "Gas weight": 2 edits {title: Gas → Gas weight; labels: +Physics}; rag-t0050 "Feed": status {status: review → done} [Owner]

* The frame starts with the burst's **last** id, the one to resume from, so resume-by-id is exactly as before: a
  client that resumes with `since=<that id>` has seen every event up to it, in this frame.
* `<summary>`, parts separated by `; `: the moves as `queue reordered: <n> moves (<ids>)`, the acknowledgements as
  `acknowledged <n> done tickets (<ids>)` (at most five ids, then `+<k> more`), then each other record in the order it
  first appears, as `<target> "<title>": <what>`. One event: its kind and changes (a note, or a phase's release or
  recall, quoting its body, cut at 80 characters, so it still says what it was: `phase:ubu-p0001 "Creatures": release
  {state: planned → released; tickets: 40; placed: top}: Phase released. Go.`). Several: counts by kind (`3 edits, 1 status change`) and all their changes together, cut at 160
  characters. At most five records are named, then `+<k> more records`.
* The events themselves are one read away: `GET …/events?since=<first id − 1>`.
* The server closing the feed (a restart, a lagging client, a failed replay) sends the open burst first, so the
  close's resume id is always the last id sent.
* `coalesce=0` sends one frame per event, as before rag-t0039; `format=json` always does (a program pays nothing per
  frame).

`json`: the event as one line of JSON, every field in full: `event_id`, `ts`, `project`, `target_kind`, `target_id`,
`title` (or `null`), `author_email`, `agent`, `surface`, `kind`, `body`, `fields` (the new values: the "to"),
`before` (the prior values: the "from", `null` on a create and on an event written before rag-t0038), `draft` and
`roadmap` (see [Event](#event)).

**Resume without loss or duplicates.** The server subscribes to the live channel **before** it replays from the
events table, then drops any live event at or below the last id it has sent. An event committed before the
subscription is in the replay; one committed after it is live; one committed in between is in both and sent once.
Live events go out in id order. So a client that reconnects with `since=<the last id it saw>` receives exactly the
events it has not seen, whatever was written meanwhile.

**Live delivery** comes from the store's write path: each write commits, then publishes every event committed since
the last publish (in id order, under one lock) on a broadcast channel. No database polling. A write that commits
through another process (a second `rag-serve`, a tool opening `tracker.db` directly) is published by the next write
through this one; nothing writes that way today.

**Heartbeat**: a ping every 30 s (a control frame: no notification). **Anything the client sends is ignored.**

**How a feed ends** (a close frame, its reason carrying the id to resume from):

| Code | When | Reason |
|---|---|---|
| 1013 (Try Again Later) | the client fell more than 1024 events behind the channel; it is dropped rather than buffered without bound | `lagged <n> events behind; resume with since=<id>` |
| 1012 (Service Restart) | the server is stopping (SIGTERM or Ctrl-C) | `server restarting; resume with since=<id>` |
| 1011 (Internal Error) | the replay could not read the table | `replay failed; resume with since=<id>` |

A frame the client does not take within 10 s drops the connection without a close frame. **Before the upgrade**: 503
without a store; 400 for a bad filter; **400 when more than 500 events match after `since`** (a replay that long is a
firehose to a client that notifies per frame: page through them with the read below, then open the feed from its
`next_since`); 426 for a request that is not a WebSocket upgrade.

#### `GET /tracker/{project}/events?since=<id>&limit=<n>` — the same events, read once
The filter above; `limit` 1 to 1000 (default 100). Always JSON (`format` and `coalesce` are refused):

```json
{"events": [FeedEvent, …], "latest_event_id": 13903, "next_since": 13903, "more": false}
```
`events` are the `format=json` objects, oldest first. **Without `since`**, `events` is empty: the call is for
`latest_event_id`, the newest event id in the store (every project), where a feed that wants only what comes next
starts. `next_since` is where to read or open the feed from next: after the last event returned while `more` is
true, otherwise past everything scanned (the events up to `latest_event_id` that did not match are not worth
re-reading).


Search (m05)
------------
The tracker is searched through the service's general retrieval route, not a `/tracker/…` one. Every document (at its
current revision, chunked) and every ticket (title, type, status, labels, body and notes; done and cancelled included) is
indexed as **`corpus = tracker`** by `rag-ingest reconcile-tracker`, which every successful tracker write triggers.

#### `POST /search`
```json
{"query": "solar film on the roof", "top_k": 8, "filters": {"corpus": "tracker", "repo": "ubu", "path_prefix": "concepts/"}}
```
`filters` is optional and each of its fields too: `corpus` is `code`, `wiki`, `ledger` or `tracker` (anything else is
a 400); `repo` is the project; `path_prefix` matches a document's path (a ticket's `rel_path` is its id, so a path
prefix leaves tickets out). `rerank` (default `true`) and `top_k` (default 8) as for any search. 503 without a Voyage
key.

Response: `{"query", "top_k", "reranked", "candidates", "timings", "results": [hit, …]}`. A tracker hit:

| Field | |
|---|---|
| `corpus` | `"tracker"` |
| `repo` | the project |
| `rel_path` | the document's path, or the ticket's id |
| `language` | `"markdown"` |
| `start_line`, `end_line` | the chunk's 1-based line range in the document body; `0` on tickets |
| `text` | the chunk, after a heading line `<title> · <project>:<path>`; a ticket's text is its title, `<project> <id> · <type> · <status>`, `Labels: …` when it has labels (rag-t0027), its body and its `Notes:` |
| `title` | the document's or ticket's title |
| `kind` | `spec`, `milestone`, `concept`, `doc` or `item` |
| `tracker_id` | the document id (`ubu-d0007`) or ticket id (`ubu-t0042`) |
| `revision` | the document revision the chunk is from (documents only) |
| `type`, `status` | the ticket's type and status (tickets only) |
| `citation` | **`<project>:<path>@r<revision>`** for a document chunk, the ticket id for a ticket |
| `ann_score`, `rerank_score` | as for any hit |
| `path` | `""` (tracker points have no file) |

A web filter is this route with `"filters": {"corpus": "tracker", "repo": <project>}`; a hit links to
`/projects/{project}/doc/{rel_path}` for a document and `/projects/{project}/ticket/{tracker_id}` for a ticket.


Web UI paths
------------
The API owns `/tracker/…`, and an API path never falls back to the single-page app, so a browser navigating to
`/tracker/ubu` would get the queue view's JSON. The UI's pages therefore live elsewhere (m03, m04):

| Page | Path |
|---|---|
| The dashboard (D14) | `/projects/{project}` |
| A ticket (D15) | `/projects/{project}/ticket/{id}`; the older `/projects/{project}/item/{id}` still opens it (rag-t0050) |
| The documents page (D16) | `/projects/{project}/docs` |
| A document | `/projects/{project}/doc/{path…}` |
| The history: done, cancelled and failed tickets (rag-t0008) | `/projects/{project}/history` |


Example session
---------------
```sh
B=http://atlas:17793
W='"author_email":"me@example.com","agent":"Claude Opus 5.5","surface":"mcp"'
curl -s $B/tracker/scratch/items -H 'content-type: application/json' -d "{\"type\":\"dev\",\"title\":\"one\",$W}"
curl -s $B/tracker/scratch/items -H 'content-type: application/json' -d "{\"type\":\"gate\",\"title\":\"Gate\",\"intensity\":\"standard\",$W}"
curl -s $B/tracker/items/scratch-t0002/move -H 'content-type: application/json' -d "{\"top\":true,$W}"
curl -s $B/tracker/items/scratch-t0001 -H 'content-type: application/json' -d "{\"status\":\"in_progress\",\"note\":\"go\",$W}"
curl -s $B/tracker/scratch            # the queue view
curl -s $B/tracker/scratch/check      # {"ok":true,…}
```
