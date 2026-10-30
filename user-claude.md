# Example user-level CLAUDE.md — corpus retrieval, ledger and tracker

This is an **example** of the guidance you can add to your own `~/.claude/CLAUDE.md`
(user-level, applies to every project) once you have a RAG + ledger server running.
It teaches an agent to reach for the corpus before grepping, to record decisions in
the ledger, and to keep a project's queue, specs and concepts in the tracker. Copy the three
sections below and adapt the names/examples to your setup.

Assumes the MCP servers are registered as `rag` (corpus), `ledger` and `tracker` — see this
repo's `README.md` and `.mcp.json.example`.

---

# Corpus retrieval (RAG)

A self-hosted RAG covers your project repositories plus a wiki document library
(semantic search + rerank), served from your RAG server. Two surfaces, same backend —
use them, don't guess:

- **`search_corpus`** — an MCP tool (server `rag`). Preferred when available.
- **`reindex_corpus`** — an MCP tool (server `rag`) that refreshes the index immediately. The corpus auto-syncs every
  15 min, so after you push changes you want searchable *now*, call it (then wait ~30s–3min before re-searching).
- **`ledger_get` / `ledger_create` / `ledger_append`** — MCP tools on a separate **`ledger`** server
  (so tool calls read "Calling ledger…"). See the **Ledger** section below — these are part of your normal workflow.

> **Names above are the short, convenience names.** The actual registered tool IDs are namespaced
> `mcp__<server>__<tool>` — i.e. `mcp__rag__search_corpus`, `mcp__rag__reindex_corpus`,
> `mcp__ledger__ledger_get`, `mcp__ledger__ledger_create`, `mcp__ledger__ledger_append`.
> In some harnesses these arrive as *deferred* tools (schema not yet loaded);
> to load one you must `ToolSearch` it, and `select:` matches the **exact registered ID** — bare
> names (`select:ledger_get`) will not match and return "No matching deferred tools found". Use the
> fully-qualified form: `select:mcp__ledger__ledger_get,mcp__rag__search_corpus`. If you only need
> the read tools now, still load `mcp__ledger__ledger_create` / `mcp__ledger__ledger_append` before
> the "close the loop by logging the outcome" step — they're separate deferred tools.

**Reach for it** when:
* exploring code
* a question spans multiple repositories
* asks "where/how is X done in our code"
* wants relevant docs

**Corpus-first rule — this is the default, not a "preference".** Before *any* codebase
search — the built-in `Grep`/`Glob` tools, a `Bash` `grep -r`/`rg`/`git grep`/`find … -name`,
**or dispatching an `Explore`/`general-purpose` subagent to go find code** — call
`search_corpus` first. Only fall back to a direct search when RAG genuinely comes up short, or
when the target isn't in the corpus (uncommitted / generated files, logs, build output,
`node_modules`, a repo outside your indexed account) — there a `grep`/`find` is the right tool.

Note the carve-out is real, not grudging: a **scoped, exact-match search** — finding the
call-sites of a specific symbol in a known directory — is grep's core competency and a poor fit
for semantic RAG. Once RAG has located the area, a targeted `grep`/`rg` is often the right next
step; don't force everything through the corpus.

**When you delegate code exploration to an `Explore` / `general-purpose` subagent, carry the rule
across.** Either do the RAG discovery inline yourself first, or put "use `search_corpus`, do not
grep" in the subagent's prompt. Don't spawn a search subagent and assume it'll prefer RAG — it
won't unless told.

It's cheap; prefer a quick search over assuming. The corpus includes your entire indexed codebase,
so when researching code you can query the corpus instead of reading through files.

**Using results:** cite sources as `repo/rel_path:start-end` (the portable provenance) and read the actual file at that
range before relying on it — a chunk is a pointer, not the whole truth. Filters: `corpus` (code|wiki|ledger|tracker),
`repo`, `language`, `path_prefix`. A tracker hit cites itself: its `citation` is `<project>:<path>@r<revision>` (read
it with `tracker_doc_get`) or a ticket id (`tracker_get`).

# Ledger (decision / incident record)

A cross-project, append-only ledger of **decisions, incidents, defects, and investigations** — why we did things and
what not to repeat. It's part of the RAG backend (indexed as `corpus = ledger`), reached via tools on a dedicated
**`ledger`** MCP server: `ledger_search`, `ledger_get`, `ledger_create`, `ledger_append`, plus housekeeping
`ledger_move` / `ledger_archive`. (Separate from the `rag` corpus-search server so ledger activity is visible as its
own tool calls.)

