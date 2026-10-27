# RAG Skills

Claude Skills that drive the `rag-serve` HTTP retrieval API — the MCP-free path to
the corpus (the MCP path is `rag-mcp`).

## `corpus-search`

Semantic search over the whole indexed corpus: every indexed repo, the wiki, the
ledger and the tracker (`--corpus code|wiki|ledger|tracker`, as `POST /search` takes).
Bundles `scripts/rag_search.py`, which `POST`s to `rag-serve` `/search` and prints
ranked, cited results: `repo/path:lines` for code and wiki, the topic id for a ledger
hit, and the hit's `citation` for a tracker hit. No API key in the skill — Voyage auth
is server-side. `scripts/test_rag_search.py` holds its offline tests
(`python3 -I corpus-search/scripts/test_rag_search.py`).

### Install

Copy (or symlink) the skill directory into your Claude Code skills folder:

```bash
# user scope (all projects)
cp -r skill/corpus-search ~/.claude/skills/corpus-search
# or project scope
cp -r skill/corpus-search .claude/skills/corpus-search
```

### Configure the service URL

The script defaults to `http://localhost:17793`. Override with the `RAG_SERVE_URL`
env var if the service runs elsewhere:

```bash
export RAG_SERVE_URL=http://your-server:17793   # rag-serve on another host
```

No secret is stored in the skill; if the service is unreachable the script prints a
clear error pointing at `RAG_SERVE_URL`.

### Quick check

```bash
python3 corpus-search/scripts/rag_search.py "where is X implemented" --top-k 5
```
