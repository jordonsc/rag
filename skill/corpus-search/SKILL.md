---
name: corpus-search
description: >-
  Search the local corpus (all of your indexed repositories, the document
  library, the decision/incident ledger and the project tracker) via the
  rag-serve retrieval API. Use this whenever you need to find where something is
  implemented, how an API or pattern is used across projects, relevant
  documentation, why something was decided, or specced and queued work —
  especially outside the current working directory. Returns ranked, reranked
  chunks with citable provenance (repo + path + line range, a ledger topic id, or
  a tracker citation). Prefer this over guessing when a question spans
  repositories or asks "where/how is X done in our code".
---

# Corpus search

Retrieval over the whole local corpus, served by `rag-serve`: every indexed repo
(`code`), the document library (`wiki`), the decision/incident ledger (`ledger`)
and the project tracker's documents and tickets (`tracker`). The full quality pipeline (embed → vector search → Voyage
rerank) runs server-side; this skill just drives it and formats results.

## When to use it

- "Where is X implemented / configured / handled?" across any repo.
- "How do we usually do Y?" — find prior art / conventions in other projects.
- Pulling relevant wiki/docs for a task.
- "Why did we do X / has this bug been seen before?" — `--corpus ledger`.
- "Is this specced or queued already?" — `--corpus tracker` (with `--repo <project>`).
- Any time the answer likely lives in a repo you don't have open.

Not for: editing files, or questions answerable from the files already in context.

## How to run it

Use the bundled script (no API key needed — Voyage auth is server-side):

```bash
python3 scripts/rag_search.py "<natural-language query>" [flags]
```

Flags:
- `--top-k N` — number of results (server default 8).
- `--corpus code|wiki|ledger|tracker` — restrict to source, the document
  library, the ledger's topics, or the tracker's documents and tickets.
- `--repo <name>` — restrict to one repository, or the ledger's or tracker's
  project (exact name, e.g. `rag`).
- `--language <lang>` — e.g. `rust`, `python`, `markdown`.
- `--path-prefix <prefix>` — restrict to repo-relative paths under a prefix (a
  tracker document's path; it leaves tracker tickets and ledger topics out).
- `--no-rerank` — skip reranking (debugging / cost only; default is reranked).
- `--json` — raw JSON if you need to post-process.
- `--url <base>` — override the service URL (default `$RAG_SERVE_URL` →
  `http://localhost:17793`).

## Querying well

- Use natural language describing the *concept or behaviour*, not just a keyword
  (the pipeline is semantic): "retry with exponential backoff on HTTP 429" beats
  "backoff".
- Narrow with filters when you know the scope — `--repo` for a single project,
  `--corpus wiki` for docs only. Start broad, then filter if results are noisy.
- If a `--path-prefix` returns nothing, it may have been filtered out of the
  candidate set — relax it and filter the printed results yourself.

## Using results

Each result prints its citation first, by corpus:

```
 1. [rr=0.86] rag/crates/core/src/voyage.rs:120-138 (code/rust)
    <text preview>

 1. [rr=0.82] rag-0033 (ledger/rag decision, accepted)
    <topic title>
    <text preview>

 1. [rr=0.91] rag-t0006 (tracker/rag item, dev, done)
    <item title>
    <text preview>

 1. [rr=0.74] ubu:specs/logic/master.md@r3 (tracker/ubu spec)
    <document title>
    <text preview>
```

Cite each the way it is printed:
- **code / wiki**: **`repo`/`rel_path`:`start_line`-`end_line`** — the portable,
  openable provenance. Read the actual file at that range before relying on it;
  the chunk is a pointer, not the whole truth.
- **ledger**: the **topic id** (`rag-l0052`, or `rag-0033` for a topic minted
  before the `l`); fetch the whole topic with
  `GET /ledger/<id>` (or the `ledger_get` MCP tool) before relying on it.
- **tracker**: the hit's **citation** — `<project>:<path>@r<revision>` for a
  document chunk, the ticket id (`rag-t0006`) for a ticket. Fetch a ticket with
  `GET /tracker/items/<id>` and a document with
  `GET /tracker/<project>/doc?path=<path>&revision=<n>` before relying on it.

The rerank score (`rr=`) is the
relevance signal; `ann=` appears instead when reranking was disabled.

## If the service is unreachable

The script prints a clear error if `rag-serve` is down or `$RAG_SERVE_URL` is
wrong. Check the service is up, or fall back to the `rag` MCP server
(`search_corpus` tool) which does the same thing over MCP.
