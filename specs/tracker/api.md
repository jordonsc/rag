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
  event (**Add note**: the one write a note is required for).
* **Timestamps** are RFC 3339 UTC to the second (`2026-10-27T06:25:33Z`).
* **History.** Record reads (`GET` a ticket, document, spec, milestone or concept) include `events`, oldest first.
  `?history=false` returns the record with `"events": []`. The MCP `tracker_get` sends `history=false` unless the agent asks for the
  history (`history: true`, or `history: N` for the last N, trimmed on the MCP side; rag-t0039).

### Errors
Every error is JSON: `{"error": "<message for a person>"}`.

| Status | When |
|---|---|
| 400 | Refused: a malformed body or query, an unknown field, a bad enum value, a disallowed transition, an update with nothing to change and no note, a taken path, a bad link target. The message says which |
| 404 | The record does not exist (ticket, document, revision, spec, milestone, concept, attachment) |
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
| event `kind` | `note`, `create`, `status`, `block`, `unblock`, `approve`, `move`, `edit`, `link`, `assign`, `acknowledge`, `rename` |
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
  "depends_on": [],
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
* `queued` is true for `pending`, `in_progress`, `failed`, `deferred` and `review`: the ticket is in the linked list
  and `prev_id` / `next_id` are its neighbours (`null` at an end). Done and cancelled tickets have both `null`.
* `deferred` (rag-t0017) is work put aside on purpose. It is independent of `blocked`: a ticket can be both, and is
  then shown as deferred.
* `review` (rag-t0024) is work waiting on the owner to confirm or review it. It is independent of `blocked` too, and
  shown as review when both.
