"""Acceptance tests for issue #1044 PR 2 — LLM listwise rerank (default OFF).

Behind ``AGENTRAIL_CONTEXT_LLM_RERANK`` (default OFF), ``query_context`` runs a
Haiku listwise stage AFTER the deterministic rerank that only REORDERS the kept
list — membership (and thus recall) is untouched, rejection stays
deterministic-only, and the method string composes to
``deterministic_code_aware_v1+haiku_listwise_v1``.  The stage is fail-open
(missing API key / API errors fall back to the deterministic order with a
surfaced reason) and reports raw token usage as the PR 3 metering seam.

No test here touches the network: ``_call_model`` is the single seam and every
test either passes a fake ``call_model`` or monkeypatches the module global.
"""
from __future__ import annotations

import copy
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import ExitStack, contextmanager
from pathlib import Path
from unittest import mock

from agentrail.context.index import build_index
from agentrail.context.llm_rerank import (
    LLM_RERANK_DEFAULT_MODEL,
    LLM_RERANK_METHOD,
    build_window_prompt,
    llm_rerank,
    llm_rerank_enabled,
    parse_window_order,
    resolve_llm_rerank_model,
    window_spans,
)
from agentrail.context.retrieval import query_context

_FLAG = "AGENTRAIL_CONTEXT_LLM_RERANK"
_MODEL_ENV = "AGENTRAIL_CONTEXT_LLM_RERANK_MODEL"


@contextmanager
def _env(key: str, value: str | None):
    """Temporarily set (or unset, for value=None) an env var."""
    prev = os.environ.get(key)
    if value is None:
        os.environ.pop(key, None)
    else:
        os.environ[key] = value
    try:
        yield
    finally:
        if prev is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = prev


@contextmanager
def _envs(**pairs: str | None):
    """Apply several _env overrides at once (kwargs use __ for nothing fancy —
    keys are passed verbatim)."""
    with ExitStack() as stack:
        for key, value in pairs.items():
            stack.enter_context(_env(key, value))
        yield


def _usage(input_tokens: int = 100, output_tokens: int = 10) -> dict:
    return {
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "cacheCreationInputTokens": 0,
        "cacheReadInputTokens": 0,
    }


def _prompt_ids(prompt: str) -> list[str]:
    """Candidate ids in prompt order, parsed from the '[cN] path=...' lines."""
    ids = []
    for line in prompt.splitlines():
        stripped = line.strip()
        if stripped.startswith("[c") and "]" in stripped:
            ids.append(stripped[1 : stripped.index("]")])
    return ids


def _reversing_call(model: str, prompt: str) -> tuple[str, dict]:
    """Fake model: reverse every window (a maximally order-changing response)."""
    return json.dumps(list(reversed(_prompt_ids(prompt)))), _usage()


def _garbage_call(model: str, prompt: str) -> tuple[str, dict]:
    """Fake model: unparseable output (no JSON array to salvage)."""
    return 'the best candidate is definitely "c9999', _usage()


def _candidates(count: int) -> list[dict]:
    return [
        {"path": f"pkg/mod_{position}.py", "sourceType": "code", "content": f"def fn_{position}(): pass"}
        for position in range(1, count + 1)
    ]


# The retrieval fixture's answer symbol repeats the query's words so it is
# retrieved lexically as a code candidate (same trick as test_symbol_packing).
_PLANNER_SOURCE = '''def plan_pack(target):
    """Plan the context pack for a target issue.

    Covers required context, likely files, docs, memory, prior mistakes,
    active state, tools, skills, excluded context and open questions.
    """
    sections = [
        "required context",
        "likely files",
        "docs",
        "memory",
        "prior mistakes",
        "active state",
        "tools",
        "skills",
        "excluded context",
        "open questions",
    ]
    return {"target": target, "sections": sections}


def rolling_checksum(payload):
    """Rolling checksum over raw bytes; lexical filler unrelated to packs."""
    total = 0
    for byte in payload:
        total = (total * 31 + byte) % 65521
    return total
'''

_QUERY = (
    "plan pack required context likely files docs memory prior mistakes "
    "active state tools skills excluded context open questions"
)


