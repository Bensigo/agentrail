"""Tests for agentrail/run/compaction.py — the Compaction / Failure-Handoff builder.

The Compaction / Failure-Handoff builder (CONTEXT.md, ADR 0011) is what an
escalation carries: when the cheap model fails the **Objective Gate**, the
failing attempt — which already has the context warm — produces a *compacted
failure handoff* for the stronger model. The handoff PRESERVES failure-relevant
context (the goal, the cheap attempt's diff, and the exact gate error) and DROPS
redundant exploration (verbose logs, unrelated reads) so the strong model debugs
a concrete failure rather than re-deriving it from a blank slate.

These are behavior-only unit tests over plain inputs — the builder is pure, so it
takes the goal/diff/gate-error and returns a compacted handoff. Running the
failing attempt and collecting its raw context is the caller's job (thin
orchestration).
"""
from __future__ import annotations

import pytest

from agentrail.run.compaction import FailureHandoff, build


# A small, realistic gate error built from the Objective Gate's failed_reasons.
GOAL = "Add a --json flag to `agentrail status` that prints machine-readable output."
DIFF = (
    "diff --git a/agentrail/cli/commands/status.py b/agentrail/cli/commands/status.py\n"
    "@@ -10,6 +10,9 @@\n"
    "+    if opts.json:\n"
    "+        print(json.dumps(payload))\n"
    "+        return 0\n"
)
GATE_ERROR = "tests; acceptance-criteria not satisfied"


# ---------------------------------------------------------------------------
# AC2 — the handoff carries goal + attempt diff + exact gate error
# ---------------------------------------------------------------------------

def test_handoff_preserves_goal() -> None:
    handoff = build(goal=GOAL, attempt_diff=DIFF, gate_error=GATE_ERROR)
    assert handoff.goal == GOAL
    assert GOAL in handoff.text


def test_handoff_preserves_attempt_diff() -> None:
    handoff = build(goal=GOAL, attempt_diff=DIFF, gate_error=GATE_ERROR)
    assert handoff.attempt_diff == DIFF
    # The concrete failing change must survive into the rendered handoff.
    assert "if opts.json:" in handoff.text


def test_handoff_preserves_exact_gate_error() -> None:
    handoff = build(goal=GOAL, attempt_diff=DIFF, gate_error=GATE_ERROR)
    assert handoff.gate_error == GATE_ERROR
    # The EXACT gate error — verbatim, not paraphrased — must be present so the
    # strong model debugs the real failure (ADR 0011: preserve the error).
    assert GATE_ERROR in handoff.text


def test_handoff_accepts_gate_error_as_failed_reasons_list() -> None:
    """The gate error may be supplied as the Objective Gate's failed_reasons list;
    each reason must be preserved verbatim."""
    reasons = ["tests", "acceptance-criteria not satisfied"]
    handoff = build(goal=GOAL, attempt_diff=DIFF, gate_error=reasons)
    for reason in reasons:
        assert reason in handoff.text
        assert reason in handoff.gate_error


# ---------------------------------------------------------------------------
# AC3 — preserve failure-relevant context, DROP redundant exploration
# ---------------------------------------------------------------------------

def test_handoff_drops_redundant_exploration_logs() -> None:
    """Verbose exploration (file reads, search output, tool chatter) is dropped —
    it is the cheap attempt's re-derivation, not failure-relevant context."""
    noisy_exploration = (
        "Reading agentrail/cli/commands/status.py...\n"
        "Searching for 'json' across 412 files...\n"
        "Reading docs/...\n" * 50
        + "Listing directory .agentrail/...\n"
    )
    handoff = build(
        goal=GOAL,
        attempt_diff=DIFF,
        gate_error=GATE_ERROR,
        exploration=noisy_exploration,
    )
    # The redundant exploration must NOT be carried into the handoff.
    assert "Searching for 'json' across 412 files" not in handoff.text
    assert "Listing directory" not in handoff.text
    # But the failure-relevant context survives.
    assert GOAL in handoff.text
    assert "if opts.json:" in handoff.text
    assert GATE_ERROR in handoff.text


def test_handoff_is_smaller_than_raw_attempt() -> None:
    """Compaction is lossy by design: the handoff is substantially smaller than
    the raw attempt (diff + the verbose exploration that produced it)."""
    noisy_exploration = "Reading some unrelated file...\n" * 200
    raw_size = len(GOAL) + len(DIFF) + len(GATE_ERROR) + len(noisy_exploration)
    handoff = build(
        goal=GOAL,
        attempt_diff=DIFF,
        gate_error=GATE_ERROR,
        exploration=noisy_exploration,
    )
    assert len(handoff.text) < raw_size


def test_handoff_with_no_exploration_still_builds() -> None:
    """Exploration is optional — a handoff with only the three required parts is
    valid and still preserves all three."""
    handoff = build(goal=GOAL, attempt_diff=DIFF, gate_error=GATE_ERROR)
    assert GOAL in handoff.text
    assert "if opts.json:" in handoff.text
    assert GATE_ERROR in handoff.text


# ---------------------------------------------------------------------------
# Structure / serialisation — the handoff is a plain, inspectable value.
# ---------------------------------------------------------------------------

def test_handoff_text_is_nonempty_and_ordered_goal_diff_error() -> None:
    handoff = build(goal=GOAL, attempt_diff=DIFF, gate_error=GATE_ERROR)
    text = handoff.text
    # Goal first, then the attempt diff, then the gate error — the order a
    # debugger reads: what we wanted, what we tried, why it failed.
    assert text.index(GOAL) < text.index("if opts.json:") < text.index(GATE_ERROR)


def test_handoff_to_dict_round_trips_required_fields() -> None:
    handoff = build(goal=GOAL, attempt_diff=DIFF, gate_error=GATE_ERROR)
    d = handoff.to_dict()
    assert d["goal"] == GOAL
    assert d["attemptDiff"] == DIFF
    assert d["gateError"] == GATE_ERROR
    assert d["text"] == handoff.text


# ---------------------------------------------------------------------------
# Input validation — a handoff with no failure-relevant content is useless and
# would hand the strong model the same blindness that failed the cheap one.
# ---------------------------------------------------------------------------

def test_empty_goal_is_rejected() -> None:
    with pytest.raises(ValueError):
        build(goal="", attempt_diff=DIFF, gate_error=GATE_ERROR)


def test_empty_gate_error_is_rejected() -> None:
    with pytest.raises(ValueError):
        build(goal=GOAL, attempt_diff=DIFF, gate_error="")


def test_empty_failed_reasons_list_is_rejected() -> None:
    with pytest.raises(ValueError):
        build(goal=GOAL, attempt_diff=DIFF, gate_error=[])


def test_returns_failure_handoff_type() -> None:
    handoff = build(goal=GOAL, attempt_diff=DIFF, gate_error=GATE_ERROR)
    assert isinstance(handoff, FailureHandoff)
