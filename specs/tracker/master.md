Tracker: an agent-first queue, specs and concepts
================================================
**State: IN DEVELOPMENT** (2026-10-27). m01 (the store and the HTTP API), m02 (the MCP server), m03 (the dashboard), m04 (the
documents pages) and m05's search and trial brief are built; the API's contract is [`api.md`](api.md); the trial follows
[`trial-brief.md`](trial-brief.md). Ledger **rag-0033** (the design), **rag-0034** (specs and concepts leave the repositories).
A queue record is a **ticket** (owner, 2026-10-28, rag-t0050): the rulings and the milestones' plans, written
before, say *item*, and the API keeps `item` for compatibility ([`api.md`](api.md)).

A small, local, agent-first task manager, in the spirit of a simplified Jira, built into this project beside the
ledger. It holds a project's **development queue**, its **specs** with their milestones, and its **concept
documents** (musings to be refined into specs). It is the **source of truth** for all three: the specs and concepts
leave the project's repository and live here, with their history. The queue's lead agent (the *manager*) reads it
instead of keeping a queue in its own scratch files, and the owner sees and reorders it in the web UI.

**Why.** A long-running manager agent loses track of work: its queue lives in session-scoped scratch files that a
cleared or compacted session forgets, and nobody else can see or edit them. The owner has the matching problem from
the other side: no single view of what is queued, in flight, blocked or done, and no way to reprioritise it except by
telling the agent.

Rows marked **R** are the owner's rulings; **D** is the design that follows from them. The design is the owner's to
amend, but every question raised has been answered.


The owner's rulings
-------------------
All 2026-10-27.

