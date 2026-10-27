The trial: a manager loads its project into the tracker
=====================================================
**The hand-over brief for m05 TS-04 (R16).** The owner gives this to a project's manager when the tracker is ready:
the manager follows it to load the project's in-flight and queued work, its specs, its concepts and their
attachments into the tracker through the `tracker` MCP tools, then works from `tracker_queue`. The first project is
**`ubu`**, a game repository; the steps name its layout, and the same steps apply to any project with
`specs/` and `concepts/` folders. Design: [`master.md`](master.md) (R3, R10, R14, R16; D4, D10, D13).

There is **no migration tool** (R16): the manager loads by hand, one call a record. That is deliberate. Every record
gets an author, an agent and a note, and the calls are the trial: what is awkward, slow or refused becomes a
follow-up item (§ 7).


1. Before you start
-------------------
* **The tools.** The `tracker` MCP server is registered over **stdio**, launched in the project's repository (so
  `project` defaults to it; pass `project: "ubu"` anyway, it costs nothing and survives a different working
  directory). Load `mcp__tracker__*` and `mcp__rag__search_corpus`. `tracker_list what=projects` answers; `ubu` is
  not there yet, or is empty.
* **Pass `agent` on every write**, your own model name. Absent, the write is recorded as `Unknown`.
* **Never paste a file into a call.** Every document body goes in by **`body_path`**: the absolute path of the
  repository file, which the stdio server reads itself (`tracker_create` for specs, milestones, concepts and
  documents; `tracker_doc_edit` for a new body). The project's specs run to about 4 MB of markdown, some files over
  200 KB: pasted, they would cost their size twice in context, and the largest would not fit in one call at all. For
  the same reason, verify a load by comparing bytes (§ 6), not by reading documents back.
* **Freeze the repository copies** for the length of the trial: from the moment a document is loaded, the tracker's
  copy is the one edited. Tell your sub-agents so in their briefs.
* **Who loads what (R4).** Documents (specs, milestones, concepts, free documents, attachments) are document
  content: you may hand their loading to a sub-agent with this brief. **Queue writes** (items, gates, statuses,
  blocks, approvals, assignees, moves) are yours alone.


2. What to load, and the paths to keep
--------------------------------------
Load everything under `specs/` and every markdown file under `concepts/`, live and archived, done and not done. R3
moves specs and concepts out of the repository; loading only what is in flight would leave two sources of truth.
**Keep every path exactly as the repository has it** (D4): code, `docs/`, memories and the ledger refer to
`specs/<spec>/m03-….md` and `concepts/<name>.md`, and an agent resolves those with `tracker_doc_get` by the same
path. Where the tracker's naming rule cannot produce the repository's path, create the record and then **rename its
document** to the repository path (`tracker_doc_edit` with `new_path`); the tracker's own path is kept as a redirect.

### 2a. A spec folder: `specs/<spec>/master.md` and `specs/<spec>/mNN-<name>.md`
One `tracker_create` per spec, its milestones in the same call (one transaction):

| Field | From |
|---|---|
| `kind` | `spec` |
| `slug` | the folder name (`energy`) |
| `title` | the master's first line (the setext heading: `Energy`) |
| `body_path` | `/…/ubu/specs/energy/master.md` |
| `state` | the master's **State** line: designed, ready to brief or waiting on questions → `ready` (or `draft` if it says the design is not finished); in development → `in_development`; done or closed → `done`; replaced by another spec → `superseded` |
| `approval`, `note` | § 4 |
| `milestones` | one entry per row of the master's **Milestones** table, in its order: `code` = `mNN` (or `mNNa`, as the file has it), `title` = the row's title, **`name`** = the file name between `mNN-` and `.md` (`ladder-and-fuel` for `m01-ladder-and-fuel.md`, so the path is kept exactly), `state` = `not_started`, `in_progress` or `done` from the row, `body_path` = the file, `approval` and `note` per § 4 |

A milestone file that the table does not list: add it with `kind: milestone` (`spec`, `code`, `title`, `name`,
`body_path`). Any other markdown file in the folder (notes, a review, open questions): `kind: doc` with `path` set to
its repository path.

### 2b. The older layout: `specs/inception/`
`spec.md` is the index and the milestones are `NN-<name>.md`. This spec is closing; load it as it stands:

* `kind: spec`, `slug: inception`, `body_path` → `spec.md`. The tracker puts it at `specs/inception/master.md`;
  then **rename it to `specs/inception/spec.md`** so every existing reference resolves.
* Each `NN-<name>.md` in the index's table is a milestone: **`code` = the two digits** (`01`), `name` = the rest
  (`poc`), so the path is `specs/inception/01-poc.md`; `state` from the index's State column.
* A milestone code can be used once per spec, so a second file with a number already taken
  (`02-engine-design-review.md`) and any file without one (`open-questions.md`) is a `kind: doc` at its own path.

