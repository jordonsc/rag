#!/usr/bin/env python3
"""Query the RAG corpus via the rag-serve HTTP API and print ranked, cited results.

Four corpora sit behind the one `POST /search` route: `code` (indexed repositories),
`wiki` (the document library), `ledger` (decision/incident topics) and `tracker`
(project documents and work items). Each hit is cited the way its corpus is opened:
`repo/rel_path:start-end` for code and wiki, the topic id for a ledger hit, and the
hit's own `citation` (`<project>:<path>@r<rev>`, or the item id) for a tracker hit.

The service URL comes from $RAG_SERVE_URL (default http://localhost:17793).
No API key is needed here — Voyage auth lives server-side in rag-serve.

Examples:
  rag_search.py "where is retry/backoff implemented"
  rag_search.py "voyage rerank call" --repo rag --top-k 5
  rag_search.py "deployment runbook" --corpus wiki
  rag_search.py "why did we pick qdrant" --corpus ledger
  rag_search.py "next dispatchable task" --corpus tracker --repo rag
  rag_search.py "ann search" --language rust --json
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_URL = "http://localhost:17793"
CORPORA = ("code", "wiki", "ledger", "tracker")


def citation(h: dict) -> str:
    """The portable, openable provenance of one hit, by its corpus."""
    corpus = h.get("corpus")
    if corpus == "ledger":
        # A ledger point is a whole topic: open it with ledger_get / GET /ledger/{id}.
        return h.get("topic_id") or "?"
    if corpus == "tracker":
        # The server builds it: <project>:<path>@r<rev> for a document chunk, the id for an item.
        return h.get("citation") or h.get("tracker_id") or f"{h.get('repo')}:{h.get('rel_path')}"
    return f"{h.get('repo')}/{h.get('rel_path')}:{h.get('start_line')}-{h.get('end_line')}"


def label(h: dict) -> str:
    """The bracketed kind of one hit, after its citation."""
    corpus = h.get("corpus")
    if corpus == "ledger":
        return f"ledger/{h.get('repo')} {h.get('type')}, {h.get('status')}"
    if corpus == "tracker":
        if h.get("kind") == "item":
            return f"tracker/{h.get('repo')} item, {h.get('type')}, {h.get('status')}"
        return f"tracker/{h.get('repo')} {h.get('kind')}"
    return f"{corpus}/{h.get('language')}"


def format_hit(i: int, h: dict) -> str:
    """Two or three lines for one hit: score, citation and kind; the title (ledger and
    tracker); a one-line preview of the chunk."""
    score = h.get("rerank_score")
    score = f"rr={score:.3f}" if score is not None else f"ann={h.get('ann_score', 0.0):.3f}"
    lines = [f"{i:>2}. [{score}] {citation(h)} ({label(h)})"]
    title = h.get("title")
    text = h.get("text", "")
    if h.get("corpus") in ("ledger", "tracker") and title:
        lines.append(f"    {title}")
        # The chunk opens with its title (ledger) or a heading line (tracker): skip what repeats it.
        first, _, rest = text.partition("\n")
        if first.strip() == title.strip() or first.startswith(title):
            text = rest
        # An item's next line is "<project> <id> · <type> · <status>", already in the label.
        if h.get("kind") == "item" and h.get("tracker_id"):
            first, _, rest = text.partition("\n")
            if h["tracker_id"] in first.split():
                text = rest
    preview = " ".join(text.split())[:200]
    lines.append(f"    {preview}")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Search the RAG corpus: code, wiki, ledger and tracker.")
    p.add_argument("query", help="natural-language query")
    p.add_argument("--top-k", type=int, default=None, help="max results (server default 8)")
    p.add_argument("--corpus", choices=CORPORA,
                   help="restrict to a corpus: code, wiki, ledger (decisions/incidents) "
                        "or tracker (project documents and work items)")
    p.add_argument("--repo", help="restrict to one repository or project (exact name)")
    p.add_argument("--language", help="restrict to a language (e.g. rust, python, markdown)")
    p.add_argument("--path-prefix", help="restrict to rel_path starting with this prefix")
    p.add_argument("--no-rerank", action="store_true", help="skip reranking (debug/cost)")
    p.add_argument("--json", action="store_true", help="print the raw JSON response")
    p.add_argument("--url", default=os.environ.get("RAG_SERVE_URL", DEFAULT_URL),
                   help="rag-serve base URL (or set $RAG_SERVE_URL)")
    return p


def request_body(args: argparse.Namespace) -> dict:
    """The POST /search body for the parsed arguments."""
    filters = {}
    if args.corpus:
        filters["corpus"] = args.corpus
    if args.repo:
        filters["repo"] = args.repo
    if args.language:
        filters["language"] = args.language
    if args.path_prefix:
        filters["path_prefix"] = args.path_prefix

    body = {"query": args.query, "rerank": not args.no_rerank}
    if args.top_k is not None:
        body["top_k"] = args.top_k
    if filters:
        body["filters"] = filters
    return body


def main() -> int:
    args = build_parser().parse_args()
    body = request_body(args)

    url = args.url.rstrip("/") + "/search"
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), method="POST",
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        print(f"error: HTTP {e.code} from {url}\n{detail}", file=sys.stderr)
        return 1
    except urllib.error.URLError as e:
        print(f"error: cannot reach rag-serve at {url}: {e.reason}\n"
              f"(set $RAG_SERVE_URL or pass --url; is the service running?)", file=sys.stderr)
        return 1

    if args.json:
        json.dump(data, sys.stdout, indent=2)
        print()
        return 0

    results = data.get("results", [])
    t = data.get("timings", {})
    rr = "reranked" if data.get("reranked") else "no rerank"
    print(f"== {len(results)} results for {data.get('query')!r} "
          f"({rr}, {data.get('candidates')} candidates, {t.get('total_ms')} ms) ==")
    if not results:
        print("  (no matches — try broadening the query or relaxing filters)")
        return 0
    for i, h in enumerate(results, 1):
        print()
        print(format_hit(i, h))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