def _make_repo() -> Path:
    """Tiny git repo whose built index retrieves >=2 candidates for _QUERY."""
    root = Path(tempfile.mkdtemp())
    (root / ".agentrail").mkdir()
    (root / ".agentrail" / "config.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "context": {
                    "includeGlobs": ["**/*"],
                    "excludeGlobs": [".git/**", ".agentrail/context/**"],
                    "maxFileSizeBytes": 262144,
                    "skipBinary": True,
                    "respectGitIgnore": True,
                    "secretRedaction": {"enabled": False, "action": "exclude", "denyGlobs": []},
                    "embedding": {"mode": "disabled"},
                    "summary": {"mode": "disabled"},
                },
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    (root / "CONTEXT.md").write_text(
        "# Context\n\nContext pack planning covers required context, likely "
        "files, docs, memory, prior mistakes and open questions.\n",
        encoding="utf-8",
    )
    docs = root / "docs"
    docs.mkdir()
    (docs / "planning-notes.md").write_text(
        "# Planning notes\n\nRequired context, likely files, docs, memory, "
        "active state, tools, skills, excluded context, open questions.\n",
        encoding="utf-8",
    )
    src = root / "agentrail"
    src.mkdir()
    (src / "planner.py").write_text(_PLANNER_SOURCE, encoding="utf-8")
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.email", "t@t.com"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.name", "t"], check=True)
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    subprocess.run(["git", "-C", str(root), "commit", "--quiet", "-m", "init"], check=True)
    build_index(root)
    return root


_VOLATILE_KEYS = {"packId", "generatedAt", "queryGeneratedAt"}


def _canonical(output: dict) -> str:
    """query_context output with volatile fields (timestamps) scrubbed so two
    runs of the same query compare byte-identical."""

    def scrub(value):
        if isinstance(value, dict):
            return {k: scrub(v) for k, v in value.items() if k not in _VOLATILE_KEYS}
        if isinstance(value, list):
            return [scrub(v) for v in value]
        return value

    return json.dumps(scrub(copy.deepcopy(output)), sort_keys=True)


class LlmRerankFlagTests(unittest.TestCase):
    def test_flag_defaults_off_and_parses_truthy_values(self) -> None:
        with _env(_FLAG, None):
            self.assertFalse(llm_rerank_enabled(), "flag must default OFF when unset")
        for raw in ("0", "false", "off", "no", ""):
            with _env(_FLAG, raw):
                self.assertFalse(llm_rerank_enabled(), f"{raw!r} must be OFF")
        for raw in ("1", "true", "on", "yes", " TRUE "):
            with _env(_FLAG, raw):
                self.assertTrue(llm_rerank_enabled(), f"{raw!r} must be ON")

    def test_model_is_pinned_and_env_overridable(self) -> None:
        with _env(_MODEL_ENV, None):
            self.assertEqual(resolve_llm_rerank_model(), LLM_RERANK_DEFAULT_MODEL)
        with _env(_MODEL_ENV, "claude-haiku-x-test"):
            self.assertEqual(resolve_llm_rerank_model(), "claude-haiku-x-test")
        with _env(_MODEL_ENV, "   "):
            self.assertEqual(
                resolve_llm_rerank_model(),
                LLM_RERANK_DEFAULT_MODEL,
                "a blank override must fall back to the pinned default",
            )


class WindowSpanTests(unittest.TestCase):
    def test_empty_and_single_window_counts(self) -> None:
        self.assertEqual(window_spans(0), [])
        self.assertEqual(window_spans(-3), [])
        self.assertEqual(window_spans(1), [(0, 1)])
        self.assertEqual(window_spans(10), [(0, 10)])

    def test_sliding_windows_walk_back_to_front_with_overlap(self) -> None:
        self.assertEqual(window_spans(25), [(15, 25), (10, 20), (5, 15), (0, 10)])

    def test_last_span_always_decides_the_head(self) -> None:
        for count in (11, 13, 20, 25, 37):
            spans = window_spans(count)
            self.assertEqual(spans[-1], (0, 10), f"count={count}")

    def test_spans_cover_every_position(self) -> None:
        for count in (1, 7, 10, 11, 23, 25, 50):
            covered: set[int] = set()
            for start, end in window_spans(count):
                covered.update(range(start, end))
            self.assertEqual(covered, set(range(count)), f"count={count}")


