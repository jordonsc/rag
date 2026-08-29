# Example user-level CLAUDE.md — corpus retrieval + ledger

This is an **example** of the guidance you can add to your own `~/.claude/CLAUDE.md`
(user-level, applies to every project) once you have a RAG + ledger server running.
It teaches an agent to reach for the corpus before grepping and to record decisions in
the ledger. Copy the two sections below and adapt the names/examples to your setup.

Assumes the MCP servers are registered as `rag` (corpus) and `ledger` — see this
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
range before relying on it — a chunk is a pointer, not the whole truth. Filters: `corpus` (code|wiki|ledger), `repo`,
`language`, `path_prefix`.

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

---

<!--
Add your own project-specific context below this line — e.g. a list of your repositories
and what each is for, per-project conventions, or where private domain knowledge lives.
That is what turns the generic rules above into an agent that knows *your* codebase.
-->
