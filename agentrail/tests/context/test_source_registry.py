"""Tests for agentrail/context/source_registry.py (context source registry spec
§A/§B, step 3 of §K —
docs/superpowers/specs/2026-07-27-context-source-registry-design.md).

Phase one registers only the `code` source, whose ``search`` IS today's
``query_context`` call and whose merge is the identity function. So the
deliverable is not a new capability — it is an EQUIVALENCE, and that is what
most of this file proves: a pack built through the registry is byte-identical
to one built without it. If that fails, the wrapper is wrong, and no later
measurement of a second source would mean anything.

The rest pins the contracts a second source will depend on: fail-open per
source, deterministic provenance ordering, and a merge that REFUSES to
concatenate corpora rather than silently letting corpus size decide the pack.
"""
from __future__ import annotations

import json
import os
import unittest
from pathlib import Path
from typing import Any, Dict
from unittest import mock

from agentrail.context import source_registry
from agentrail.context.packs import build_context_pack
from agentrail.context.source_registry import (
    REGISTRY_ENV,
    CodeSource,
    Registry,
    SourceBudget,
    SourceOutcome,
    build_registry,
    consult,
    merge,
    query_sources,
    registry_enabled,
)

# The pack fixture is expensive to build (git init + index), so it is shared
# with the gather-phase tests rather than duplicated.
from agentrail.tests.context.test_gather_pack_phase import _make_repo

_VOLATILE_SUFFIX = ("generatedat", "builtat", "compiledat", "elapsedms", "durationms", "timestamp")


def _is_volatile(key: str) -> bool:
    return key.lower().endswith(_VOLATILE_SUFFIX)


def _stable(value: Any) -> Any:
    """Strip wall-clock fields so two builds are comparable.

    Only time-derived keys are removed — every scoring, ordering, and content
    field stays in the comparison, which is where a wrapper bug would show up.
    Suffix-matched rather than exact-matched so nested variants like
    ``queryGeneratedAt`` are covered too.
    """
    if isinstance(value, dict):
        return {k: _stable(v) for k, v in value.items() if not _is_volatile(k)}
    if isinstance(value, list):
        return [_stable(item) for item in value]
    return value


class _StubSource:
    def __init__(self, name: str, payload=None, error: Exception | None = None) -> None:
        self.name = name
        self.authority = "normal"
        self._payload = payload
        self._error = error
        self.calls = 0

    def search(self, root: Path, query_text: str, budget: SourceBudget) -> Dict[str, Any]:
        self.calls += 1
        if self._error is not None:
            raise self._error
        return self._payload


class FlagTests(unittest.TestCase):
    def test_default_is_on(self) -> None:
        """Inverted from the package's usual default-OFF convention on
        purpose. With `code` as the only source there is no behaviour change
        to protect against, and default-OFF would leave the thread pool,
        fail-open path, and provenance unexercised until the day a second
        source lands — flipping the seam and the source together, with no way
        to tell which one moved a metric."""
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(REGISTRY_ENV, None)
            self.assertTrue(registry_enabled())

    def test_only_an_explicit_zero_turns_it_off(self) -> None:
        """The escape hatch has to be unambiguous: an incident or a bisect
        sets 0 and gets the direct query_context call back without a deploy.
        Nothing else reads as off — an empty or misspelled value must not
        silently disable retrieval plumbing."""
        for raw, expected in (("0", False), (" 0 ", False), ("1", True), ("", True), ("true", True), ("no", True)):
            with self.subTest(raw=raw), mock.patch.dict(os.environ, {REGISTRY_ENV: raw}):
                self.assertEqual(registry_enabled(), expected)