class ParseWindowOrderTests(unittest.TestCase):
    WINDOW = ["c1", "c2", "c3", "c4"]

    def test_valid_permutation_is_applied(self) -> None:
        self.assertEqual(
            parse_window_order('["c3", "c1", "c4", "c2"]', self.WINDOW),
            ["c3", "c1", "c4", "c2"],
        )

    def test_json_array_embedded_in_prose_is_extracted(self) -> None:
        text = 'Sure! Here is the ranking:\n["c2", "c1", "c3", "c4"]\nHope that helps.'
        self.assertEqual(parse_window_order(text, self.WINDOW), ["c2", "c1", "c3", "c4"])

    def test_invented_ids_are_dropped(self) -> None:
        self.assertEqual(
            parse_window_order('["c99", "c2", "made-up", "c1", "c3", "c4"]', self.WINDOW),
            ["c2", "c1", "c3", "c4"],
        )

    def test_duplicates_keep_first_occurrence(self) -> None:
        self.assertEqual(
            parse_window_order('["c2", "c2", "c1", "c2", "c3", "c4"]', self.WINDOW),
            ["c2", "c1", "c3", "c4"],
        )

    def test_omitted_ids_are_appended_in_prior_relative_order(self) -> None:
        self.assertEqual(
            parse_window_order('["c4"]', self.WINDOW),
            ["c4", "c1", "c2", "c3"],
            "omitted ids must keep their prior relative order at the end",
        )

    def test_malformed_output_degrades_to_prior_order(self) -> None:
        for text in ("", "not json at all", '{"c1": 1}', "[unclosed", None):
            self.assertEqual(
                parse_window_order(text, self.WINDOW),
                self.WINDOW,
                f"malformed {text!r} must fall back to the prior order",
            )

    def test_result_is_always_a_permutation(self) -> None:
        for text in ('["c1"]', '["c9", "c9"]', "[]", "garbage", '["c4","c4","c3"]'):
            result = parse_window_order(text, self.WINDOW)
            self.assertEqual(sorted(result), sorted(self.WINDOW), f"text={text!r}")


class BuildWindowPromptTests(unittest.TestCase):
    def test_prompt_carries_every_id_the_query_and_collapsed_snippets(self) -> None:
        window = [
            ("c1", {"path": "a.py", "sourceType": "code", "content": "def   a():\n    pass"}),
            ("c2", {"path": "b.md", "sourceType": "doc", "content": "x" * 1000}),
        ]
        prompt = build_window_prompt("find the frobnicator", window)
        self.assertIn("find the frobnicator", prompt)
        self.assertIn("[c1] path=a.py", prompt)
        self.assertIn("[c2] path=b.md", prompt)
        self.assertIn("def a(): pass", prompt, "snippet whitespace must be collapsed")
        self.assertNotIn("x" * 500, prompt, "snippets must be truncated")
        self.assertEqual(_prompt_ids(prompt), ["c1", "c2"])


