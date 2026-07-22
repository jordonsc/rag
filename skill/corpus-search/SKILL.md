---
name: corpus-search
description: >-
  Search the local code + wiki corpus (all of your indexed repositories and the
  document library) via the rag-serve retrieval API. Use this whenever you need
  to find where something is implemented, how an API or pattern is used across
  projects, or relevant documentation — especially for code outside the current
  working directory. Returns ranked, reranked source chunks with citable
  provenance (repo + path + line range). Prefer this over guessing when a
  question spans repositories or asks "where/how is X done in our code".
---

# Corpus search

Retrieval over the whole local corpus (every indexed repo + the wiki),
served by `rag-serve`. The full quality pipeline (embed → vector search → Voyage
rerank) runs server-side; this skill just drives it and formats results.

## When to use it

- "Where is X implemented / configured / handled?" across any repo.
- "How do we usually do Y?" — find prior art / conventions in other projects.
- Pulling relevant wiki/docs for a task.
- Any time the answer likely lives in a repo you don't have open.

Not for: editing files, or questions answerable from the files already in context.

## How to run it

Use the bundled script (no API key needed — Voyage auth is server-side):

```bash
python3 scripts/rag_search.py "<natural-language query>" [flags]
```

Flags:
- `--top-k N` — number of results (server default 8).
- `--corpus code|wiki` — restrict to source or the document library.
- `--repo <name>` — restrict to one repository (exact name, e.g. `rag`).
- `--language <lang>` — e.g. `rust`, `python`, `markdown`.
- `--path-prefix <prefix>` — restrict to repo-relative paths under a prefix.
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

Each result prints as:

```
 1. [rr=0.86] rag/crates/core/src/voyage.rs:120-138 (code/rust)
    <text preview>
```

Always cite sources as **`repo`/`rel_path`:`start_line`-`end_line`** — that is the
portable, openable provenance. Read the actual file at that range before relying
on it; the chunk is a pointer, not the whole truth. The rerank score (`rr=`) is the
relevance signal; `ann=` appears instead when reranking was disabled.

## If the service is unreachable

The script prints a clear error if `rag-serve` is down or `$RAG_SERVE_URL` is
wrong. Check the service is up, or fall back to the `rag` MCP server
(`search_corpus` tool) which does the same thing over MCP.