You can use the RAG search with `corpus = ledger` to search the ledger. While a primitive `ledger_search` tool exists
for keyword lookups, the RAG search will be far more effective (semantic + rerank).

**Default reflex when solving a problem:** *open* by searching prior art with `search_corpus`
(`corpus: "ledger"` — semantic recall beats the keyword `ledger_search`), and *close* by logging the outcome — a
decision made, a bug root-caused, an approach tried and rejected. Treat it like
committing: part of finishing the task, not an afterthought. If the tools aren't present, the `ledger` MCP server needs
a rebuild/restart — say so, don't silently skip it. The ledger is also RAG-indexed, so a RAG search will also elicit
ledger entries.

**Write rule — capture as you go.** When you make such a decision, or fix a non-obvious bug, or run an investigation
whose finding is worth keeping (even with no code change):
- `ledger_create` a topic (type `decision`/`incident`/`defect`/`investigation`, a fixed `summary`, an `initial_state`).
  It returns the new id, `<repo>-l<seq:04>` (`rag-l0052`, *l* for ledger); topics from before keep their unmarked
  ids (`rag-0042`), and every tool takes both.
- `ledger_append` to evolve it — never rewrite history, append to it. Use `set_state`/`set_status` to move it on, and
  `supersedes: <topic_id>` to record that a newer topic replaces a worse earlier one (this flips the old one to
  `superseded`). The creator email + repo are captured from git automatically (over the stdio MCP binary; the shared
  HTTP gateway instead stamps its configured `RAG_EMAIL` and needs an explicit `repo` on `ledger_create`).
- **Always pass `agent` explicitly**, set to your own model name as stated in your system prompt (e.g.
  `"Claude Opus 5 (1M context)"`). Nothing in the stack can derive it — one MCP process serves a whole session
  including subagents on other models — so `$RAG_AGENT` is a marker for an unattributed write (`Unknown`), not a
  guess. A write stamped `Unknown` is a write that forgot.
- **`title` and `tags` are amendable** via `set_title` / `set_tags`, and the amendment is logged like any other
  change. `set_tags` replaces the list wholesale, so send the full set. `summary` is deliberately not amendable:
  correct a wrong framing in the body, don't overwrite the record of it.

**Prefer many small, atomic topics over one broad, evolving one — one topic = one decision or one finding.** Reach for
`ledger_create` for each distinct decision/finding, even several within a single task or session (e.g. "Postgres over
MySQL" and "retry/backoff policy" are two topics, not one "storage layer" topic). Reach for `ledger_append` only to
record a change to that *same* thing — a status move, a correction, the outcome — not to pile new, distinct facts onto
it. Keep `initial_state`/`set_state` a concise status, not a growing dossier; a swelling current-state or repeated
new-fact appends means you should have split into separate topics.

This is judgement, not bureaucracy: log the things a future agent would regret not knowing. Don't log trivia.

# Tracker (queue, specs and concepts)

Each project's **work queue**, its **specs** with their milestones, and its **concept documents** live in the
tracker, on a dedicated **`tracker`** MCP server (tool IDs `mcp__tracker__tracker_queue` and so on). It is the
**source of truth** for all three: a `specs/<spec>/master.md`, `specs/<spec>/m03-music.md` or
`concepts/<slug>.md` referred to in a repository or the ledger is a tracker document — read it with
`tracker_doc_get` (by that path, with `project` set to the repository name), not from the repository. A project's
`docs/` (final-state documentation) stays in its repository.

**When to read it.** Every read costs context, and a manager reads all day, so read the cheapest thing that
answers the question:
- **`tracker_next` at the start of a session and after each job** (what to dispatch next): the next pending,
  unblocked ticket in queue order (`n` for more, `type` to filter; a request, deferred or review ticket is never offered), with
  its body and links in full, stopping at the first gate (a gate with nothing above it is itself the next job); it
  says why when there is nothing to dispatch. After that batch, within the same `n`, it lists any **parallel**
  tickets below the gate, each marked `parallel: lands after gate <id>`: dispatch them now, but apply their work only
  once that gate has passed.
- **`tracker_queue` for a status report**, not after every job: the queue in order (gates drawn as
  `── … gate: standard ──` markers), the owner's **requests** first, then the tickets **in review** (waiting on the
  owner), then the blocked and the deferred ones, then a `Not shown:` line counting what was left out. Bounded: the
  top 20 rows by default (`limit`), `until_gate: true` for only the batch up to the next gate, `sections` to pick
  requests, review, done, queue, blocked and deferred (done tickets are only counted unless asked for).