class LlmRerankUnitTests(unittest.TestCase):
    def test_reorders_a_single_window_and_reports_usage(self) -> None:
        candidates = _candidates(3)
        with _env("ANTHROPIC_API_KEY", "test-key"):
            result = llm_rerank(candidates, query="q", call_model=_reversing_call)
        self.assertIsNone(result["fallback"])
        self.assertTrue(result["changed"])
        self.assertEqual(result["ordered"], list(reversed(candidates)))
        self.assertEqual(result["llm"]["model"], LLM_RERANK_DEFAULT_MODEL)
        self.assertEqual(result["llm"]["calls"], 1)
        self.assertEqual(result["llm"]["inputTokens"], 100)
        self.assertEqual(result["llm"]["outputTokens"], 10)

    def test_windows_are_walked_and_usage_is_aggregated(self) -> None:
        candidates = _candidates(25)
        calls: list[list[str]] = []

        def recording_call(model: str, prompt: str) -> tuple[str, dict]:
            ids = _prompt_ids(prompt)
            calls.append(ids)
            return json.dumps(ids), _usage(7, 3)

        with _env("ANTHROPIC_API_KEY", "test-key"):
            result = llm_rerank(candidates, query="q", call_model=recording_call)
        self.assertIsNone(result["fallback"])
        self.assertEqual(result["llm"]["calls"], 4, "25 candidates = 4 sliding windows")
        self.assertEqual(result["llm"]["inputTokens"], 28)
        self.assertEqual(result["llm"]["outputTokens"], 12)
        self.assertEqual(len(calls), 4)
        for window_ids in calls:
            self.assertLessEqual(len(window_ids), 10)
        # Identity permutation in = identity order out.
        self.assertEqual(result["ordered"], candidates)
        self.assertFalse(result["changed"])

    def test_membership_survives_garbage_responses(self) -> None:
        candidates = _candidates(25)
        with _env("ANTHROPIC_API_KEY", "test-key"):
            result = llm_rerank(candidates, query="q", call_model=_garbage_call)
        self.assertIsNone(result["fallback"])
        self.assertEqual(
            sorted(item["path"] for item in result["ordered"]),
            sorted(item["path"] for item in candidates),
            "the LLM stage must NEVER drop or duplicate a candidate",
        )
        self.assertEqual(result["ordered"], candidates, "garbage output = deterministic order")

    def test_reversal_across_windows_is_still_a_permutation(self) -> None:
        candidates = _candidates(25)
        with _env("ANTHROPIC_API_KEY", "test-key"):
            result = llm_rerank(candidates, query="q", call_model=_reversing_call)
        self.assertIsNone(result["fallback"])
        self.assertTrue(result["changed"])
        ordered_ids = [id(item) for item in result["ordered"]]
        self.assertEqual(sorted(ordered_ids), sorted(id(item) for item in candidates))
        self.assertEqual(len(set(ordered_ids)), len(candidates))

    def test_api_error_falls_back_open_with_partial_usage(self) -> None:
        candidates = _candidates(25)
        state = {"calls": 0}

        def flaky_call(model: str, prompt: str) -> tuple[str, dict]:
            state["calls"] += 1
            if state["calls"] > 1:
                raise RuntimeError("boom")
            return json.dumps(_prompt_ids(prompt)), _usage(50, 5)

        with _env("ANTHROPIC_API_KEY", "test-key"):
            result = llm_rerank(candidates, query="q", call_model=flaky_call)
        self.assertEqual(result["fallback"], "api_error:RuntimeError")
        self.assertEqual(result["ordered"], candidates, "fallback must keep the input order")
        self.assertEqual(result["llm"]["calls"], 1, "only the successful call is counted")
        self.assertEqual(result["llm"]["inputTokens"], 50, "aborted attempts still get metered")

    def test_missing_api_key_falls_back_without_calling(self) -> None:
        candidates = _candidates(5)
        fake = mock.Mock(side_effect=AssertionError("must not be called"))
        with _env("ANTHROPIC_API_KEY", None):
            result = llm_rerank(candidates, query="q", call_model=fake)
        self.assertEqual(result["fallback"], "missing_api_key")
        self.assertEqual(result["ordered"], candidates)
        self.assertEqual(result["llm"]["calls"], 0)
        fake.assert_not_called()

    def test_fewer_than_two_candidates_is_a_no_op(self) -> None:
        fake = mock.Mock(side_effect=AssertionError("must not be called"))
        with _env("ANTHROPIC_API_KEY", "test-key"):
            for candidates in ([], _candidates(1)):
                result = llm_rerank(candidates, query="q", call_model=fake)
                self.assertIsNone(result["fallback"])
                self.assertEqual(result["ordered"], candidates)
                self.assertEqual(result["llm"]["calls"], 0)
        fake.assert_not_called()