| R | Ruling |
|---|---|
| R1 | **Built into this project**, extending the ledger's stack (SQLite behind `rag-serve`, typed MCP tools, the web UI), not a fork |
| R2 | **Project-scoped**: every record belongs to a project (a repository name), as ledger topics do |
| R3 | **The tracker is the source of truth** for a project's queue, specs and concepts. **Specs and concepts move out of the project's repository** into the tracker. The manager's memories point at it. A project's `docs/` (final-state documentation) stays in its repository |
| R4 | **Manipulated by agents.** Writes to the queue (its order, items, statuses, markers, approvals) come from the agents working with the owner, which is in practice the manager alone. Sub-agents may read everything, **edit document content** (specs, milestones, concepts) and **append notes** to the task they were given, and nothing else |
| R5 | **There is only ever one manager** per project. It knows which sub-agent works which task, and it handles orphaned tasks. The tracker does not detect them |
| R6 | **First-class concepts**: a **spec** with **milestones**; a **concept document**; a **task** in the queue, of type **Dev** (implement a spec or milestone), **Design** (artwork, image generation), **Recon** (research, prep-work), **Analysis** (debugging) or **Gate** (gate and release, with an intensity: quick, standard or full) |
| R7 | **Gates carry no version numbers.** A version falls where its gate falls in the queue |
| R8 | **What a release means is the project's business.** The tracker marks where one is planned and never defines it |
| R9 | **Blocked** is a flag on an item (needs redesign or review, or waits on other items; *needs approval retired 2026-10-27, rag-t0024: work waiting on the owner is the status `review`*), and blocked work is always shown under the main queue |
| R10 | **Approval is a track record, not a mechanical gate**: who approved (an agent's auto-approval, later ratified or not; the owner; or no one), so a future agent can tell how much weight a thing carries before changing it. An agent may record the owner's approval when the owner gives it in conversation |
| R11 | **The queue is a linked list**: new items join the bottom; the owner or an agent reorders by relinking, through an API call that hides the links |
| R12 | **The dashboard** follows the manager's status report: green done, blue in progress, white pending, amber blocked, red failed. Done items show at the top until the owner **acknowledges all done**, which clears them from the view |
| R13 | **A second page works on concept documents** |
| R14 | **Attachments** (images and other files) live in the tracker; a project's concept art leaves its repository too |
| R15 | **Documents are indexed into the RAG corpus** |
| R16 | **No migration tool.** Once the tracker is ready, the manager loads the in-flight and queued work into it by hand, through the API |
| R17 | **Backups** (nightly, off the box) come **after the first release** (m06) |


Design
------
### Records

* **D1. One SQLite database**, `tracker.db`, beside `ledger.db` (its own file: a fault or a restore of one never
  touches the other), opened by `rag-serve` through `core::tracker` in the style of `core::ledger`: `sqlx`, WAL,
  typed enums at the boundary, so a bad status or type is refused, never stored as free text. Config
  `[tracker] db_path` and `attachments_dir` in `rag.toml`; the routes answer 503 when the store cannot open, as the
  ledger's do.
* **D2. Projects** are created on first write, named as the repository is (`ubu`), as a ledger topic's `repo` is. A
  project row holds its queue's head and tail.
* **D3. Tickets** are the queue's entries. Each has:
  * an **id**, `<project>-t<seq:04>` (`ubu-t0042`), minted by the server; the `t` keeps it clear of ledger ids
    (`ubu-1592`);
  * a **type**: `dev`, `design`, `recon`, `analysis` or `gate`; *`request` added by the owner, 2026-10-27,
    rag-t0044*: the owner files a high-level idea with how to prioritise it, and the manager, woken by the event
    feed (D11), breaks it into `dev`, `design`, `recon` and other tickets linked back to it (`from`), places them as
    it says, and marks it `done` with a note listing them. A request carries no gate fields and is never
    `parallel`; it takes the statuses and transitions any ticket does, and is queued and keeps its place, but it is
    listed only in its own section (D14), whatever its status or block, **never in the queue a worker reads**:
    `tracker_next` never returns it and a gate's batch never counts it (D12). A request cannot itself come from
    another;
  * a **title** and a **body** (markdown: the brief, the scope, the acceptance);
  * a **status**: `pending`, `in_progress`, `done`, `failed`, `cancelled` or `deferred` (*`deferred` added by the
    owner, 2026-10-27, rag-t0017*: work put aside on purpose, kept apart from blocked work; it may be reached from
    `pending`, `in_progress` or `failed`, and leaves for `pending` (a resume, in place), `in_progress`, `done` or
    `cancelled`); *`review` added by the owner, 2026-10-27, rag-t0024*: work waiting on the owner to confirm or
    review it. It is reached from `pending`, `in_progress` or `failed`, and leaves for `done` (confirmed),
    `in_progress` or `pending` (sent back, in place) or `cancelled`. Like `deferred` it is queued and keeps its
    place; `tracker_next` never offers it, and like a blocked ticket it is outside `tracker_next`'s walk, so it does
    not hold the gate below it (D12). It is independent of the blocked flag, and wins over it in the queue view;
  * a **blocked** flag, with a **reason** (`redesign`, `review` or `dependency`) and an optional note,
    independent of the status. *Amended 2026-10-27, rag-t0024: the reason `approval` (the dashboard's "Needs
    approval") is retired, since it read as the approval record (D10) on approved rows; the status `review`
    replaced it. A write that sends it is refused, naming status `review`. Opening an older `tracker.db` moves
    every queued ticket blocked with it to `review`, unblocked and in place, with a `status` event authored as the
    migration (email `system`, agent `Tracker migration (rag-t0024)`, surface `mcp`) whose body is `Moved to
    review: the block reason approval was replaced by the review status.` and, when there was one, `The block note
    was: …`; a second open finds nothing to move. The reason `review` stays.* *`dependency` amended in, 2026-10-27, rag-t0018 (trial finding: the ubu manager
    blocked tickets that waited on other tickets with `review`, which the dashboard read as waiting on the owner):*
    a ticket blocked with `dependency` holds a **`depends_on`** list, the ids of the tickets it waits on, tickets of its
    own project, never itself, not all of them already done, and never forming a cycle (one waiting, directly or
    through others, on the ticket itself; checked on every write). The list lives only beside that reason: any
    unblock, another reason or leaving the queue clears it. **It unblocks itself**: when a ticket becomes `done`, the
    same transaction unblocks every ticket blocked with `dependency` whose `depends_on` are now all done, each with
    its own `unblock` event by the author of the write that finished the last one (its email, agent and surface)
    and a generated body, `Unblocked: rag-t0012 is done.` (`…, the last of rag-t0010, rag-t0012.` with several).
    **A dependency cancelled or failed unblocks nothing**: whether the work still waits, or goes ahead, is a
    person's call;
  * a **parallel** flag (*amended in, 2026-10-27, rag-t0013, trial finding: work built in a scratch copy while a
    gate runs, and applied after it, could not be expressed; below the gate `tracker_next` hid it, above it the gate
    waited on it*): the ticket **may start before the gates above it clear, and still lands after them**. Any type
    but `gate`. It changes nothing in the list: the ticket keeps its place below the gate, and `tracker_next` offers
    it (D12);
  * an **approval** (D10);
  * an **assignee**: free text the manager sets (the sub-agent's name), for its own bookkeeping (R5);
  * **labels** (*added by the owner, 2026-10-27, rag-t0027*: "custom labels, eg 'Physics', 'Biomes', 'Creatures'
    that we can add to the tickets"): a set of free-text subject tags, at most 10, each trimmed (inner whitespace one
    space), non-blank, at most 32 characters, without a comma (labels are listed comma-separated) or a control
    character. **Matched case-insensitively within a project, whose existing casing wins**: labelling a ticket
    `physics` when another ticket of the project carries `Physics` stores `Physics` (a ticket that alone carries a
    label may change its casing). Held sorted case-insensitively, so order is never a change. Set **wholesale** on
    create and update, as ledger tags are, and recorded on the event (`Labels: Biomes, Physics.`, `Labels: none.`
    when cleared). A project's **vocabulary** is the labels its tickets carry now, with counts; a label no ticket
    carries is forgotten. Any type, gates included;
  * **links**: to a spec, a milestone, a concept, ledger topics (any project's ids, held as text) and other tickets;
    *`from` and `became` added 2026-10-27, rag-t0044*: **`from:<request id>`** names the request a ticket was broken
    out of, a request of the ticket's own project (any type but `request` may carry one, given on create or added
    later). Writing it writes the reverse, **`became:<item id>`**, on the request, with a `link` event there
    (`Became ubu-t0051.`); removing it removes that (`No longer became …`), in the same transaction. `became` is
    the server's alone: a write naming it is refused, pointing at `from`, and a concept takes neither. A ticket
    created with `from` and no approval is **`agent`-approved** (the breakdown is the agent's); `owner` only when
    the request says the work is approved, given explicitly. The integrity check proves each `from` is answered by
    a `became` and back;
  * for a **gate**: an **intensity** (`quick`, `standard` or `full`) and a **release** flag (R8);
  * its place in the queue (D5), and `created_at`, `updated_at`, `done_at` and `acknowledged_at`.
* **D4. Documents** are markdown, addressed by a **path** within their project that keeps the shape the repository
  used, so the references already written into code, `docs/` and the ledger stay meaningful:
  `specs/<spec>/master.md`, `specs/<spec>/m03-music.md`, `concepts/power-generation.md`. A document has a title, a
  body, a **revision** number and its revisions (D9). A path can be renamed; the old path is kept as a **redirect**,
  as the ledger keeps moved ids, and never reused.
  * A **spec** is a record (project, slug, title, **state**: `draft`, `ready`, `in_development`, `done` or
    `superseded`; an approval) with its master document at `specs/<slug>/master.md`.
  * A **milestone** belongs to a spec: a code (`m03`), a title, an order within the spec, a **state**
    (`not_started`, `in_progress`, `done`), an approval and its document at `specs/<slug>/<code>-<title>.md`. A small
    spec has no milestones. Milestone states are set by the manager; nothing derives them from tasks.
  * A **concept** is a record (project, slug, title, **state**: `open`, `refining`, `refined` or `archived`; links to
    the specs and ledger topics it became) with its document at `concepts/<slug>.md`. Archiving is a state, not a
    move.
* **D5. The queue is a doubly linked list** (R11): each queued ticket holds `prev_id` and `next_id`, and the project
  holds the head and tail. **Queued** means `pending`, `in_progress`, `failed`, `deferred` or `review`, blocked or
  not: a blocked, deferred or review ticket keeps its place, so unblocking, resuming or sending it back puts it back
  where it was (*`deferred` amended in by the owner, 2026-10-27, rag-t0017; `review` the same day, rag-t0024*). **Done and cancelled tickets leave the list.** Every change is
  one transaction that relinks at most four rows:
  * **create** joins the tail, unless the call names a place;
  * **move** takes `before: <id>`, `after: <id>`, `top` or `bottom`; it never takes a number, so a move can never go
    stale while another write lands;
  * **done** and **cancel** unlink the ticket; **reopen** (`done`, `failed` or `cancelled` back to `pending`) relinks
    it at the top, where reopened work usually belongs; the owner moves it from there.
  
  An integrity check (one head, one tail, every link answered by its partner, no cycle, the walk covering every
  queued ticket) runs in the tests after every operation and is a `GET /tracker/<project>/check` route. Since
  rag-t0018 it also checks `depends_on` (D3): held only by tickets blocked with `dependency`, each such ticket waiting on
  at least one ticket of its own project that is not done.
* **D6. Gates are tickets** of type `gate` (R6, R7), so adding, removing and moving a gate or release marker is the
  same create, cancel and move as any ticket. The build number a gate produced is a note on it when it runs.
* **D7. Events**: every change to a ticket, spec, milestone, concept or document appends an event, as the ledger's
  monologue does: `ts`, `author_email`, `agent`, **`surface`** (`web` or `mcp`, D10), a `kind` (`note`, `create`,
  `status`, `block`, `unblock`, `approve`, `move`, `edit`, `link`, `assign`, `acknowledge`, `rename`), a body and
  the fields it set. **A note is optional on every change** (*amended by the owner, 2026-10-27*: it was required on
  a status change, a block and an approval, and the owner found that a chore on every action): without one the
  event's body is generated from the change (`Status: pending → done.`, `Blocked (review).`, `Approval: agent →
  ratified.`), so give one when the reason is not obvious from the change. **Add note** (a write that changes nothing
  else) still needs a non-blank note, as the note is all it records. State changes only by appending an event, so the
  history always explains the state.
* **D8. Attachments** (R14) are stored by content hash in `attachments_dir` (`<sha256[0..2]>/<sha256>`), with a row
  of project, original name, media type, size, uploader and time. A document refers to one as `att:<sha256 prefix,
  12>` in markdown (`![terrain](att:3fa9c2e1b07d)`), which the web UI renders and the MCP tools resolve. 50 MB a file.
  An attachment no document references is kept (the history may); a cleanup is out of scope.
* **D9. Revisions.** A document edit writes a new revision (its full body, author, agent, surface, time and a
  one-line message) and an `edit` event. An edit names the **base revision** it read; an edit against an older one
  is **refused** with the current revision, never merged silently. The history shows each revision's diff from the
  one before, and **restore** writes an old body as a new revision.
* **D10. Approval** (R10) is one of `unapproved`, `agent` (an agent approved it), `ratified` (an agent approved it,
  then the owner), or `owner`, on tickets, specs, milestones and concepts. Every approval event records **who**: its
  `surface` (`web` is the owner at the keyboard; `mcp` is an agent) and `agent`. An agent may set `owner` when the
  owner approved in conversation, and its note says so; the record shows it was set by an agent. This is a record,
  not a lock: nothing refuses work on an unapproved ticket.

### Surfaces

* **D11. HTTP routes** on `rag-serve` under `/tracker/…`, in the ledger routes' style (JSON, `author_email`
  required on writes, `agent` optional, a `surface` field the web app sends as `web` and the MCP server as `mcp`):
  the queue view, tickets (create, get, update, move), documents (create, get by path or id, edit, write, rename,
  revisions, restore), specs, milestones and concepts (create, update), attachments (upload, fetch, list),
  acknowledge-all-done, and the integrity check.

  *Amended 2026-10-27, rag-t0036 (owner): **a live event feed**, so an idle manager is woken by the owner's actions
  without polling.* The owner asked that, when he approves or otherwise acts on a ticket in the web UI, the manager
  learn of it at once. Two ways were weighed. **Pushing into the session over MCP** (Claude Code's "channels") is a
  research preview behind a development flag, interactive only, and not documented to wake an idle session: not
  viable today. **A feed the session subscribes to** is: Claude Code's `Monitor` tool opens a WebSocket itself and
  turns each text frame into a notification that wakes the session, so the tracker only has to serve one. Hence
  `GET /tracker/{project}/events/ws` (and `GET /tracker/{project}/events`, the same events read once; contract in
  [`api.md`](api.md) § *The event feed*):

  * **One frame, one line, one event**, the event id first: `#13901 rag web approve rag-t0040 "Title"
    {approval: agent → ratified}: Go ahead. [Owner]`; `format=json` for the whole event. (Amended by the owner
    2026-10-27, rag-t0038: each change is shown from → to, from prior values recorded on the event, and web writes
    with no agent are recorded as `Owner`; the first frames showed the new value alone and the email.) Few, meaningful frames:
    by default only the owner's (`surface=web`) decisions and the queue's movements (`link` and `rename` left out),
    since `Monitor` stops a monitor that floods it.
    (Amended 2026-10-27, rag-t0039: **a burst is one frame**. The text frames of one project and surface within 3 s
    (`coalesce`) share a frame starting with the burst's last id, so a drag reorder wakes a manager once; a note is
    cut at 200 characters with how much more there is and its event id. JSON frames stay one per event. Monitor's
    `ws` source refuses private addresses, so on the server host the URL is `ws://127.0.0.1:17793/…`.)
  * **Resume by id, without loss or duplicates.** A monitor lives at most 30 minutes and is re-armed with the last id
    it saw (`since`). The server subscribes to the live channel before replaying from the events table and drops any
    id it has already sent, so a reconnect is exact under concurrent writes.
  * **Live from the write path, no polling.** Each write commits, then publishes every event committed since the last
    publish, in id order under one lock, on a broadcast channel. Reading the table after the commit, rather than
    handing over the rows a transaction wrote, keeps the order total: writes take the write lock up front, so ids
    commit in order. A lagging client (more than 1024 events behind) is closed with the id to resume from, not
    buffered without bound; a replay of more than 500 events is refused in favour of the paged read.
  * **No new MCP tool**: `user-claude.md` spells out the `Monitor` call and the re-arm loop. `rag-serve` now stops
    on SIGTERM as well as Ctrl-C (a container stop used to end in SIGKILL), closing each feed with code 1012 and its
    resume id.
* **D12. A `tracker` MCP server**, a third `--server` mode of `rag-mcp` (and `/tracker` on the HTTP gateway), so its
  calls show as their own. Tools:

  | Tool | Does |
  |---|---|
  | `tracker_queue` | A project's dashboard as compact text: the tickets in review first (rag-t0024), done not yet acknowledged, the queue in order with gate markers, then blocked, then deferred (rag-t0017) |
  | `tracker_get` | One ticket, spec, milestone, concept or document (by id or path), with its links; its history only when asked (`history: true`, or `N` for the last N; rag-t0039) |
  | `tracker_create` | A queue ticket or a gate (rag-t0039: tickets only) |
  | `tracker_create_record` | (rag-t0039) A spec (with its milestones), a milestone, a concept or a free document, each with its document |
  | `tracker_update` | A ticket's status, block (with `depends_on` for reason `dependency`, rag-t0018), approval, assignee, title, body, links, `labels` (rag-t0027), `parallel` (rag-t0013) or gate fields; a note is optional (D7), and required only when it is the whole update |
  | `tracker_update_record` | (rag-t0039) A spec's, milestone's or concept's title, state, approval, links (concept) or order (milestone) |
  | `tracker_move` | A ticket `before`, `after`, `top` or `bottom` |
  | `tracker_doc_get` | A document by path or id, at its current or a given revision, with the revision number to edit against |
  | `tracker_doc_edit` | Exact-text replacements (`old` → `new`, each matching once) against a base revision, with a message; or a whole new body |
  | `tracker_attach` | Upload a file: a local path (the stdio transport reads it) or base64 (the gateway); returns its `att:` reference |
  | `tracker_attachment_get` | Fetch an attachment to a local file (stdio) so an agent can view it |
  | `tracker_ack_done` | Acknowledge every done ticket in a project |
  | `tracker_list` | (added in m02) A project's tickets (filter `status`, `label`), labels (rag-t0027: the vocabulary with counts), specs, concepts, documents or attachments, or every project, one line each |
  | `tracker_next` | (added 2026-10-27, rag-t0006) The next `n` (default 1) dispatchable tickets in full (body, links): pending, unblocked, in queue order, stopping at the first gate not in progress (a gate with nothing above it is itself returned); optional `type` filter; a `Not shown:` count footer |

  *Amended 2026-10-27, rag-t0039 (owner: the tools' context cost):* the rules every write shares are stated once,
  in the server's instructions; descriptions and argument docs say only what a call needs, and the schemas are
  compacted (the definitions went from 31.8k characters to 11.1k). `tracker_create` and `tracker_update` split into
  ticket and record variants, links are `kind:target` strings, and every write answers with one line (`ok ubu-t0042
  status: in_progress → done (#13950)`). Measurements: m02's addendum of the same date.

  `tracker_queue` was bounded at the same time (rag-t0006): `limit` (top N rows, default 20), `until_gate` and
  `sections` (done, queue, blocked; done only counted by default), the same footer, and a line when the queue was
  cut. `deferred` joined `sections` and the footer with the status (rag-t0017, listed by default); `tracker_next`
  never returns a deferred ticket. `review` joined them the same way (rag-t0024): a `Review:` section listed **first**
  by default, `review` in `sections`, `N in review` in the footer and the header; `tracker_next` never returns a
  review ticket, and a review ticket above a gate does not hold it, exactly as a blocked one does not (neither is in the
  queue the walk reads). Both filter on the MCP side from the queue view; the API and the dashboard keep the full list.

  *Amended 2026-10-27, rag-t0013 (trial finding):* `tracker_next` lists, after the batch above the first gate,
  the **parallel** tickets it finds below that gate (pending, not blocked or deferred, in queue order, its `type`
  filter applying), up to `n` in total with the batch, the batch first; each is marked `parallel: lands after gate
  ubu-t0043`, naming the nearest gate above it. When the batch fills `n` it says how many it did not list.
  `tracker_queue` marks such rows `parallel`, and a blocked row with reason `dependency` says `waits on
  ubu-t0040` (rag-t0018).

  *Amended 2026-10-27, rag-t0044 (owner):* `tracker_create` takes `type: request` and a `from:<request id>`
  link (no new argument: links are `kind:target` strings). `tracker_queue` lists a **`Requests:`** section first,
  before Review, by default; `requests` joins `sections`, `N requests` the header and the footer. `tracker_next`
  never returns a request (its `type` filter refuses `request`), and a request above a gate does not hold it. The
  server's instructions give the manager's routine: on a request (its feed frame says `{type: request}`), create
  its tickets with `from`, place them as it says (else at the bottom), then set it done with a note listing them.

  *Amended 2026-10-27, rag-t0027 (owner):* `tracker_create` and `tracker_update` take **`labels`** on a ticket or a
  gate (refused on a spec, milestone or concept); `tracker_queue` and `tracker_next` show a ticket's labels after its
  assignee as `[Physics, Biomes]`; `tracker_list` lists the vocabulary (`what: labels`) and filters tickets by
  `label`. Labelling is not a queue write: any agent may label a ticket, and should reuse the project's labels.

  **R4 is written into every write tool's description**: queue writes (create, update of status, block, approval,
  assignee; move; acknowledge) are for the agent working with the owner, in practice the manager; a sub-agent may
  edit documents and add notes to its own task. One MCP process serves a whole session, sub-agents included, so the
  tracker cannot enforce this; the `agent` recorded on each write shows who broke it. As with the ledger, **`agent`
  is required in spirit**: absent, it is recorded as `Unknown`. (Amended 2026-10-27, rag-t0038: a `web` write with
  no agent is the owner and is recorded as `Owner`; the older ones were migrated. `Unknown` is an agent's write
  only.)
* **D13. Search** (R15). The tracker's documents and tickets are indexed into Qdrant as **`corpus = tracker`**, by a
  pull-based reconcile in the style of `ledger_reconcile` (each document chunked, with its project, path, kind and
  revision; each ticket as one point with its notes), triggered after writes as the ledger's is and on the timer.
  `search_corpus` takes `corpus: "tracker"`; a result cites `<project>:<path>` (or the ticket id) and the revision.
  *Amended 2026-10-27, rag-t0027:* a ticket's point carries its labels (a `Labels: Physics, Biomes` line, only when
  it has some), so a search for a subject finds the tickets labelled with it.

### The web UI

* **D14. The dashboard** (R12), `/projects/<project>` in the web app (as built: `/tracker/…` is the API's prefix, see
  [`api.md`](api.md) § *Web UI paths*), the tracker's home page. A project picker at the top. Top to
  bottom:
  1. **Done**: green rows, oldest first and the newest last, just above the queue (*amended 2026-10-27, rag-t0029*:
     it was newest first), and **Acknowledge all done**, which stamps them acknowledged and hides
     them. They remain in history and in search.
  1a. **Requests** (*added by the owner, 2026-10-27, rag-t0044*): the owner's ideas waiting for the manager, in
     the accent colour, in list order, whatever their status or block, each row drawn with its own **Request**
     badge; never in the queue, Review, Blocked or Deferred. **Add request**, in the page's header, files one: a
     title and the request itself (a larger box than a ticket's body), owner-approved unless unticked. The API's
     queue view carries them as a `requests` array; the ticket page of a request lists what it **became** (each
     ticket's status, id, type and title), and a ticket's names the request it came **from**.
  1b. **Review** (*added by the owner, 2026-10-27, rag-t0024*): red rows (failed's red, the owner's choice; the
     word **Review** and a diamond dot tell it from failed's disc), in list order, each with **Confirm** (to done)
     and **Send back** (to in progress, in place), the note optional. A review ticket is shown here, not in the queue,
     under Blocked or under Deferred, and keeps its place in the list; one that is also blocked is shown here, its
     block beside it. The API's queue view carries it as a `review` array between `done` and `queue`.
  2. **The queue**, in list order: a blue dot for in progress (with its assignee), white for pending, red for
     failed, each row its type badge, id, title and approval badge (no link chips: *amended 2026-10-27, rag-t0031*;
     a ticket's links are on its page), and a **Parallel** badge on a
     parallel ticket (*amended 2026-10-27, rag-t0013*; Add ticket and the ticket page's Edit have its box). **Gates show as markers**: a full-
     width rule across the list labelled with the intensity, and "release" when flagged. Rows and markers are dragged
     to reorder (each drop is one move call), and each has move-to-top and move-to-bottom in its menu for the
     keyboard and touch. **Add ticket** and **Add gate** join the bottom. Removing a ticket or a marker cancels it.
  3. **Blocked**: amber rows, each with its reason and note and an **Unblock** action. A blocked ticket is shown here,
     not in the queue, but keeps its place in the list. One blocked with `dependency` says **waits on**, each ticket
     a link to its page (*amended 2026-10-27, rag-t0018*); the ticket page's Block dialog offers the reason and a
     ticket picker for `depends_on` (the project's other queued tickets).
  4. **Deferred** (*added by the owner, 2026-10-27, rag-t0017*): teal rows, in list order, each with a **Resume**
     action (back to pending, in place); a row's menu and the ticket page offer **Defer**. A deferred ticket is shown
     here, not in the queue or under Blocked, and keeps its place in the list; one that is also blocked is shown
     here, its block beside it. The API's queue view carries it as a `deferred` array after `blocked`.

  *Amended 2026-10-27, rag-t0027 (owner): a ticket's **labels** are chips on the row's second line, right of the
  assignee, each a link to the dashboard filtered to it. A **label filter** (a select of the labels the view's tickets
  carry, `?label=` in the URL, matched case-insensitively) narrows every section; it keeps the queue's gates, so the
  batch each labelled ticket is in still shows, and it turns reordering off, as the unratified filter does. Add ticket
  and the ticket page's Edit have a label editor: chips, an entry box suggesting the project's labels as you type
  (a comma separates two), and the project's most used labels as one-click additions. The History page has the same
  filter in its URL, and the ticket page shows the labels in its header and each change in its history.*

  *Amended 2026-10-27 (owner): rows are **two lines** (rag-t0026): the status, the id, the title (taking the free
  width), the approval and the section's actions (Confirm and Send back, Unblock, Resume) on the first, the menu at
  its end in the queue; the type, the assignee, a block's reason and what it waits on, then the link chips at the
  right on the second. Gate markers stay one line. An **in-progress row is filled** with the owner's blue, `#0b61ac`,
  across both lines, its text, badges and buttons lightened to read on it (rag-t0023; the colour rag-t0029's,
  replacing a light tint). The row's **Approve** is the design system's tinted button and the
  **Agent-approved** ratify badge is filled amber at rest, each with a hover that is neither a row's grey nor the
  in-progress blue (rag-t0025).*

  *Amended 2026-10-27, rag-t0031 (owner): **no row on the dashboard draws link chips** (Done, Review, the queue,
  Blocked, Deferred); a ticket's ledger, spec, milestone, concept and ticket links are shown on its page only. The
  **labels** move into the slot the chips left, the right end of the row's second line, instead of beside the
  assignee. A dependency-blocked row's **waits on** stays: it is the block's reason, not a link chip. The MCP
  `tracker_queue` text is unchanged.*

  *Amended 2026-10-27, rag-t0033 (owner): the in-progress row is **tinted, not filled**: the owner's blue at a low
  share over the row's ground, a dark navy close to its neighbours, deeper on hover, its text, badges and buttons in
  the normal colours (4.5:1 or better). The type on the second line sits in a slot as wide as the widest type, so
  every **assignee on the page starts at one x**, the flat sections leading with the room the queue's grip takes; a long assignee is cut short rather than wrapped.*

  A filter shows only the approvals not yet ratified (`agent`). The page refreshes every 10 s (a cheap
  conditional request; a manager's writes appear without a reload) and at once after the viewer's own action.
* **D15. The ticket page**: the record, its body rendered, its links (a ledger id opens the ledger's topic page), its
  history, and the actions: note, status, block or unblock, approve or ratify, edit, links.
* **D16. The documents page** (R13), `/projects/<project>/docs`: two tabs.
  * **Concepts**: by state (open, refining, refined, archived), **New concept**, and each concept's page: the
    document rendered, **Edit** (a markdown editor with a live preview; images pasted or dropped become
    attachments), its links, its history and its revisions with diffs and restore.
  * **Specs**: each spec with its state and milestones (code, title, state, approval), opening its master or a
    milestone's document in the same viewer and editor.
* **D17. Identity** is the ledger UI's (the stored email), and writes from the UI carry `surface: web`.

### Operations

* **D18. Deploy** as the ledger: the same container and units; `tracker.db` and the attachments under
  `~/rag/tracker/` (a new bind mount); `deploy.sh` creates the directories. No new secret.
* **D19. Backups** (R17, after the first release, m06): nightly, off the box, to S3: a SQLite `.backup` of
  `tracker.db` **and `ledger.db`** and the attachments (synced by hash, so only new files move), keeping 7 daily and 4
  weekly copies of each database; a restore section in `deploy/RUNBOOK.md`; a systemd timer in the style of
  `rag-sync`.


Risks
-----
* **Off-box backup** (R17) is m06, running since 2026-10-27: nightly to `s3://rag-atlas-backups` (ap-southeast-4)
  as the owner's own IAM user (the AWS CLI's `default` profile on atlas), not a key scoped to the bucket. Before
  that date the only copies were same-box (`deploy/backup-qdrant.sh`).
* **R4 is a convention**, not enforced (D12). The event record makes a breach visible after the fact.
* **The repository's references** to `specs/…` now point at the tracker. D4's paths keep them readable, but nothing
  follows a link from a file in the repository to the tracker: an agent resolves it with `tracker_doc_get`.


Milestones
----------
| M | Milestone | State |
|---|---|---|
| m01 | [**The store and the HTTP API**](m01-store-and-api.md): the schema, the linked list, items, documents, revisions, specs, milestones, concepts, attachments, approvals, events, the routes, the integrity check; contract in [`api.md`](api.md) | **Released** (2026-10-27 to atlas; acceptance 2 met live: items created, moved, read in order, `/check` ok) |
| m02 | [**The MCP server**](m02-mcp-server.md): `--server tracker`, the tools, the gateway route, attachments over both transports, the rules in the descriptions | **Released** (2026-10-27; `tracker` registered at user scope and driven over stdio JSON-RPC; acceptance 1–2 in a live Claude Code session still owed) |
| m03 | [**The dashboard**](m03-dashboard.md): the queue view, drag to reorder, gate markers, done and acknowledge, blocked, the item page | **Released** (2026-10-27; `/projects/…` served; acceptance 1–4 by hand on the server's UI still owed by the owner) |
| m04 | [**Documents in the web UI**](m04-documents.md): the concepts and specs pages, the editor, attachments, revisions and diffs; the search view's tracker corpus (TC-07) | **Released** (2026-10-27; acceptance 1–3 by hand in the browser still owed by the owner) |
| m05 | [**Search and the trial**](m05-search-and-trial.md): `corpus = tracker`, the docs, the first project loaded by its manager ([`trial-brief.md`](trial-brief.md)) | **Released** (2026-10-27): TS-01–TS-04 done; acceptance 1 shown live on an item, not yet a concept (a phrase from `rag-t0001` found with `corpus = tracker` after the write-triggered reconcile; the concept case is owed with m04's acceptance 1); the web UI's search filter moves to m04; the trial (acceptance 2, `trial-brief.md`) is owed by the owner |
| m06 | [**Backups**](m06-backups.md): nightly to S3, tracker and ledger | Built and running on atlas 2026-10-27 (`rag-t0002`, uncommitted): `s3://rag-atlas-backups/atlas`, 01:33 UTC; restore rehearsed |

m02, m03 and m04 can run in parallel once m01 has landed.
