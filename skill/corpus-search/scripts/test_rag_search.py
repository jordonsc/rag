#!/usr/bin/env python3
"""Offline tests for rag_search.py: run with `python3 -I test_rag_search.py`."""
import contextlib
import io
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rag_search  # noqa: E402


def parse(*argv):
    return rag_search.build_parser().parse_args(list(argv))


class CorpusFlag(unittest.TestCase):
    def test_every_search_corpus_is_accepted(self):
        for corpus in ("code", "wiki", "ledger", "tracker"):
            body = rag_search.request_body(parse("q", "--corpus", corpus))
            self.assertEqual(body["filters"]["corpus"], corpus)

    def test_tracker_with_project(self):
        body = rag_search.request_body(parse("q", "--corpus", "tracker", "--repo", "rag"))
        self.assertEqual(body["filters"], {"corpus": "tracker", "repo": "rag"})

    def test_unknown_corpus_is_refused(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as e:
            parse("q", "--corpus", "logs")
        self.assertEqual(e.exception.code, 2)

    def test_no_filters_without_flags(self):
        self.assertNotIn("filters", rag_search.request_body(parse("q")))


class Citations(unittest.TestCase):
    def test_code_hit(self):
        h = {"corpus": "code", "repo": "rag", "rel_path": "crates/core/src/voyage.rs",
             "start_line": 120, "end_line": 138, "language": "rust", "text": "fn rerank()",
             "rerank_score": 0.86}
        out = rag_search.format_hit(1, h)
        self.assertIn("rag/crates/core/src/voyage.rs:120-138 (code/rust)", out)
        self.assertIn("fn rerank()", out)

    def test_ledger_hit_cites_topic_id(self):
        h = {"corpus": "ledger", "repo": "rag", "rel_path": "", "start_line": 0, "end_line": 0,
             "topic_id": "rag-0033", "type": "decision", "status": "accepted",
             "title": "Tracker: an agent-first queue",
             "text": "Tracker: an agent-first queue\n\nOwner, 2026-10-27. Managers lose track.",
             "rerank_score": 0.81}
        out = rag_search.format_hit(1, h)
        first = out.splitlines()[0]
        self.assertIn("rag-0033 (ledger/rag decision, accepted)", first)
        self.assertNotIn("rag/:0-0", out)
        lines = out.splitlines()
        self.assertEqual(lines[1].strip(), "Tracker: an agent-first queue")
        self.assertTrue(lines[2].strip().startswith("Owner, 2026-10-27."))

    def test_tracker_item_cites_its_id(self):
        h = {"corpus": "tracker", "repo": "rag", "rel_path": "rag-t0006", "kind": "item",
             "tracker_id": "rag-t0006", "citation": "rag-t0006", "type": "dev",
             "status": "done", "title": "MCP: tracker_next",
             "text": "MCP: tracker_next\nrag rag-t0006 · dev · done\n\nOwner question.",
             "ann_score": 0.31, "rerank_score": None}
        out = rag_search.format_hit(2, h)
        lines = out.splitlines()
        self.assertIn("[ann=0.310] rag-t0006 (tracker/rag item, dev, done)", lines[0])
        self.assertEqual(lines[2].strip(), "Owner question.")

    def test_tracker_document_cites_revision(self):
        h = {"corpus": "tracker", "repo": "ubu", "rel_path": "specs/logic/master.md",
             "kind": "spec", "tracker_id": "ubu-d0007",
             "citation": "ubu:specs/logic/master.md@r3", "title": "Logic",
             "text": "Logic · ubu:specs/logic/master.md\nThe body.", "start_line": 4,
             "end_line": 9, "rerank_score": 0.5}
        out = rag_search.format_hit(1, h)
        self.assertIn("ubu:specs/logic/master.md@r3 (tracker/ubu spec)", out)
        self.assertEqual(out.splitlines()[2].strip(), "The body.")

    def test_tracker_without_citation_falls_back_to_id(self):
        h = {"corpus": "tracker", "repo": "rag", "rel_path": "rag-t0001",
             "tracker_id": "rag-t0001", "kind": "item", "text": "", "rerank_score": 0.1}
        self.assertEqual(rag_search.citation(h), "rag-t0001")


if __name__ == "__main__":
    unittest.main()