- **With the event feed armed** (below), re-read only when a frame arrives or a job finishes; never poll.
- **`tracker_get`** reads one record **without its history**; pass `history: N` for the last N events, or
  `history: true` for all of them, only when the history is what you need (a ticket's history can run to 15k
  characters).

Do not keep a queue in scratch files or memories; point them at the tracker. Find specs, concepts and documents
with `tracker_list`.

**Search it before re-planning work.** Before writing a new spec, concept or queue ticket — or briefing work that
sounds familiar — run `search_corpus` with `corpus: "tracker"` (and `repo` set to the project to narrow it): every
project's specs, milestones, concepts and tickets (with their notes, done and cancelled ones included) are indexed
there, usually within seconds of a write. If it was planned, specced or tried before, build on that record rather
than starting a second one.

**Who writes what.** Writes to the **queue** (creating tickets and gates, status, blocking, approval, assignee,
moves, acknowledging done) come from the agent working with the owner — in practice the **manager**, and there is
only ever one per project. A **sub-agent** reads anything, edits **document content** (specs, milestones,
concepts) when its task says so, and adds **notes to the task it was given** (`tracker_update` with only a
`note`), and nothing else. The server cannot enforce this (one MCP process serves the whole session), but every
write records its `agent`.

**The write tools.** `tracker_create` creates a queue ticket or a gate (`type: "gate"` with an `intensity`);
`tracker_create_record` a spec (with its milestones), a milestone, a concept or a free document. `tracker_update`
changes a ticket (or adds a note to it); `tracker_update_record` a spec, milestone or concept. Every write replies
with **one line**: `ok`, the record, what changed from → to, and the event id (`ok ubu-t0042 status: in_progress →
done (#13950)`, `ok created ubu-t0043 [dev] "Title" after ubu-t0042 (#13951)`); read the record with `tracker_get`
if you need more.

**Rules on every write:**
- **Always pass `agent`**, your own model name, as for the ledger. Absent, the write is recorded as `Unknown`.
- **A note says why, when the change does not.** A note is optional on every `tracker_update`: without one the
  history records the change itself (`Status: pending → done.`), so give one when the reason is not obvious from
  the change (why it failed, what unblocked it, who approved and where). A note alone (no other field) is how a
  sub-agent reports on its task, and must not be blank.
- **Work waiting on the owner goes in `review`.** When a ticket is finished but needs the owner to confirm or review
  it (a design to pick, a result to look at, a change to sign off), set `status: "review"` with a note saying what
  to look at. It keeps its place, is shown red above the queue, and is never offered by `tracker_next`; the owner
  confirms it (`done`) or sends it back (`in_progress`). There is no block reason `approval` any more: the server
  refuses it. A review ticket does not hold a gate, any more than a blocked one does.
- **A request is the owner's to file and the manager's to break down** (`type: "request"`, filed with *Add
  request* on the dashboard: an idea and how to prioritise it). It is never dispatched, never offered by
  `tracker_next` and never counted in a gate's batch. When one arrives (step 4 below):
  1. read it (`tracker_get <id>`);
  2. create its tickets (`dev`, `design`, `recon`, `analysis`, a gate if it asks) each with
     `links: ["from:<request id>"]` — the server records on the request what it `became`. Their approval defaults
     to `agent` (the breakdown is yours); pass `approval: "owner"` only when the request says the work is approved,
     with a note citing it;
  3. place them as the request says (`before`, `after`, `top`), else leave them at the bottom;
  4. set the request `done` with a note listing the tickets (`Became rag-t0051, rag-t0052; both before the gate.`).
- **Blocked and deferred are different things.** Block a ticket (`blocked` + a reason) when it is waiting on
  something other than the owner's sign-off; set `status: "deferred"` when it is put aside on purpose. Both keep
  the ticket's place in the queue; `deferred` → `pending` resumes it there.
- **Work that waits on other tickets is blocked with reason `dependency`**, never `review` (which reads as waiting on
  the owner): `blocked: true, block_reason: "dependency", depends_on: ["<project>-t0012"]` (tickets of the same
  project). It unblocks itself, with a note, when the last of them is `done`; a dependency that is cancelled or
  fails does not free it, so decide then and unblock it yourself.
