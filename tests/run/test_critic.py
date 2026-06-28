"""Tests for the Critic deep module (issue #977).

The **Critic** is the cheap-model independent reviewer that replaces the
*expensive* verify model as the reviewer feeding the Objective Gate. It is
INDEPENDENT of the executor (never the maker grading its own homework) and scores
a candidate change (diff + task context) on a CHEAP model tier, returning a
structured verdict (accept/reject + score + reason).

To keep the Objective Gate's accept/reject contract UNCHANGED (AC2), the Critic
produces the SAME ``verification_evidence`` shape the verifier produces — a REJECT
is ``valid=False`` so the gate refuses GREEN exactly as a verify reject does
today. This module is the *pure* core: model selection, scoring, and the
gate-evidence bridge take plain inputs and return plain results.
"""
from __future__ import annotations

import unittest

from agentrail.run.critic import (
    CRITIC_DEFAULT_MODEL,
    CriticVerdict,
    gate_evidence,
    resolve_critic_model,
    score_candidate,
)


# ---------------------------------------------------------------------------
# AC1: the Critic uses a CHEAP, configurable model tier (default Haiku)
# ---------------------------------------------------------------------------

class ResolveCriticModelTests(unittest.TestCase):
    def test_default_is_a_cheap_haiku_model(self) -> None:
        # AC1: default is a fast cheap model (Haiku).
        self.assertEqual(resolve_critic_model(""), CRITIC_DEFAULT_MODEL)
        self.assertIn("haiku", CRITIC_DEFAULT_MODEL.lower())

    def test_configured_model_overrides_default(self) -> None:
        self.assertEqual(
            resolve_critic_model("claude-haiku-cheap-x"), "claude-haiku-cheap-x"
        )

    def test_blank_or_none_falls_back_to_default(self) -> None:
        self.assertEqual(resolve_critic_model(None), CRITIC_DEFAULT_MODEL)
        self.assertEqual(resolve_critic_model("   "), CRITIC_DEFAULT_MODEL)


# ---------------------------------------------------------------------------
# AC1: score a candidate change -> structured verdict (accept/reject + score + reason)
# ---------------------------------------------------------------------------

class ScoreCandidateTests(unittest.TestCase):
    def test_accept_yields_high_score(self) -> None:
        v = score_candidate('{"verdict": "accept", "reason": "tests cover the AC"}')
        self.assertIsInstance(v, CriticVerdict)
        self.assertTrue(v.accepted)
        self.assertEqual(v.score, 1.0)
        self.assertEqual(v.reason, "tests cover the AC")

    def test_reject_yields_low_score(self) -> None:
        v = score_candidate('{"verdict": "reject", "reason": "tautological test"}')
        self.assertFalse(v.accepted)
        self.assertEqual(v.score, 0.0)
        self.assertIn("tautological", v.reason)

    def test_unparseable_output_is_rejected_failclosed(self) -> None:
        """A critic that produces no structured verdict is a REJECT (fail-closed):
        an unscored run must never silently reach done."""
        v = score_candidate("the cheap model crashed with no verdict")
        self.assertFalse(v.accepted)
        self.assertEqual(v.score, 0.0)

    def test_empty_output_is_rejected_failclosed(self) -> None:
        v = score_candidate("")
        self.assertFalse(v.accepted)
        self.assertEqual(v.score, 0.0)

    def test_extracts_verdict_from_surrounding_prose(self) -> None:
        text = (
            "I reviewed the diff against the acceptance criteria.\n"
            'VERDICT: {"verdict": "accept", "reason": "matches AC1"}\n'
        )
        v = score_candidate(text)
        self.assertTrue(v.accepted)
        self.assertEqual(v.score, 1.0)


# ---------------------------------------------------------------------------
# AC2: the verdict reaches the gate as VETO-ONLY evidence (same shape as verify).
# The critic, like the verifier, can only veto: a REJECT blocks done, but an
# ACCEPT is advisory (``required=False``) and can never drive the gate green on
# its own. Both bridges produce the identical shape so the gate stays uniform.
# ---------------------------------------------------------------------------

class GateEvidenceTests(unittest.TestCase):
    def test_accept_evidence_is_advisory_not_required(self) -> None:
        ev = gate_evidence(score_candidate('{"verdict": "accept", "reason": "ok"}'))
        self.assertFalse(ev["required"])
        self.assertTrue(ev["valid"])

    def test_reject_evidence_is_required_and_invalid(self) -> None:
        ev = gate_evidence(score_candidate('{"verdict": "reject", "reason": "gamed"}'))
        self.assertTrue(ev["required"])
        self.assertFalse(ev["valid"])
        self.assertIn("gamed", ev["reason"])

    def test_evidence_shape_matches_verifier(self) -> None:
        """The critic's gate evidence must carry exactly the keys the Objective
        Gate consumes from the verifier, so the gate is byte-identical (AC2)."""
        from agentrail.run import verifier as verifier_mod

        for raw in (
            '{"verdict": "reject", "reason": "x"}',
            '{"verdict": "accept", "reason": "x"}',
        ):
            critic_ev = gate_evidence(score_candidate(raw))
            verify_ev = verifier_mod.gate_evidence(verifier_mod.parse_verdict(raw))
            self.assertEqual(set(critic_ev.keys()), set(verify_ev.keys()))
            self.assertEqual(critic_ev["required"], verify_ev["required"])
            self.assertEqual(critic_ev["valid"], verify_ev["valid"])


if __name__ == "__main__":
    unittest.main()