* `type: "request"` (rag-t0044) is the owner's idea with how to prioritise it. It never has gate fields and is
  never `parallel` (both 400); it is queued and keeps its place like any ticket, but the queue view lists it only
  under `requests`, whatever its status or block, so nothing that reads `queue` sees it.
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
  "before": {"status": "pending", "assignee": null}
}
```
`fields` holds every field the write set, with its new value, so replaying the events reconstructs the record.
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
`links_added`, `links_removed`, `place` (create and move: `"top"`, `"bottom"`, `{"before": id}`, `{"after": id}`).

**The automatic unblock** (rag-t0018) is an `unblock` event on the waiting ticket, written in the same transaction as
the write that finished its last dependency and **by that write's author** (its `author_email`, `agent` and
`surface`: the unblock is a consequence of that write, so it carries its author rather than an invented system
identity); its body is generated, `Unblocked: rag-t0012 is done.` (`Unblocked: rag-t0012 is done, the last of
rag-t0010, rag-t0012.` with several), and its fields are `{"blocked": false, "depends_on": [], "unblocked_by":
"rag-t0012"}`. It follows the triggering ticket's own event (a higher `event_id`). Document keys: `path`, `old_path`, `kind`, `title`,
`revision`, `base_revision`, `replacements` (a count), `restored_from`. Spec, milestone and concept keys: `title`,
`state`, `approval`, `order`, `path`, `milestones`, `links`, `links_added`, `links_removed`.

When one write changes several things, its `kind` is the first that applies of `status`, `block`, `unblock`,
`approve`, `assign`, `link`, `edit` (and `note` when only a note was given).

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
`concept` name the record that owns it (`null` for a free-standing `doc`).

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
`{"projects": [{"name": "ubu", "created_at": "…", "queued": 12, "requests": 1, "blocked": 2, "deferred": 1, "review": 1, "done_unacknowledged": 3}]}`,
by name. `queued` counts requests, review, blocked and deferred tickets too; `requests` counts every queued request
(rag-t0044), whatever its status or block; `blocked` counts blocked tickets that are neither requests, deferred nor
in review, `deferred` every deferred ticket and `review` every ticket in review, blocked or not, requests excluded
(each as the queue view sections them; `deferred` added 2026-10-27, rag-t0017; `review` the same day, rag-t0024;
`requests` the same day, rag-t0044).

#### `GET /tracker/{project}` — the queue view (D14, R12)
```json
{
  "project": "ubu",
  "exists": true,
  "requests": [ Item, … ],
  "done":    [ Item, … ],
  "review":  [ Item, … ],
  "queue":   [ Item, … ],
  "blocked": [ Item, … ],
  "deferred": [ Item, … ]
}
```
* **`requests`** (added 2026-10-27, rag-t0044): the queued tickets of type `request`, **whatever their status or
  block**, in list order. A request is in no other array while queued (done, it is under `done`). The dashboard
  shows them above Review and `tracker_queue` first; `tracker_next` never reads them. A client that predates it
  may read its absence as empty.
* **`done`**: tickets with status `done` and no `acknowledged_at`, **oldest first, newest last** (by `done_at`, then
  id), so the latest finished sits just above the queue, as the queue reads (*changed 2026-10-27, rag-t0029*: it
  was newest first).
* **`review`** (added 2026-10-27, rag-t0024): the tickets in review, **blocked or not**, in list order, between
  `done` and `queue` (the dashboard and `tracker_queue` show them above the queue). Each keeps its place: sending
  it back (`review` → `in_progress` or `pending`) leaves it where it was. A client that predates it may read its
  absence as empty.
* **`queue`**: the linked list in order, head first, **gates included** as ordinary tickets of `type: "gate"` (draw
  them as markers from `intensity` and `release`), and **without requests, review, blocked or deferred tickets**. Statuses here are
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
`{"project", "ok": true, "queued": 5, "order": [ids, head first], "problems": []}`. `problems` lists each fault in
words (a broken link, a cycle, a queued ticket the walk misses, a stale head or tail; since rag-t0018 also a
`depends_on` on a ticket not blocked with `dependency`, one naming no ticket or another project's, a ticket blocked with
`dependency` on nothing, or one whose dependencies are all done); `ok` is `problems` being empty.
Always 200.

#### `POST /tracker/{project}/ack-done`
Body: the author fields only. Stamps every done, unacknowledged ticket `acknowledged_at` (one `acknowledge` event
each). Response: `{"project": "ubu", "acknowledged": ["ubu-t0040", "ubu-t0041"]}`.

### Tickets

#### `GET /tracker/{project}/items?status=<status>&label=<label>`
`{"project", "items": [Item, …]}`, oldest first, no events. Every ticket of the project, done and cancelled included;
`status` filters (any ticket status, `deferred` and `review` included; `blocked` is a flag, not a status, and is 400).
`label` (rag-t0027) keeps the tickets carrying it, matched case-insensitively after the same trimming a write gets; a
blank one is no filter. Both may be given.

#### `GET /tracker/{project}/labels` — the label vocabulary (rag-t0027)
```json
{"project": "ubu", "labels": [{"label": "Biomes", "count": 3, "queued": 1}, {"label": "Physics", "count": 7, "queued": 4}]}
```
Every label the project's tickets carry now, once each in the project's casing, sorted case-insensitively. `count` is
the tickets carrying it, whatever their status; `queued` how many of those are in the queue (pending, in progress,
failed, deferred, review). A label no ticket carries any more is not listed. An unknown project has `[]`; an invalid
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
| `labels` | optional | `[string]`, default `[]` (rag-t0027); the rules under Ticket; a bad label or more than 10 is 400. A create event carrying labels says them in its generated body (`Created dev ticket. Labels: Biomes, Physics.`) and in `fields.labels` |
| `before` / `after` / `top` / `bottom` | optional, at most one | where it joins: `"before": "<id>"`, `"after": "<id>"`, `"top": true`, `"bottom": true`; default the bottom |
| `note` | optional | the create event's body |
| author fields | required | |

Response: the Ticket with its `create` event. The new ticket is `pending`.

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
| `labels` | `[string]`, **replacing the set wholesale** (rag-t0027); `[]` clears them. The rules under Ticket; a bad label or more than 10 is 400. The same set in another order, or with duplicates, is not a change. A change is an `edit` event with `fields.labels` the whole new set and, without a note, the body `Labels: Biomes, Physics.` (`Labels: none.` when cleared) |
| `approval` | `ratified` only from `agent` (the owner confirming an agent's approval). An agent may set `owner` when the owner approved in conversation, and its note says so |
| `assignee` | `""` clears it |
| `title`, `body` | `title` non-blank |
| `add_links`, `remove_links` | `[Link]`; removing a link the ticket does not have is refused |
| `intensity`, `release` | gates only |
| `note` | optional (the body is then generated from the change); alone, it is recorded as a `note` event and must not be blank |
| author fields | required |

**Status transitions** (anything else is 400):

| From | To |
|---|---|
| `pending` | `in_progress`, `done`, `failed`, `deferred`, `review`, `cancelled` |
| `in_progress` | `pending`, `done`, `failed`, `deferred`, `review`, `cancelled` |
| `failed` | `pending` (stays where it is in the queue), `deferred`, `review`, `cancelled` |
| `deferred` | `pending` (a resume: stays where it is), `in_progress`, `done`, `cancelled` |
| `review` | `done` (confirmed), `in_progress` or `pending` (sent back: stays where it is), `cancelled` |
| `done` | `pending` (a reopen: back into the queue **at the top**) |
| `cancelled` | `pending` (a reopen: at the top) |

`pending` → `done` (and `pending` → `failed`) is allowed so a manager can record quick work without first marking
it in progress (the manager's change in m02; m01 refused it). `done` and `cancelled` take the ticket out of the queue
and clear any block. Only a queued ticket can be blocked; a deferred ticket can be (and keeps its block when resumed).
`deferred` (rag-t0017) never moves the ticket in the list; `deferred` → `failed` is refused (resume it first).
`review` (rag-t0024) never moves the ticket either; `review` → `failed` and `review` → `deferred` are refused (send it
back first), and so is `deferred` → `review`. A review ticket can be blocked, and keeps its block when sent back.
Response: the updated Ticket with `events`.

#### `POST /tracker/items/{id}/move`
Exactly one of `"before": "<id>"`, `"after": "<id>"`, `"top": true`, `"bottom": true`; optional `note`; author
fields. The ticket and the anchor must both be queued (deferred counts), in the same project, and different. A move never takes a
position number, so it cannot go stale. Response: the Ticket with `events` (a `move` event).

### Documents

#### `GET /tracker/{project}/docs?kind=<kind>&prefix=<path prefix>`
`{"project", "documents": [Document, …]}` by path, without bodies.

#### `POST /tracker/{project}/docs` — a free-standing document (kind `doc`)
`{"path", "title", "body" (optional), "message" (optional), author fields}`. Refused (400) when a document holds the
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
`{"slug", "title", "state" (default open), "approval", "body", "links", "note", …author}`: the concept and its
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

**Event ids are global** (one sequence across every project), increase in commit order, and are the cursor: a
client keeps the last id it was sent and resumes after it with `since`.

### The filter (both routes)
| Query | | |
|---|---|---|
| `{project}` (path) | a project, or **`*`** for every project | `*` cannot be a project name |
| `surface` | `web` (default), `mcp`, `any` | `web`: the owner's actions in the web UI |
| `kinds` | comma list of event kinds, or `all` | default: `create`, `status`, `block`, `unblock`, `approve`, `move`, `note`, `acknowledge`, `assign`, `edit` (left out: `link`, `rename`) |
| `since` | an event id, `0` or more; exclusive | the events **after** it |

Label changes are `edit` events (with `labels` in `fields`), which is why `edit` is in the default. Unknown query
parameters, an unknown surface or kind, and a negative `since` are 400s, as everywhere.

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

* `<target>`: a ticket's id; `spec:<slug>`, `milestone:<spec>/<code>`, `concept:<slug>` or `doc:<document id>`.
* `"<title>"`: the record's **current** title (cut at 100 characters); left out when the record is gone.
* `{<changes>}` (from → to since rag-t0038): on a `create`, nothing, but a request's says `{type: request}`
  (rag-t0044: the one create a manager acts on); on any other event each change it made, separated by `; `,
  in this order: `moved: <from> → <to>` (a move, by the ticket's neighbour: `top` or `after <id>`), `status`, `state`,
  `approval`, `blocked` (the reason while blocked, `no` while not: `blocked: dependency → no`, `blocked: no →
  review`), `depends_on`, `assignee`, `labels` (what it added and removed: `+Physics −Biomes`), `links`
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
  first appears, as `<target> "<title>": <what>`. One event: its kind and changes (a note quoted, cut at 80
  characters). Several: counts by kind (`3 edits, 1 status change`) and all their changes together, cut at 160
  characters. At most five records are named, then `+<k> more records`.
* The events themselves are one read away: `GET …/events?since=<first id − 1>`.
* The server closing the feed (a restart, a lagging client, a failed replay) sends the open burst first, so the
  close's resume id is always the last id sent.
* `coalesce=0` sends one frame per event, as before rag-t0039; `format=json` always does (a program pays nothing per
  frame).

`json`: the event as one line of JSON, every field in full: `event_id`, `ts`, `project`, `target_kind`, `target_id`,
`title` (or `null`), `author_email`, `agent`, `surface`, `kind`, `body`, `fields` (the new values: the "to") and
`before` (the prior values: the "from", `null` on a create and on an event written before rag-t0038; see
[Event](#event)).

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