### 2c. Concepts: `concepts/*.md`
* `concepts/<name>.md` → `kind: concept`, `slug` = the file name without `.md`, `title` = its first line,
  `body_path` = the file. `state`: `open`, or `refining` while it is being argued out with the owner.
  `ideas-to-come-back-to.md` (the parking lot) is a concept like any other.
* **A nested concept** (`concepts/biomes/jungle.md`, `concepts/art/lush.md`): a concept's slug is one segment, so
  create it with `slug: biomes-jungle` (the folders joined by `-`), then rename its document to the repository path.
  A markdown file that documents tooling rather than muses (`concepts/art/tiles/README.md`, beside the script it
  describes) is not a concept: it stays in git with its tool (§ 5).
* **An archived concept** (`concepts/archive/<name>.md`): the same, `slug: archive-<name>`, `state: archived`,
  renamed to `concepts/archive/<name>.md`. Archiving is a state in the tracker, not a move (D4); the path is kept
  only so old references still resolve. Where the file says what it was refined into (`docs/…`, a spec), add a
  `links` entry for a spec, and a note for a `docs/` file.

### 2d. Attachments (R14, D8)
* **Images a loaded document refers to.** The project's documents mention images by repository path in their text
  (`review/<date>-<name>.png`, `concepts/art/…`), not as markdown images. Load each document byte for byte first
  (revision 1). Then `tracker_attach` each file it mentions (`path` = the absolute file; at most 50 MB; the same
  bytes are stored once however many documents use them), write the document plus an appended section to a scratch
  file:

  ```markdown
  Attachments
  -----------
  ![review/2026-10-18-concepts-jorson.png](att:3fa9c2e1b07d)
  ```

  and `tracker_doc_edit` it with `base_revision: 1`, `body_path` = that scratch file, `message: "Attachments: the
  images this document names"`. The original text stays untouched, the alt text keeps the repository path, and
  the revision diff shows exactly what was added.
* **Leave `concepts/art/` and `review/` in git.** In this project `concepts/art/` is not a pile of musings: the art
  pipeline reads and writes it (`art/README.md`, the `art/` scripts and some game scripts name paths under it), and
  `review/` is the owner's review inbox. Uploading copies of the images a document names is right; moving the
  folders is not. Do not upload them wholesale (several hundred files, hundreds of MB) either. This is a conflict
  with R14 for the owner to rule on: file it (§ 7).


3. The queue
------------
The queue today lives in the manager's session scratch files: **`queue.md`** (the dev order, owner decisions and
history), **`inflight.md`** (what is running now, and the mode), **`gate-next.md`** (the lines of the next gate).
Read them, and load what is **not yet done**, plus anything done since the owner's last status report (so his Done
list shows it). History stays where it is.

