from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from agentrail.context.planner import classify_query
from agentrail.context.retrieval import query_context, search_context


class ClassifyQueryTests(unittest.TestCase):
    def mode(self, query: str) -> str:
        return classify_query(query)["retrievalMode"]

    # --- PRD query-class table -------------------------------------------------
    def test_exact_path(self) -> None:
        self.assertEqual(self.mode("agentrail/context/retrieval.py"), "exact")

    def test_exact_symbol(self) -> None:
        self.assertEqual(self.mode("build_context_pack()"), "exact")

    def test_error_text(self) -> None:
        self.assertEqual(
            self.mode("stale semantic embedding was reused after source text changed"),
            "exact",
        )

    def test_issue_pr_anchor(self) -> None:
        self.assertEqual(self.mode("issue #84 retrieval quality evaluation"), "exact_bm25")

    def test_conceptual(self) -> None:
        self.assertEqual(
            self.mode("where do we decide what context an agent should receive?"),
            "semantic",
        )

    def test_mixed_task(self) -> None:
        self.assertEqual(self.mode("fix token budget noise in context pack retrieval"), "hybrid")

    def test_relationship_heavy(self) -> None:
        self.assertEqual(self.mode("callers of graphRelationSubject()"), "exact_graph")

    def test_stale_memory(self) -> None:
        self.assertEqual(self.mode("old retrieval lesson for issue #84"), "hybrid")

    def test_denied_source(self) -> None:
        self.assertEqual(self.mode(".env"), "excluded")

    # --- AC1-AC3 signal combinations ------------------------------------------
    def test_anchor_only_is_exact_leaning(self) -> None:
        self.assertIn(self.mode("src/app/login.ts"), {"exact", "exact_graph", "exact_bm25"})

    def test_pure_concept_is_semantic(self) -> None:
        self.assertEqual(self.mode("how should retries be handled when a provider fails"), "semantic")

    def test_anchor_plus_concept_is_hybrid(self) -> None:
        self.assertEqual(self.mode("fix the flaky retry logic in src/worker/queue.ts"), "hybrid")

    def test_signals_are_exposed(self) -> None:
        result = classify_query("build_context_pack() in agentrail/context/packs.py")
        self.assertIn("signals", result)
        self.assertTrue(result["signals"]["symbol"])
        self.assertTrue(result["signals"]["path"])


class PlannerRoutingTests(unittest.TestCase):
    def make_repo(self) -> Path:
        root = Path(tempfile.mkdtemp())
        subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
        (root / ".agentrail").mkdir()
        (root / ".agentrail" / "config.json").write_text(json.dumps({
            "schemaVersion": 1,
            "context": {
                "includeGlobs": ["**/*"],
                "excludeGlobs": [".git/**", ".agentrail/context/**"],
                "maxFileSizeBytes": 262144,
                "skipBinary": True,
                "respectGitIgnore": True,
                "secretRedaction": {"enabled": False, "action": "exclude", "denyGlobs": []},
                "embedding": {"mode": "disabled", "provider": None, "model": None},
                "summary": {"mode": "disabled", "provider": None, "model": None},
            },
        }, indent=2), encoding="utf-8")
        (root / "src").mkdir(parents=True)
        (root / "src" / "packs.py").write_text(
            "def build_context_pack():\n    return True\n", encoding="utf-8")
        return root

    def test_query_context_records_retrieval_mode(self) -> None:
        root = self.make_repo()
        output = query_context(root, "build_context_pack()")
        self.assertEqual(output["retrievalMode"], "exact")
        self.assertIn("planner", output)
        self.assertTrue(output["planner"]["signals"]["symbol"])

    def test_search_context_records_retrieval_mode(self) -> None:
        root = self.make_repo()
        output = search_context(root, "where do we build the context pack?")
        self.assertEqual(output["retrievalMode"], "semantic")


class SourceWeightTests(unittest.TestCase):
    """Per-source weights (context source registry spec S.C).

    Deterministic: same signals that pick the retrieval mode, no model call.
    The gather phase already proved task-time LLM recon does not survive the
    two-set gate (#1049), so source selection has to be a signal table.
    """

    def weights(self, query: str):
        return classify_query(query)["sources"]

    def test_every_source_is_consulted_by_default(self) -> None:
        """The default is to consult. Skipping buys latency, never precision --
        and a wrong skip removes context the agent cannot know is missing."""
        weights = self.weights("update the retry handling")
        self.assertEqual(set(weights), {"code", "wiki", "memory"})
        self.assertTrue(all(weight > 0 for weight in weights.values()))

    def test_nothing_is_ever_gated_off_except_a_denied_query(self) -> None:
        for query in ("fix the login bug", "agentrail/context/packs.py", "how does retry work?",
                      "why did the previous run fail?", "callers of build_index"):
            with self.subTest(query=query):
                self.assertTrue(all(w > 0 for w in self.weights(query).values()))

    def test_a_concrete_anchor_favors_code_over_wiki(self) -> None:
        """Prose about a file is a poor substitute for the file when you can
        already name the file."""
        weights = self.weights("agentrail/context/packs.py")
        self.assertGreater(weights["code"], weights["wiki"])

    def test_a_conceptual_question_with_no_anchor_favors_the_wiki(self) -> None:
        weights = self.weights("how does the context pack get built?")
        self.assertGreater(weights["wiki"], weights["code"])

    def test_an_anchored_question_does_not_favor_the_wiki(self) -> None:
        """The wiki boost is for orientation, and an asker naming a path is
        already oriented."""
        weights = self.weights("how does agentrail/context/packs.py build the pack?")
        self.assertLessEqual(weights["wiki"], weights["code"])

    def test_memory_language_ranks_prior_context_above_code(self) -> None:
        """The regression case: what matters is what happened before, not what
        the code says now. This is the weighting the design is actually for --
        it changes what the agent sees FIRST, which gating cannot do."""
        weights = self.weights("why did the previous attempt at this fail?")
        self.assertGreater(weights["memory"], weights["code"])

    def test_a_denied_query_retrieves_from_nowhere(self) -> None:
        """The weights must not disagree with an `excluded` mode."""
        result = classify_query("what is in .env")
        self.assertEqual(result["retrievalMode"], "excluded")
        self.assertTrue(all(weight == 0.0 for weight in result["sources"].values()))

    def test_weights_are_deterministic(self) -> None:
        query = "how does the retry loop recover from a previous failure?"
        self.assertEqual(self.weights(query), self.weights(query))

    def test_existing_callers_are_unaffected(self) -> None:
        """`sources` is additive -- retrievalMode and signals are untouched."""
        result = classify_query("agentrail/context/packs.py")
        self.assertEqual(result["retrievalMode"], "exact")
        self.assertIn("signals", result)


if __name__ == "__main__":
    unittest.main()
