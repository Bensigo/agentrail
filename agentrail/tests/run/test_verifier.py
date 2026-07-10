"""Tests for the Independent Verifier deep module (issue #782, ADR 0008).

The Verifier is **Independent Verification** (CONTEXT.md): a blocking, narrow
quality check performed by a *different* model than the Implementer. It verifies
one falsifiable question — do the tests and the change genuinely satisfy the
issue's acceptance criteria, or were they gamed/skipped?

This module is the *pure* core (verification-contract-architecture.md): model
selection, verdict parsing, and the block/allow decision take plain inputs and
return plain results. Running the verifier agent (the model call) is thin
pipeline orchestration tested elsewhere.
"""
from __future__ import annotations

import unittest

from agentrail.run.verifier import (
    Verdict,
    decide,
    gate_evidence,
    parse_verdict,
    select_verifier_model,
)


# ---------------------------------------------------------------------------
# AC1: the Verifier uses a DIFFERENT model than the Implementer
# ---------------------------------------------------------------------------

class SelectVerifierModelTests(unittest.TestCase):
    def test_picks_a_candidate_different_from_implementer(self) -> None:
        chosen = select_verifier_model(
            "claude-opus-4-8",
            ["claude-opus-4-8", "claude-sonnet-4-6"],
        )
        self.assertNotEqual(chosen, "claude-opus-4-8")
        self.assertEqual(chosen, "claude-sonnet-4-6")

    def test_returns_empty_when_no_candidate_differs(self) -> None:
        """If every candidate equals the implementer's model there is no distinct
        verifier model — selection returns '' (the pipeline must not run a same-
        model verifier; AC1 cannot be satisfied)."""
        self.assertEqual(
            select_verifier_model("claude-opus-4-8", ["claude-opus-4-8"]), ""
        )

    def test_returns_empty_when_no_candidates(self) -> None:
        self.assertEqual(select_verifier_model("claude-opus-4-8", []), "")

    def test_skips_empty_candidate_entries(self) -> None:
        chosen = select_verifier_model(
            "claude-opus-4-8", ["", "claude-opus-4-8", "claude-haiku-4-5"]
        )
        self.assertEqual(chosen, "claude-haiku-4-5")

    def test_first_distinct_candidate_wins(self) -> None:
        chosen = select_verifier_model(
            "impl-model", ["other-a", "other-b"]
        )
        self.assertEqual(chosen, "other-a")

    def test_no_implementer_model_still_picks_first_nonempty(self) -> None:
        """When the implementer model is unknown ('') any non-empty candidate is
        usable as the verifier model."""
        self.assertEqual(
            select_verifier_model("", ["", "claude-sonnet-4-6"]), "claude-sonnet-4-6"
        )


# ---------------------------------------------------------------------------
# Verdict parsing — the structured, testable result (accept / reject + reason)
# ---------------------------------------------------------------------------

class ParseVerdictTests(unittest.TestCase):
    def test_parses_accept_json(self) -> None:
        v = parse_verdict('{"verdict": "accept", "reason": "tests cover the AC"}')
        self.assertTrue(v.accepted)
        self.assertEqual(v.reason, "tests cover the AC")

    def test_parses_reject_json(self) -> None:
        v = parse_verdict('{"verdict": "reject", "reason": "test asserts True"}')
        self.assertFalse(v.accepted)
        self.assertEqual(v.reason, "test asserts True")

    def test_extracts_verdict_json_from_surrounding_prose(self) -> None:
        text = (
            "I reviewed the change and the acceptance test.\n"
            'VERDICT: {"verdict": "reject", "reason": "tautological test"}\n'
            "Done."
        )
        v = parse_verdict(text)
        self.assertFalse(v.accepted)
        self.assertIn("tautological", v.reason)

    def test_unparseable_output_is_rejected_failclosed(self) -> None:
        """A verifier that produces no structured verdict is treated as a REJECT
        (fail-closed): an unverifiable run must not silently reach done."""
        v = parse_verdict("the agent crashed with no verdict")
        self.assertFalse(v.accepted)
        self.assertIn("no verdict", v.reason.lower())

    def test_empty_output_is_rejected_failclosed(self) -> None:
        v = parse_verdict("")
        self.assertFalse(v.accepted)

    def test_unknown_verdict_value_is_rejected(self) -> None:
        v = parse_verdict('{"verdict": "maybe", "reason": "unsure"}')
        self.assertFalse(v.accepted)


