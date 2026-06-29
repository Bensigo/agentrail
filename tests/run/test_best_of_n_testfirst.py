"""Best-of-N with TEST-PRIMARY selection + cheap-critic tiebreak (Finding 3).

The merged #979 best-of-N selects the winning candidate by the CRITIC alone — the
research-forbidden mode that provably degrades as N grows (an LLM critic that only
reads code waves through ~50% of wrong code; generation drifts toward fooling the
critic). Finding 3 is the SAFE version: make the executable hidden test the
PRIMARY selector with early-stop on first pass, and demote the cheap critic (#977)
to a SECONDARY tie-breaker only. It ships behind a NEW flag,
``AGENTRAIL_EVAL_LAYER_BESTOFN_TESTFIRST``, DEFAULT OFF — merging it does NOT
change the live loop.

Two layers of tests:

  * Pure policy (``agentrail.run.best_of_n``): the total order is test-PRIMARY,
    critic-SECONDARY, so a critic-preferred-but-test-FAILING candidate is NEVER
    selected over a test-passing one; budget guard and stop-reason behave.
  * Pipeline integration with FAITHFUL fakes (no real agents/subprocess): the
    test-first loop early-stops on the FIRST candidate whose declared check passes,
    keeps generating while the test fails, never exceeds N, halts on the budget
    cap, and — flag OFF — reproduces the existing single-attempt / #979 behavior.

All external I/O is patched at the ``agentrail.run.pipeline.*`` import names,
mirroring ``tests/run/test_best_of_n_pipeline.py``.
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from agentrail.run import best_of_n as bestofn
from agentrail.run.best_of_n import (
    Candidate,
    candidate_passes,
    candidate_sort_key,
    select_best,
    stop_reason,
    would_exceed_budget,
)
from agentrail.run.critic import CriticVerdict
from agentrail.run.objective_gate import CheckResult
from agentrail.run.pipeline import run_issue


# --------------------------------------------------------------------------- #
# Layer 1: the pure selection policy (agentrail.run.best_of_n)
# --------------------------------------------------------------------------- #
def _accept(score: float = 1.0) -> CriticVerdict:
    return CriticVerdict(accepted=True, score=score, reason="accept")


def _reject(score: float = 0.0) -> CriticVerdict:
    return CriticVerdict(accepted=False, score=score, reason="reject")


class BestOfNPolicyTests(unittest.TestCase):
    def test_test_passing_candidate_beats_critic_preferred_failing_one(self):
        # Candidate 1: TEST FAILS but the critic LOVES it (score 1.0, accepted).
        # Candidate 2: TEST PASSES but the critic is lukewarm (score 0.1).
        # The test is PRIMARY → candidate 2 must win. This is the core guarantee:
        # the critic can never lift a test-failing candidate over a passing one.
        critic_loved_but_failing = Candidate(
            attempt=1, test_passed=False, critic=_accept(1.0)
        )
        test_passing_but_meh = Candidate(
            attempt=2, test_passed=True, critic=_reject(0.1)
        )
        winner = select_best([critic_loved_but_failing, test_passing_but_meh])
        self.assertEqual(winner, test_passing_but_meh)
        self.assertTrue(winner.test_passed)

    def test_critic_breaks_ties_only_among_test_passing(self):
        # Two candidates BOTH pass the test → the critic's score breaks the tie.
        lower = Candidate(attempt=1, test_passed=True, critic=_accept(0.4))
        higher = Candidate(attempt=2, test_passed=True, critic=_accept(0.9))
        self.assertEqual(select_best([lower, higher]), higher)

    def test_critic_picks_least_bad_when_none_pass(self):
        # No candidate passed the test (budget forced a stop) → among the failing
        # candidates the higher critic score is the least-bad pick.
        worse = Candidate(attempt=1, test_passed=False, critic=_reject(0.1))
        better = Candidate(attempt=2, test_passed=False, critic=_reject(0.6))
        self.assertEqual(select_best([worse, better]), better)

    def test_earliest_attempt_breaks_a_remaining_tie(self):
        # Same test status AND same critic score → the earliest attempt wins
        # (deterministic, stable selection).
        first = Candidate(attempt=1, test_passed=True, critic=_accept(0.5))
        second = Candidate(attempt=2, test_passed=True, critic=_accept(0.5))
        self.assertEqual(select_best([first, second]), first)

    def test_missing_critic_is_lowest_tiebreak_not_a_crash(self):
        # A candidate with no critic verdict still ranks (score 0.0), and only ever
        # LOSES a tie on absent evidence — never wins one.
        no_critic = Candidate(attempt=1, test_passed=True, critic=None)
        with_critic = Candidate(attempt=2, test_passed=True, critic=_accept(0.3))
        self.assertEqual(no_critic.critic_score, 0.0)
        self.assertEqual(select_best([no_critic, with_critic]), with_critic)

    def test_sort_key_orders_test_primary_then_critic(self):
        passing_low = candidate_sort_key(Candidate(1, True, _reject(0.0)))
        failing_high = candidate_sort_key(Candidate(2, False, _accept(1.0)))
        # The test-passing key outranks the test-failing key regardless of critic.
        self.assertGreater(passing_low, failing_high)

    def test_select_best_empty_is_none(self):
        self.assertIsNone(select_best([]))

    def test_candidate_passes_is_the_test_signal(self):
        self.assertTrue(candidate_passes(Candidate(1, True, _reject())))
        self.assertFalse(candidate_passes(Candidate(1, False, _accept())))

    def test_budget_guard(self):
        # No cap (<= 0) never blocks.
        self.assertFalse(would_exceed_budget(99.0, 0.0))
        # Under the cap → keep going.
        self.assertFalse(would_exceed_budget(1.0, 5.0))
        # At/over the cap → stop.
        self.assertTrue(would_exceed_budget(5.0, 5.0))
        self.assertTrue(would_exceed_budget(6.0, 5.0))
        # The next-attempt estimate would push it over → stop pre-emptively.
        self.assertTrue(would_exceed_budget(4.0, 5.0, next_attempt_estimate_usd=2.0))

    def test_stop_reason_precedence(self):
        passed = Candidate(2, True, _accept())
        self.assertIn("budget", stop_reason(passed, 2, 3, budget_hit=True))
        self.assertIn("early", stop_reason(passed, 2, 3))
        failed = Candidate(3, False, _reject())
        self.assertIn("exhausted", stop_reason(failed, 3, 3))


# --------------------------------------------------------------------------- #
# Layer 2: the pipeline test-first loop with faithful fakes
# --------------------------------------------------------------------------- #
TESTFIRST_FLAG = f"AGENTRAIL_EVAL_LAYER_{bestofn.TESTFIRST_LAYER}"


def _make_target(tmp_dir: str) -> Path:
    target = Path(tmp_dir) / "target"
    agentrail_dir = target / ".agentrail"
    agentrail_dir.mkdir(parents=True, exist_ok=True)
    (agentrail_dir / "state.json").write_text(json.dumps({"workflow": {}}))
    # A declared verify check so the Objective Gate / per-candidate checks have
    # something real to run. (The integration tests patch run_objective_checks to
    # model per-candidate pass/fail, so the command text itself is not executed.)
    (agentrail_dir / "config.json").write_text(
        json.dumps({"verify": "true"})
    )
    return target


def _clean_env(**overrides):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("AGENTRAIL_EVAL_LAYER_")
           and k != "AGENTRAIL_BESTOFN_N"}
    env.update(overrides)
    return patch.dict(os.environ, env, clear=True)


class _Harness:
    """Drives run_issue with faithful fakes and per-candidate test outcomes.

    ``test_results`` is a list of booleans indexed by execute attempt (1-based):
    whether the executable hidden test PASSES for that candidate. ``critic_scores``
    is the critic score per critic attempt. The fakes model exactly the two
    independent signals the loop consumes — the executable check and the critic —
    with no real agent or subprocess.
    """

    def __init__(self, test_results, critic_scores):
        self.test_results = test_results
        self.critic_scores = critic_scores
        self.execute_attempts = []
        self.critic_attempts = []
        self.phases = []
        self._check_calls = 0

    def _phase(self, rc, phase, attempt, verifier_findings_file="", plan_output=""):
        self.phases.append(phase)
        if phase == "execute":
            self.execute_attempts.append(attempt)
        if phase == "critic":
            self.critic_attempts.append(attempt)
            score = self.critic_scores[min(attempt, len(self.critic_scores)) - 1]
            accepted = score >= 0.5
            vdir = rc.run_dir / (phase if attempt <= 1 else f"{phase}-{attempt}")
            vdir.mkdir(parents=True, exist_ok=True)
            verdict = "accept" if accepted else "reject"
            (vdir / "output.md").write_text(
                f'VERDICT: {{"verdict":"{verdict}","score":{score},"reason":"r{attempt}"}}'
            )
        return (0, "")

    def _objective_checks(self, target_dir, **kwargs):
        # Maps to the CURRENT execute attempt: the Nth call to run_objective_checks
        # inside the loop corresponds to the Nth candidate's per-candidate test.
        # The pipeline also runs the RED baseline and final gate checks; those use
        # the same fake but their pass/fail is not asserted here.
        idx = len(self.execute_attempts)
        passed = bool(self.test_results[min(idx, len(self.test_results)) - 1]) if idx else False
        return [CheckResult(name="verify", passed=passed, detail="")]

    def run(self, target, repo, env):
        gh_mock = MagicMock()
        gh_mock.returncode = 1
        gh_mock.stdout = ""
        with _clean_env(**env), \
             patch("agentrail.run.pipeline.ctx.issue_resolution_text", return_value="T"), \
             patch("agentrail.run.pipeline.skills.resolve_skills",
                   return_value={"resolved": [], "autoSkills": True}), \
             patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value="pack.json"), \
             patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="SUMMARY"), \
             patch("agentrail.run.pipeline.ctx.context_selected_snippets", return_value="SNIPPETS"), \
             patch("agentrail.run.pipeline.ctx.context_retrieval_metadata", return_value={}), \
             patch("agentrail.run.pipeline.state_mod.render_state_summary", return_value=""), \
             patch("agentrail.run.pipeline.prompts.common_header", return_value=""), \
             patch("agentrail.run.pipeline.prompts.format_skill_resolution", return_value=""), \
             patch("agentrail.run.pipeline.prompts.issue_base_prompt", return_value="BP"), \
             patch("agentrail.run.pipeline.run_issue_phase", side_effect=self._phase), \
             patch("agentrail.run.pipeline.run_objective_checks", side_effect=self._objective_checks), \
             patch("agentrail.run.pipeline.state_mod.update_run_state"), \
             patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
             patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
            result = run_issue(target, 7, agent="claude", command="c", repo_dir=repo,
                               phase_commands={"critic": "claude --model cheap"})
        return result


class BestOfNTestFirstPipelineTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def _on(self, n=None):
        env = {TESTFIRST_FLAG: "1",
               "AGENTRAIL_EVAL_LAYER_BESTOFN": "1",
               "AGENTRAIL_EVAL_LAYER_CRITIC": "1"}
        if n is not None:
            env["AGENTRAIL_BESTOFN_N"] = str(n)
        return env

    def test_early_stop_on_first_test_pass(self):
        # Candidate 1's executable test PASSES → loop stops after ONE candidate,
        # even though the critic REJECTS it (score 0.0). Test is PRIMARY, not critic.
        h = _Harness(test_results=[True, True, True], critic_scores=[0.0, 0.0, 0.0])
        result = h.run(self.target, self.repo, self._on(n=3))
        self.assertEqual(h.execute_attempts, [1])
        self.assertEqual(h.critic_attempts, [1])
        self.assertEqual(result, 0)

    def test_keeps_going_while_test_fails_then_stops_on_pass(self):
        # fail, fail, pass → three candidates; the third (test pass) stops the loop.
        h = _Harness(test_results=[False, False, True], critic_scores=[1.0, 1.0, 0.2])
        result = h.run(self.target, self.repo, self._on(n=3))
        self.assertEqual(h.execute_attempts, [1, 2, 3])
        self.assertEqual(result, 0)

    def test_critic_accept_does_not_early_stop_when_test_fails(self):
        # The critic ACCEPTS candidate 1 (score 1.0) but its TEST FAILS. A
        # critic-only selector would stop here and ship wrong code; the test-first
        # loop must KEEP GOING. Candidate 2's test passes and is selected.
        h = _Harness(test_results=[False, True, True], critic_scores=[1.0, 0.1, 0.1])
        result = h.run(self.target, self.repo, self._on(n=3))
        self.assertEqual(h.execute_attempts, [1, 2])
        self.assertEqual(result, 0)

    def test_never_exceeds_n(self):
        # Every candidate's test FAILS → exactly N candidates, never more.
        h = _Harness(test_results=[False, False], critic_scores=[0.0, 0.0])
        result = h.run(self.target, self.repo, self._on(n=2))
        self.assertEqual(h.execute_attempts, [1, 2])
        self.assertLessEqual(len(h.execute_attempts), 2)
        # No candidate passed → the gate refuses GREEN.
        self.assertNotEqual(result, 0)

    def test_n_one_reproduces_single_attempt(self):
        # N=1 → exactly one execute, like today's single-shot behavior.
        h = _Harness(test_results=[True], critic_scores=[1.0])
        result = h.run(self.target, self.repo, self._on(n=1))
        self.assertEqual(h.execute_attempts, [1])
        self.assertEqual(result, 0)

    def test_flag_off_uses_legacy_critic_selector(self):
        # Flag explicitly OFF (TESTFIRST_FLAG=0) + BESTOFN on: the merged #979
        # critic-only loop runs instead — it early-stops on the critic's ACCEPT
        # (candidate 1), NOT on the test. This proves the seam can be disabled.
        h = _Harness(test_results=[False, False, False], critic_scores=[1.0, 1.0, 1.0])
        env = {TESTFIRST_FLAG: "0",
               "AGENTRAIL_EVAL_LAYER_BESTOFN": "1",
               "AGENTRAIL_EVAL_LAYER_CRITIC": "1"}
        result = h.run(self.target, self.repo, env)
        # Legacy loop stops on the critic's first ACCEPT → one candidate.
        self.assertEqual(h.execute_attempts, [1])

    def test_flag_off_default_single_execute(self):
        # No best-of-N layer at all → a single execute, the existing critic gate.
        h = _Harness(test_results=[True], critic_scores=[1.0])
        result = h.run(self.target, self.repo, {})
        self.assertEqual(h.execute_attempts, [1])
        self.assertEqual(result, 0)


class BestOfNTestFirstBudgetTests(unittest.TestCase):
    """The per-issue budget cap halts extra candidates (test-first loop)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def test_budget_cap_halts_after_first_candidate(self):
        # Drive run_issue with a budget cap that is already met after the first
        # candidate, so the loop must NOT spawn a second candidate even though the
        # first one's test FAILED. We model spend by having the fake phase bump
        # rc.cumulative_cost_usd to the cap during the first execute.
        cap = 1.0
        execute_attempts = []
        critic_attempts = []

        def _phase(rc, phase, attempt, verifier_findings_file="", plan_output=""):
            if phase == "execute":
                execute_attempts.append(attempt)
                # First candidate's spend reaches the cap.
                rc.cumulative_cost_usd = cap
            if phase == "critic":
                critic_attempts.append(attempt)
                vdir = rc.run_dir / (phase if attempt <= 1 else f"{phase}-{attempt}")
                vdir.mkdir(parents=True, exist_ok=True)
                (vdir / "output.md").write_text(
                    'VERDICT: {"verdict":"reject","score":0.0,"reason":"r"}'
                )
            return (0, "")

        def _checks(target_dir, **kwargs):
            # Every candidate's test FAILS, so only the budget can stop the loop.
            return [CheckResult(name="verify", passed=False, detail="")]

        gh_mock = MagicMock()
        gh_mock.returncode = 1
        gh_mock.stdout = ""
        env = {TESTFIRST_FLAG: "1",
               "AGENTRAIL_EVAL_LAYER_BESTOFN": "1",
               "AGENTRAIL_EVAL_LAYER_CRITIC": "1",
               "AGENTRAIL_BESTOFN_N": "3"}
        with _clean_env(**env), \
             patch("agentrail.run.pipeline.ctx.issue_resolution_text", return_value="T"), \
             patch("agentrail.run.pipeline.skills.resolve_skills",
                   return_value={"resolved": [], "autoSkills": True}), \
             patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value="pack.json"), \
             patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="SUMMARY"), \
             patch("agentrail.run.pipeline.ctx.context_selected_snippets", return_value="SNIPPETS"), \
             patch("agentrail.run.pipeline.ctx.context_retrieval_metadata", return_value={}), \
             patch("agentrail.run.pipeline.state_mod.render_state_summary", return_value=""), \
             patch("agentrail.run.pipeline.prompts.common_header", return_value=""), \
             patch("agentrail.run.pipeline.prompts.format_skill_resolution", return_value=""), \
             patch("agentrail.run.pipeline.prompts.issue_base_prompt", return_value="BP"), \
             patch("agentrail.run.pipeline.run_issue_phase", side_effect=_phase), \
             patch("agentrail.run.pipeline.run_objective_checks", side_effect=_checks), \
             patch("agentrail.run.pipeline.state_mod.update_run_state"), \
             patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
             patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
            run_issue(self.target, 7, agent="claude", command="c", repo_dir=self.repo,
                      phase_commands={"critic": "claude --model cheap"}, budget_usd=cap)

        # The budget cap halted the loop after the first candidate (N would be 3).
        self.assertEqual(execute_attempts, [1])


if __name__ == "__main__":
    unittest.main()