class LlmRerankRetrievalWiringTests(unittest.TestCase):
    """Flag ON ⇒ query_context composes the stage after the deterministic
    rerank: composed method string, model + usage telemetry in the compiler
    contract, membership identical to flag OFF, honest fallbacks."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.repo = _make_repo()

    def _query(self, **env: str | None) -> dict:
        with _envs(AGENTRAIL_CONTEXT_RERANK="1", **env):
            return query_context(self.repo, _QUERY)

    def test_fixture_retrieves_multiple_candidates(self) -> None:
        """Precondition guard: <2 kept candidates would make the wiring tests
        vacuous (the LLM stage no-ops below two)."""
        output = self._query(**{_FLAG: None})
        self.assertGreaterEqual(
            len(output.get("results") or []),
            2,
            f"fixture must retrieve >=2 results; got {[r.get('path') for r in output.get('results') or []]}",
        )

    def test_flag_on_reorders_and_threads_telemetry(self) -> None:
        off_output = self._query(**{_FLAG: None})
        with mock.patch("agentrail.context.llm_rerank._call_model", side_effect=_reversing_call) as seam:
            on_output = self._query(**{_FLAG: "1", "ANTHROPIC_API_KEY": "test-key"})
        self.assertTrue(seam.called, "flag ON must route through the single model seam")

        contract = (on_output.get("compiler") or {}).get("rerank") or {}
        self.assertTrue(
            str(contract.get("method", "")).endswith(f"+{LLM_RERANK_METHOD}"),
            f"method must compose the listwise suffix; got {contract.get('method')!r}",
        )
        self.assertEqual(contract.get("model"), LLM_RERANK_DEFAULT_MODEL)
        self.assertNotIn("llmFallback", contract)
        llm = contract.get("llm") or {}
        self.assertEqual(llm.get("model"), LLM_RERANK_DEFAULT_MODEL)
        self.assertGreaterEqual(llm.get("calls"), 1)
        self.assertEqual(llm.get("inputTokens"), 100 * llm["calls"])
        self.assertEqual(llm.get("outputTokens"), 10 * llm["calls"])
        self.assertIs(contract.get("orderChanged"), True)

        on_results = on_output.get("results") or []
        off_results = off_output.get("results") or []
        self.assertEqual(
            sorted(r.get("path") for r in on_results),
            sorted(r.get("path") for r in off_results),
            "the LLM stage must only REORDER — membership must match flag OFF",
        )
        self.assertNotEqual(
            [r.get("path") for r in on_results],
            [r.get("path") for r in off_results],
            "a reversing model response must actually change the order",
        )
        self.assertEqual(
            [r.get("rank") for r in on_results],
            list(range(1, len(on_results) + 1)),
            "ranks must be reassigned to match the new order",
        )
        self.assertEqual(
            contract.get("rankedCandidateIds"),
            [r.get("chunkId") or r.get("sourceId") or r.get("citation") or r.get("path") for r in on_results],
            "rankedCandidateIds must reflect the LLM order",
        )

    def test_garbage_model_output_preserves_deterministic_behavior(self) -> None:
        off_output = self._query(**{_FLAG: None})
        with mock.patch("agentrail.context.llm_rerank._call_model", side_effect=_garbage_call) as seam:
            on_output = self._query(**{_FLAG: "1", "ANTHROPIC_API_KEY": "test-key"})
        self.assertTrue(seam.called)
        self.assertEqual(
            [r.get("path") for r in (on_output.get("results") or [])],
            [r.get("path") for r in (off_output.get("results") or [])],
            "unparseable model output must leave the deterministic order intact",
        )

    def test_flag_on_without_api_key_falls_back_honestly(self) -> None:
        fake = mock.Mock(side_effect=AssertionError("must not hit the network seam"))
        with mock.patch("agentrail.context.llm_rerank._call_model", fake):
            output = self._query(**{_FLAG: "1", "ANTHROPIC_API_KEY": None})
        fake.assert_not_called()
        contract = (output.get("compiler") or {}).get("rerank") or {}
        self.assertEqual(contract.get("llmFallback"), "missing_api_key")
        self.assertNotIn(
            LLM_RERANK_METHOD,
            str(contract.get("method", "")),
            "fallback must NOT claim the listwise method ran",
        )
        self.assertIsNone(contract.get("model"), "fallback must not attribute a model")
        llm = contract.get("llm") or {}
        self.assertEqual(llm.get("calls"), 0)


class LlmRerankOffByteIdentityTests(unittest.TestCase):
    """Flag OFF ⇒ byte-identical query behavior to today (the merged main
    pipeline never sees the stage)."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.repo = _make_repo()

    def test_flag_off_output_is_identical_to_flag_unset(self) -> None:
        with _envs(AGENTRAIL_CONTEXT_RERANK="1", **{_FLAG: None}):
            unset_output = query_context(self.repo, _QUERY)
        with _envs(AGENTRAIL_CONTEXT_RERANK="1", **{_FLAG: "0"}):
            off_output = query_context(self.repo, _QUERY)
        self.assertEqual(
            _canonical(unset_output),
            _canonical(off_output),
            "with the flag OFF the query output must be byte-identical to "
            "today's (flag-unset) behavior — the LLM stage must be a strict no-op",
        )
        for output in (unset_output, off_output):
            contract = (output.get("compiler") or {}).get("rerank") or {}
            self.assertNotIn("llm", contract, "flag OFF must not emit LLM telemetry")
            self.assertNotIn("llmFallback", contract, "flag OFF must not emit a fallback reason")
            self.assertNotIn(LLM_RERANK_METHOD, str(contract.get("method", "")))


if __name__ == "__main__":
    unittest.main()