- **Work that may start before a gate but must land after it** (built in a scratch copy while the gate runs,
  applied afterwards) stays **below** the gate and is marked `parallel: true` (on create or update; never on a
  gate). Do not move it above the gate: the gate would then wait on it.
- **Label tickets by subject** (`labels: ["Physics", "Biomes"]` on `tracker_create` or `tracker_update`, tickets and
  gates). Any agent may label a ticket; it is not a queue write. **Reuse the project's existing labels** —
  `tracker_list` with `what: "labels"` lists them with counts — rather than coining a near-duplicate (`Physics`,
  not `Physics engine` beside it). A label matches case-insensitively and the project's casing wins. The set is
  replaced **wholesale**: send the full list, not just the one being added (`[]` clears them). At most 10 a ticket,
  each at most 32 characters, no commas. `tracker_list` with `what: "items", label: "Physics"` finds the work on a
  subject.
- **Approval is a record, not a lock**: `agent` when an agent approves; `ratified` when the owner confirms an
  agent's approval; `owner` only when the owner approved — in conversation counts — with the note saying where.
- **Documents are edited against the revision you read**: `tracker_doc_get` shows it, `tracker_doc_edit` takes it
  as `base_revision` (exact `old` → `new` replacements, each matching once, or a whole body). If someone edited
  it since, the edit is refused with the current revision: re-read and edit again; nothing is merged silently.
- **Moves are relative** (`before`, `after`, `top`, `bottom`; a new ticket takes `before`, `after` or `top`, and
  joins the bottom otherwise), never positions. Removing a ticket or gate is
  cancelling it. Gates carry no version number.
- **Long bodies go by path**: over the stdio server, `tracker_create`, `tracker_create_record` and
  `tracker_doc_edit` take `body_path`, a
  local file the server reads, so a repository file being moved in, or a long brief, never passes through your
  context.
- **Attachments**: `tracker_attach` uploads a file (a local path over stdio; base64 over the HTTP gateway) and
  returns `att:<hash>` to embed as `![name](att:<hash>)`; `tracker_attachment_get` fetches one to a local file
  you can `Read`.
- **The owner attaches files to notes**: on the ticket page a note (Add note, Send back, Confirm, block, defer,
  ratify, …) or a body can carry a pasted, dropped or attached file, written into its text as
  `![name](att:<hash>)` (an image) or `[name](att:<hash>)`. The note reaches you as text with that reference in
  it, in the event feed's frame and in `tracker_get`'s history: a Send back with a screenshot reads `…: The lamp
  is still cold. ![lamp](att:8563fb58a9f3) [Owner]`. A frame cuts a long note (`… (+812 chars in #13950)`), and
  a reference can fall past the cut, so read the ticket's history when the note was cut. Fetch the file with
  `tracker_attachment_get` (`att:8563fb58a9f3`) and `Read` it before acting on the note: the screenshot is
  usually the point of it.