# ---------------------------------------------------------------------------
# decide() — pure block/allow given a structured verdict
# ---------------------------------------------------------------------------

class DecideTests(unittest.TestCase):
    def test_accept_allows(self) -> None:
        result = decide(Verdict(accepted=True, reason="ok"))
        self.assertTrue(result.allowed)
        self.assertFalse(result.blocked)

    def test_reject_blocks(self) -> None:
        result = decide(Verdict(accepted=False, reason="gamed test"))
        self.assertTrue(result.blocked)
        self.assertFalse(result.allowed)
        self.assertIn("gamed test", result.reason)


# ---------------------------------------------------------------------------
# gate_evidence — VETO-ONLY bridge to the Objective Gate.
#
# The LLM verifier can only *veto* (reject → block done). Its *accept* is
# advisory: it can never by itself turn the gate GREEN — green must come from
# real executed checks. So:
#   * REJECT  → required=True,  valid=False  (a blocking veto)
#   * ACCEPT  → required=False, valid=True   (advisory; gate skips it entirely)
# objective.evaluate_objective only consumes verification_evidence when
# ``required`` is truthy, so an accept contributes neither pass nor fail.
# ---------------------------------------------------------------------------

class GateEvidenceTests(unittest.TestCase):
    def test_accept_evidence_is_advisory_not_required(self) -> None:
        """An ACCEPT is advisory only: ``required`` is False so the gate does not
        treat the LLM's blessing as a verification signal — it cannot drive green."""
        ev = gate_evidence(Verdict(accepted=True, reason="ok"))
        self.assertFalse(ev["required"])
        self.assertTrue(ev["valid"])

    def test_reject_evidence_is_required_and_invalid(self) -> None:
        """A REJECT is a blocking veto: ``required`` True, ``valid`` False."""
        ev = gate_evidence(Verdict(accepted=False, reason="gamed"))
        self.assertTrue(ev["required"])
        self.assertFalse(ev["valid"])
        self.assertIn("gamed", ev["reason"])


# ---------------------------------------------------------------------------
# Veto-only, end-to-end through the real Objective Gate. These prove the
# contract the unit shape implies: an LLM accept cannot rescue a red, and an
# LLM reject vetoes an otherwise-green run.
# ---------------------------------------------------------------------------

class VetoOnlyGateTests(unittest.TestCase):
    def test_accept_cannot_turn_a_failing_check_green(self) -> None:
        from agentrail.guardrails.policies.objective import (
            CheckResult,
            evaluate_objective,
        )

        verdict = evaluate_objective(
            checks=[CheckResult(name="tests", passed=False, detail="3 failed")],
            verification_evidence=gate_evidence(Verdict(accepted=True, reason="lgtm")),
        )
        self.assertEqual(verdict.state, "fail")
        self.assertIn("tests", verdict.failed_reasons)

    def test_accept_does_not_by_itself_make_a_run_green(self) -> None:
        """With NO real checks, an LLM accept must not produce a pass on its own —
        the verification seam is skipped (advisory), so green can only come from
        executed evidence elsewhere, not the verifier."""
        from agentrail.guardrails.policies.objective import evaluate_objective

        verdict = evaluate_objective(
            verification_evidence=gate_evidence(Verdict(accepted=True, reason="lgtm")),
        )
        # The accept contributed NOTHING: no independent-verification evidence
        # line was recorded, and the gate's state is whatever the (absent) real
        # checks decide — never driven to a pass *by* the accept. With no checks
        # there is nothing to fail, so it stays "pass", but the accept added no
        # positive signal of its own (the seam was skipped as advisory).
        self.assertNotIn(
            "independent-verification", {e.name for e in verdict.evidence}
        )
        self.assertEqual(verdict.state, "pass")
        self.assertEqual(verdict.failed_reasons, [])

    def test_reject_vetoes_an_otherwise_green_run(self) -> None:
        from agentrail.guardrails.policies.objective import (
            CheckResult,
            evaluate_objective,
        )

        verdict = evaluate_objective(
            checks=[CheckResult(name="tests", passed=True, detail="all passed")],
            verification_evidence=gate_evidence(
                Verdict(accepted=False, reason="tautological test")
            ),
        )
        self.assertEqual(verdict.state, "fail")
        self.assertIn("independent verification rejected", verdict.failed_reasons)


if __name__ == "__main__":
    unittest.main()