class RegistryShapeTests(unittest.TestCase):
    def test_phase_one_registers_code_only(self) -> None:
        """Wiki arrives with the planner's source weights (§K step 4); memory
        migrates last (§F) so it cannot contaminate the first measurement."""
        self.assertEqual(build_registry(Path(".")).names(), ["code"])

    def test_code_source_declares_the_authority_tier_code_records_carry(self) -> None:
        self.assertEqual(CodeSource().authority, "normal")

    def test_code_source_delegates_to_query_context_with_the_budget_limit(self) -> None:
        with mock.patch("agentrail.context.retrieval.query_context", return_value={"results": []}) as qc:
            CodeSource().search(Path("/x"), "some task", SourceBudget(max_items=7, max_tokens=100))
        qc.assert_called_once()
        self.assertEqual(qc.call_args.kwargs["limit"], 7)


class ConsultTests(unittest.TestCase):
    def _budget(self) -> SourceBudget:
        return SourceBudget(max_items=20, max_tokens=1000)

    def test_no_sources_is_an_empty_result_not_a_crash(self) -> None:
        self.assertEqual(consult(Path("."), "q", self._budget(), []), [])

    def test_a_raising_source_degrades_to_zero_candidates(self) -> None:
        """Fail-open per source: one broken source must never fail the pack."""
        broken = _StubSource("broken", error=ValueError("boom"))
        healthy = _StubSource("healthy", payload={"results": [{"path": "a.py"}]})
        outcomes = consult(Path("."), "q", self._budget(), [broken, healthy])
        by_name = {o.name: o for o in outcomes}
        self.assertFalse(by_name["broken"].ok)
        self.assertIn("ValueError: boom", by_name["broken"].error)
        self.assertEqual(by_name["broken"].candidate_count, 0)
        self.assertTrue(by_name["healthy"].ok)

    def test_a_source_returning_the_wrong_type_is_an_error_not_a_payload(self) -> None:
        outcomes = consult(Path("."), "q", self._budget(), [_StubSource("weird", payload=["not", "a", "dict"])])
        self.assertFalse(outcomes[0].ok)
        self.assertIn("expected dict", outcomes[0].error)

    def test_outcomes_follow_registration_order_not_completion_order(self) -> None:
        """Provenance has to be deterministic, or two identical runs produce
        packs whose metadata differs by a race."""
        sources = [_StubSource(f"s{i}", payload={"results": []}) for i in range(4)]
        outcomes = consult(Path("."), "q", self._budget(), sources)
        self.assertEqual([o.name for o in outcomes], ["s0", "s1", "s2", "s3"])

    def test_single_source_is_called_exactly_once(self) -> None:
        source = _StubSource("code", payload={"results": []})
        consult(Path("."), "q", self._budget(), [source])
        self.assertEqual(source.calls, 1)


class MergeTests(unittest.TestCase):
    def test_single_source_merge_is_the_identity_function(self) -> None:
        """Not a copy, not a rebuild — the same object. This is what makes a
        registry-built pack byte-identical to a directly-built one."""
        payload = {"results": [{"path": "a.py"}], "excluded": []}
        merged = merge([SourceOutcome(name="code", payload=payload)])
        self.assertIs(merged, payload)

    def test_all_sources_failing_raises_with_every_reason(self) -> None:
        with self.assertRaises(RuntimeError) as caught:
            merge([
                SourceOutcome(name="code", error="Timeout"),
                SourceOutcome(name="wiki", error="HTTP 500"),
            ])
        message = str(caught.exception)
        self.assertIn("code: Timeout", message)
        self.assertIn("wiki: HTTP 500", message)

    def test_multi_source_merge_refuses_rather_than_concatenating(self) -> None:
        """BM25 scores are corpus-relative, so concatenating a 64-page wiki
        corpus with a 40k-chunk code corpus would let corpus size decide the
        pack. Raising is deliberate: a silent concatenation would look like it
        worked, and §E has to be settled against the fixtures first."""
        with self.assertRaises(NotImplementedError) as caught:
            merge([
                SourceOutcome(name="code", payload={"results": []}),
                SourceOutcome(name="wiki", payload={"results": []}),
            ])
        self.assertIn("§E", str(caught.exception))

    def test_one_failure_among_successes_still_merges(self) -> None:
        payload = {"results": []}
        self.assertIs(
            merge([SourceOutcome(name="code", payload=payload), SourceOutcome(name="wiki", error="down")]),
            payload,
        )