| In the scratch files | In the tracker |
|---|---|
| A task running now (a dev, recon, art or analysis agent) | `kind: item`, `item_type` by the work (`dev` implements, `design` is art and image generation, `recon` researches or briefs, `analysis` debugs), `assignee` = the agent's name, then `tracker_update status: in_progress` with a note naming the agent |
| A queued task | `kind: item`, created **in the order the dev order lists them**: each joins the bottom, so the creation order is the queue order |
| A brief file (`brief-<name>.md`) | the item's body: `body_path` = the brief |
| The next gate and its lines | `kind: gate`, `intensity` = the build tier it runs (`quick`, `standard`, `full`: the project's `scripts/build` tiers), `release: true` when a release or an install follows it, the title what it gates, **never a build number** (R7); the body lists the packages it covers. Create it where it falls: after the items it gates. When it runs, the build number goes in a note |
| Waiting on the owner (a question, a ruling, work to confirm) | create it, then `tracker_update status: review` with the question as the note (*amended 2026-10-27, rag-t0024: the block reason `approval` is retired and refused*) |
| Waiting on a review (a sheet, a play-test) | `block_reason: review` |
| Its design was rejected, to be redone | `block_reason: redesign` |
| A gate that failed and is not yet repaired | status `failed`, with the failure in the note |
| Done since the last report | create it, then `status: done` (allowed straight from `pending`) with a note saying what landed |

**Links** on every item that has them: the spec or milestone it implements (`{"kind": "milestone", "target":
"energy/m04"}`), the concept it came from, the ledger topics its brief or the scratch file cites (`{"kind":
"ledger", "target": "<topic id>"}`), and the items it depends on.

Once the queue is loaded and `tracker_queue` reads in the same order as the scratch files, **replace the queue
content of the scratch files and of any memory that holds a queue with one line pointing at `tracker_queue`**. From
then on the tracker is the queue (master.md, *Why*).


4. Approvals already given (R10, D10)
-------------------------------------
Approval is a track record: it says how much weight a record carries. Record what was actually given, and say
where, in the note. Never invent one.

| What happened | `approval` | The note cites |
|---|---|---|
| The owner ruled on it: a rulings table in the spec (its `R` rows), an owner answer recorded in a spec or the ledger, an owner sign-off on a sheet, or the owner's approval in conversation | `owner` | where: `"Owner rulings R1–R8, specs/energy/master.md § The owner's rulings (2026-10-25)"`, `"Owner answer, ledger <topic id>"`, `"Owner in conversation, <date>: <his words>"`. The record shows an agent set it; that is expected (R10) |
| An agent decided it: the manager's own approval, a sheet approved while the owner was away and journaled as agent-approved, a design choice an agent recorded in the ledger | `agent` | the journal file and its entry, or the ledger topic |
| An agent decided it and the owner later confirmed it | create as `agent`, then `tracker_update approval: ratified` | both: the agent's record and where the owner confirmed |
| Nobody approved it, or you cannot find where | `unapproved` (the default) | nothing |

A spec whose rulings are the owner's but whose design is still waiting on his review is `owner` for the spec only if
he approved the design; otherwise leave it `unapproved` and say in the create note that the rulings are his. Approve
milestones on their own record: a milestone the owner signed off is `owner`; one the manager briefed is `agent`.


5. What stays in git
--------------------
* **`docs/`**: the final-state documentation stays in the repository (R3), and so do `README.md`, `CLAUDE.md`, the
  code, the content, the scripts, and every file a tool reads or that documents a tool (here `concepts/art/` and
  `review/`, § 2d, and `concepts/art/tiles/README.md`).
* **During the trial** `specs/` and `concepts/` stay in git too, frozen: nobody edits the repository copy of a
  loaded document.
* **After the owner accepts the trial**, and not before: one commit removes the loaded `specs/` and the concept
  markdown from the repository, and the project's `CLAUDE.md` *Specs* and *Concepts* sections are rewritten to point
  at the tracker (`tracker_list`, `tracker_doc_get` by the old paths, `search_corpus` with `corpus: "tracker"`).
  That commit is the owner's call; the loading agent does not make it.


6. Check the load
-----------------
* **Counts.** `tracker_list what=specs`, `what=concepts`, `what=docs` against the repository: every markdown file
  under `specs/` and `concepts/` (but the tooling documents of § 2c) appears once, at its path
  (`what=docs prefix=specs/energy/`).
* **Bytes, without reading them.** For each loaded document, compare its revision-1 body with the repository file
  over the HTTP API (`curl` and `jq` in a shell; nothing enters your context):

  ```sh
  B=http://<server>:17793
  f=specs/energy/master.md
  curl -s "$B/tracker/ubu/doc?path=$f&revision=1&history=false" | jq -j .body | cmp - "$f" && echo "same: $f"
  ```

  (`jq -j` writes the body without adding a newline.) A document with an attachments revision differs from the file
  only by that appended section (`tracker_doc_get view=diff`).
* **The list.** `GET $B/tracker/ubu/check` answers `"ok": true`.
* **Search.** Within a minute of the last write, `search_corpus` with `corpus: "tracker"`, `repo: "ubu"` and a phrase
  from a concept returns that concept's chunk, cited `ubu:concepts/<name>.md@r1` (m05 acceptance 1). If it does
  not, file it (§ 7) with the time of the write and the time of the search.
* **The queue.** `tracker_queue` lists the work in the scratch files' order, gates where they run, blocked items
  under it. Ask the owner to reorder something from the dashboard and read `tracker_queue` again (acceptance 2).


7. Report the friction, in the tracker's own project
-----------------------------------------------------
The trial is how the tracker learns what it lacks. **Every** friction, missing tool, refusal, confusing answer or
step that took far more calls than it should becomes an item in the **`rag`** project, the tracker's own. You file
them; the `rag` project's manager triages them. Do not work around a fault silently, and do not change the tracker
yourself.

```json
{
  "kind": "item", "project": "rag", "item_type": "analysis",
  "title": "Trial (ubu): <what went wrong, in a line>",
  "body": "**Tried:** <the call, its arguments, trimmed>\n**Got:** <the exact refusal or answer>\n**Did instead:** <the workaround, or 'stopped'>\n**Cost:** <calls, minutes or tokens it took>\n**Suggest:** <the fix, if you see one>",
  "links": [{"kind": "ledger", "target": "rag-0033"}],
  "agent": "<your model name>"
}
```

`item_type`: `analysis` for a fault or a refusal that looks wrong, `dev` for a missing tool or argument, `recon` for
something to decide. One item per finding; repeat sightings are notes on it (`tracker_update` with a note).

**File these at the start**, since they are known before the first call:
1. `concepts/art/` is an art-pipeline source and `review/` the owner's review inbox, so R14 ("concept art leaves
   its repository") cannot apply to them as written (§ 2d): `recon`, for the owner.
2. A concept slug is one segment, so nested and archived concepts need a create and a rename to keep their paths
   (§ 2c): `dev` (a `path` on concept create would remove the rename).
3. The older `specs/inception/` layout needs a rename for its index and a free document for a second file with a
   taken number (§ 2b): `recon`, whether the tracker should take a spec's master path.

At the end, add a note to the trial's own item (create one in `rag`: `"Trial (ubu): the load"`, type `recon`) with
the counts loaded, the calls it took, the items filed, and what the owner said about the dashboard.
