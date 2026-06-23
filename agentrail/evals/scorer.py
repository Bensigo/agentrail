"""The eval **scorer** — the truth-critical core of the harness (issue #936).

A task is *solved* **if and only if** its hidden tests pass. That is the only
signal in AgentRail that cannot be fooled by code that merely looks finished —
the direct countermeasure to the loop's false-green PRs, where a run passes its
own **Objective Gate** / CI but fails human review (CONTEXT.md).

This module takes a fixed ``RunRecord`` (the runner's output contract, see
``agentrail.evals.run_record``) plus the task's already-computed hidden-test
result, and returns a ``Verdict``. It is **pure** given those inputs:

- It does NOT run the agent, mount the answer key, execute the hidden tests,
  spawn a subprocess, touch the sandbox, or open a socket. The hidden-test
  pass/fail is an *input* — running the tests is the runner/sandbox's job
  (#937), kept out of here so the truth-defining logic stays trivially testable
  and impossible to taint with IO.
- Given the same ``(RunRecord, hidden_tests_passed)`` it always returns the same
  ``Verdict`` (referential transparency).

The verdict is defined SOLELY by ``hidden_tests_passed``. The run's own
``gate_passed`` decision NEVER changes whether a task is solved — it only feeds
the *false-green* probe: a run is a false-green when its gate passed but its
hidden tests failed (the gate said "done" but the ground truth says "not"). That
gap is the most operationally important number the harness produces (PRD).
"""

from __future__ import annotations

from dataclasses import dataclass

from agentrail.evals.run_record import RunRecord


@dataclass(frozen=True)
class Verdict:
    """The scored outcome of one run against its hidden tests.

    - ``task`` / ``arm`` — carried through from the run record for aggregation.
    - ``solved`` — TRUE iff the hidden tests passed. This is the ONLY definition
      of solved; it is independent of the run's own gate decision. This is the
      value that ultimately feeds ``reporter.RepetitionRecord.solved``.
    - ``gate_passed`` — the run's own **Objective Gate** decision, echoed for
      auditability (so a Verdict alone shows the gate-vs-truth comparison).
    - ``false_green`` — TRUE iff the gate passed AND the hidden tests failed:
      the run claimed done but the ground truth disagrees. A run can only be a
      false-green when it is NOT solved.
    """

    task: str
    arm: str
    solved: bool
    gate_passed: bool
    false_green: bool


def score(run: RunRecord, *, hidden_tests_passed: bool) -> Verdict:
    """Score one run against its hidden-test result.

    Args:
        run: the immutable ``RunRecord`` the runner produced. Only its
            ``gate_passed`` decision (and ``task``/``arm`` labels) is read; the
            diff, tokens, model, wall time, and retries are opaque to scoring.
        hidden_tests_passed: whether the task's hidden test suite passed when run
            against the agent's produced change. This is the sole ground truth.
            It is supplied by the caller (the runner mounts and runs the answer
            key); the scorer never runs tests itself.

    Returns:
        A ``Verdict`` whose ``solved`` is exactly ``hidden_tests_passed``,
        regardless of ``run.gate_passed``, and whose ``false_green`` is
        ``run.gate_passed and not hidden_tests_passed``.
    """
    solved = bool(hidden_tests_passed)
    # False-green: the run's Objective Gate passed but the hidden tests failed.
    # By construction this can never be True for a solved run.
    false_green = bool(run.gate_passed) and not solved
    return Verdict(
        task=run.task,
        arm=run.arm,
        solved=solved,
        gate_passed=bool(run.gate_passed),
        false_green=false_green,
    )