class QuerySourcesTests(unittest.TestCase):
    def test_provenance_is_additive_and_names_every_source(self) -> None:
        payload = {"results": [{"path": "a.py"}], "excluded": []}
        with mock.patch.object(source_registry, "build_registry", return_value=Registry(sources=[_StubSource("code", payload=payload)])):
            merged = query_sources(Path("."), "task text", {"maxItems": 20, "maxTokens": 1000})
        self.assertEqual(merged["results"], payload["results"])
        provenance = merged["sourceProvenance"]
        self.assertEqual([p["name"] for p in provenance], ["code"])
        self.assertTrue(provenance[0]["ok"])
        self.assertEqual(provenance[0]["candidates"], 1)

    def test_a_failed_source_is_recorded_not_dropped(self) -> None:
        """A pack that silently omits a source reads identically to one where
        that source had nothing to say. Those are very different facts."""
        sources = [_StubSource("code", payload={"results": []}), _StubSource("wiki", error=RuntimeError("down"))]
        with mock.patch.object(source_registry, "build_registry", return_value=Registry(sources=sources)):
            merged = query_sources(Path("."), "task text", {"maxItems": 20, "maxTokens": 1000})
        wiki_provenance = next(p for p in merged["sourceProvenance"] if p["name"] == "wiki")
        self.assertFalse(wiki_provenance["ok"])
        self.assertIn("down", wiki_provenance["error"])


class ByteIdenticalPackTests(unittest.TestCase):
    """The deliverable of phase one, proven end to end on a real repo."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.root = _make_repo()

    def _pack(self, *, registry_on: bool, run_id: str) -> str:
        """One pack, serialized with wall-clock and run-id noise normalized.

        Each build gets its OWN run_id on purpose. The dedup layer reuses
        items from prior packs with the SAME run_id, so building twice under
        one id would make the second build reuse the first's items and report
        a different `retrieval_dedup` — a difference caused by the test's own
        ordering, not by the registry. Distinct ids give both builds the same
        empty prior state; the id itself is then normalized out.
        """
        with mock.patch.dict(os.environ, {REGISTRY_ENV: "1" if registry_on else "0"}):
            pack = build_context_pack(self.root, "issue", 9, "plan", run_id=run_id)
        return json.dumps(_stable(pack), sort_keys=True).replace(run_id, "RUN_ID")

    def test_registry_on_and_off_produce_the_same_pack(self) -> None:
        off = self._pack(registry_on=False, run_id="run-off")
        on = self._pack(registry_on=True, run_id="run-on")
        self.assertEqual(
            off, on,
            "the registry's code-only path must not change a single pack field",
        )

    def test_the_default_routes_through_the_registry(self) -> None:
        """Guards the test above from passing vacuously: if the flag were
        ignored, both branches would trivially match. Also pins that an
        UNSET env — what production actually runs with — takes the registry
        path, not just an explicit "1"."""
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(REGISTRY_ENV, None)
            with mock.patch.object(source_registry, "query_sources", wraps=source_registry.query_sources) as spied:
                build_context_pack(self.root, "issue", 9, "plan", run_id="fixed-run")
        spied.assert_called_once()

    def test_the_escape_hatch_bypasses_the_registry_entirely(self) -> None:
        with mock.patch.dict(os.environ, {REGISTRY_ENV: "0"}), \
             mock.patch.object(source_registry, "query_sources") as spied:
            build_context_pack(self.root, "issue", 9, "plan", run_id="fixed-run")
        spied.assert_not_called()


if __name__ == "__main__":
    unittest.main()