**Waking on the owner's actions (managers).** When the owner approves, ratifies, unblocks, confirms a review,
reorders or adds a ticket in the web UI, the tracker pushes it on a WebSocket feed; Claude Code's `Monitor` tool
opens that socket and turns each event into a notification, so an idle manager is woken without polling. Each
frame is one line, the event id first, then each change from → to, the note (or the generated description) and
who wrote it (`Owner` for the owner's web writes):
`#13901 rag web approve rag-t0040 "Event feed" {approval: agent → ratified}: Go ahead. [Owner]`,
`#13902 rag web status rag-t0040 "Event feed" {status: in_progress → done; blocked: dependency → no}: … [Owner]`,
`#13903 rag web edit rag-t0041 "Gas weight" {labels: +Physics −Biomes}: Set labels. [Owner]`,
`#13904 rag web move rag-t0041 "Gas weight" {moved: after rag-t0010 → top}: Moved to the top. [Owner]`.
**A burst is one frame**: the owner's writes to one project within 3 seconds (a drag reorder, a run of edits) share
a frame that starts with the burst's **last** id, the one to resume from:
`#13950 rag web burst #13946–#13950, 5 events: queue reordered: 5 moves (rag-t0042, rag-t0040, …) [Owner]`, or
`… rag-t0042 "Title": 3 edits {title: A → B; labels: +Physics; body: edited} [Owner]`. A note longer than 200
characters is cut, saying how much more there is and which event holds it (`… (+812 chars in #13950)`): read the
rest with `tracker_get` (`history: N`), or `curl -s "…/events?since=13949&limit=1&surface=any&kinds=all"`.
By default it carries only the owner's web actions (`surface=web`), not your own or your sub-agents' writes, and
every kind of them that matters to a manager: creates, status changes, blocks and unblocks, approvals, **moves**,
notes, acknowledgements, assignments and **edits** (title, body, gate fields and **label changes** are `edit`
events). Only link changes and document renames are left out. **The owner's drafts are left out too**: a ticket
or document the owner is still writing (`draft`, shown as `draft` in a ticket line and counted, never listed, in
`tracker_queue`'s footer) wakes nobody until it is published. Its first frame is then the publish,
`{draft: yes → no}` (a request's adds `type: request`: break it down as above); a published ticket made a draft
again is announced once (`{draft: no → yes}`): stop work from it until it is published. Do not dispatch, edit or
publish a draft unless the owner asks.

1. **Arm.** Take the starting id once, then open the feed after it:
   ```
   curl -s "http://<server>:17793/tracker/<project>/events"      # → {"latest_event_id": 13900, …}
   Monitor({ws: {url: "ws://127.0.0.1:17793/tracker/<project>/events/ws?since=13900"},
            description: "tracker <project>: owner actions", timeout_ms: 1800000})
   ```
   **The WebSocket URL must be `127.0.0.1` (or `localhost`)**: Monitor's `ws` source refuses an address in a
   private, link-local or cloud-metadata range, so `ws://192.168.…` fails with "the address is in a private …
   range". On the server host use `127.0.0.1` as above. From another host, forward the port first
   (`ssh -N -L 17793:127.0.0.1:17793 <server>`, then the same `127.0.0.1` URL), or use a command-based Monitor
   instead of `ws`, e.g. `Monitor({command: "websocat -t 'ws://<server>:17793/tracker/<project>/events/ws?since=13900'", …})`
   (any small client that prints each text frame as a line). The `curl` reads have no such limit.
2. **Track the last id.** Keep the `#<id>` of the newest frame you have seen (a scratch note survives a compaction).
3. **Re-arm** when the monitor ends (it lives at most 30 minutes, or the server restarts or drops a lagging
   client): the same call with `since=<last id seen>`, or the id in the close reason (`… resume with
   since=13907`); with no frame seen, the same `since` as before. The feed replays what came in between, exactly
   once, so nothing is lost or repeated. A 400 saying more than 500 events match means you were away long: read
   them with `curl -s "…/events?since=<id>&limit=200"` (repeat from its `next_since` while `more`), then re-arm from
   the last `next_since`.
4. **React.** A frame says what changed from and to, so a status, approval, block, label or move is usually
   enough to act on; read the record (`tracker_get <id>`) when the note or a body edit needs its context. An
   `approve` or `status` change, an `unblock`, a move or a new ticket may mean the next dispatch changed: re-read
   `tracker_next`. A `review` confirmed (`{status: review → done}`) may close a milestone. A **request**
   (`#13906 rag web create rag-t0044 "Weather" {type: request}: …`) is work to break down at once, as above.

`?surface=any` adds the agents' writes, `kinds=approve,status` narrows the events (`all` for every kind; the
default leaves out `link` and `rename`), `coalesce=<seconds>` sets the burst window (0 to 60; `0` for a frame per
event), `format=json` sends the whole event, one frame each, never coalesced (`fields` the new values, `before`
the old ones), `drafts=true` includes the owner's draft events (marked `(draft)`), and the project `*` watches
every project. Keep it narrow: a monitor that floods is stopped.

Over the stdio binary the project defaults to the current git repository; over the shared HTTP gateway pass
`project` on every call. Decisions and incidents still go in the ledger; link them to tickets with
`links: ["ledger:<topic id>"]` (each link `kind:target`: `item:ubu-t0042`, `spec:audio`, `milestone:audio/m01`,
`concept:terrain`, `ledger:rag-0033`, `from:ubu-t0044` for the request a ticket came from).

---

<!--
Add your own project-specific context below this line — e.g. a list of your repositories
and what each is for, per-project conventions, or where private domain knowledge lives.
That is what turns the generic rules above into an agent that knows *your* codebase.
-->
