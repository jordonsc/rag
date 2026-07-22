#!/usr/bin/env python3
"""Query the RAG corpus via the rag-serve HTTP API and print ranked, cited results.

The service URL comes from $RAG_SERVE_URL (default http://localhost:17793).
No API key is needed here — Voyage auth lives server-side in rag-serve.

Examples:
  rag_search.py "where is retry/backoff implemented"
  rag_search.py "voyage rerank call" --repo rag --top-k 5
  rag_search.py "deployment runbook" --corpus wiki
  rag_search.py "ann search" --language rust --json
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_URL = "http://localhost:17793"


def main() -> int:
    p = argparse.ArgumentParser(description="Search the local code + wiki RAG corpus.")
    p.add_argument("query", help="natural-language query")
    p.add_argument("--top-k", type=int, default=None, help="max results (server default 8)")
    p.add_argument("--corpus", choices=["code", "wiki"], help="restrict to a corpus")
    p.add_argument("--repo", help="restrict to one repository (exact name)")
    p.add_argument("--language", help="restrict to a language (e.g. rust, python, markdown)")
    p.add_argument("--path-prefix", help="restrict to rel_path starting with this prefix")
    p.add_argument("--no-rerank", action="store_true", help="skip reranking (debug/cost)")
    p.add_argument("--json", action="store_true", help="print the raw JSON response")
    p.add_argument("--url", default=os.environ.get("RAG_SERVE_URL", DEFAULT_URL),
                   help="rag-serve base URL (or set $RAG_SERVE_URL)")
    args = p.parse_args()

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
        score = h.get("rerank_score")
        score = f"rr={score:.3f}" if score is not None else f"ann={h['ann_score']:.3f}"
        # Cite by repo + rel_path + line range — the portable provenance.
        print(f"\n{i:>2}. [{score}] {h['repo']}/{h['rel_path']}:{h['start_line']}-{h['end_line']} "
              f"({h['corpus']}/{h['language']})")
        preview = " ".join(h["text"].split())[:200]
        print(f"    {preview}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
