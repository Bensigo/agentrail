"""Compaction / Failure-Handoff builder — the compacted escalation payload (ADR 0011, M036).

CONTEXT.md, **Budget Leash** / escalate-on-failure: when the cheap model fails the
**Objective Gate**, escalation re-enqueues the issue at a higher *tier* carrying a
*compacted failure handoff*. This module builds that handoff. The failing cheap
attempt — which already has the context warm — produces it cheaply, so the
stronger model debugs a concrete failure instead of solving from a blank slate.

This is a **deep, pure module** (verification-contract-architecture.md): pure
logic, no I/O, deterministic, unit-tested in isolation. It does NOT read the diff
off disk, call an agent, or mutate a queue entry — those are the caller's job
(thin orchestration). The single public entry point is :func:`build`.

What the handoff PRESERVES (failure-relevant context, AC2/AC3):

- the **goal** — what the issue asked for;
- the cheap attempt's **diff** — what was actually tried;
- the **exact gate error** — the Objective Gate's ``failed_reasons``, verbatim.

What it DROPS (redundant exploration, AC3): the verbose re-derivation the cheap
attempt produced to *reach* that diff — file reads, search output, tool chatter.
That exploration is what the cheap model already did; re-sending it would inflate
the cold-cache escalation prompt without adding failure-relevant signal.

ADR 0011 warns compaction is lossy: it MUST preserve the error, the failing
change, and the goal, or the strong model inherits the same blindness that failed
the cheap one. So :func:`build` requires a non-empty goal and gate error and never
drops any of the three required parts — only the optional exploration is dropped.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Sequence, Union

# The gate error may arrive either pre-rendered as a single string or as the
# Objective Gate's ``failed_reasons`` list (see objective_gate.GateResult).
GateError = Union[str, Sequence[str]]


@dataclass(frozen=True)
class FailureHandoff:
    """A compacted failure handoff carried across an escalation (AC2).

    Holds the three failure-relevant parts plus the rendered ``text`` the strong
    model receives. ``text`` is ordered goal → attempt diff → gate error: what we
    wanted, what we tried, why it failed. The redundant exploration that produced
    the diff is intentionally absent (AC3).
    """

    goal: str
    attempt_diff: str
    gate_error: str
    text: str

    def to_dict(self) -> Dict[str, Any]:
        """Plain, JSON-serializable dict for persisting to the run surface."""
        return {
            "goal": self.goal,
            "attemptDiff": self.attempt_diff,
            "gateError": self.gate_error,
            "text": self.text,
        }


def _render_gate_error(gate_error: GateError) -> str:
    """Normalise the gate error to a single verbatim string.

    Accepts either a pre-rendered string or the Objective Gate's
    ``failed_reasons`` sequence; joins a sequence with ``; `` preserving each
    reason verbatim. Raises when there is no failure reason at all — a handoff
    with no gate error would hand the strong model the same blindness.
    """
    if isinstance(gate_error, str):
        rendered = gate_error.strip()
    else:
        reasons = [str(r).strip() for r in gate_error if str(r).strip()]
        rendered = "; ".join(reasons)
    if not rendered:
        raise ValueError(
            "gate_error must be non-empty: the handoff must preserve the exact "
            "Objective Gate failure (ADR 0011) or the strong model inherits the "
            "cheap model's blindness"
        )
    return rendered


def build(
    *,
    goal: str,
    attempt_diff: str,
    gate_error: GateError,
    exploration: str = "",
) -> FailureHandoff:
    """Build a compacted failure handoff for an escalation. Pure; no I/O.

    Args:
        goal: What the issue asked for (must be non-empty).
        attempt_diff: The cheap attempt's diff — the concrete change that was
            tried. May be empty (e.g. the attempt produced no diff before failing),
            in which case the handoff records that no diff was produced.
        gate_error: The exact Objective Gate failure — either a pre-rendered
            string or the gate's ``failed_reasons`` list. Must contain at least
            one non-empty reason.
        exploration: The cheap attempt's verbose exploration (file reads, search
            output, tool chatter). DROPPED — it is redundant re-derivation, not
            failure-relevant context (AC3). Accepted only so the caller can hand
            the raw attempt straight in without pre-filtering.

    Returns:
        A :class:`FailureHandoff` preserving the goal, the attempt diff, and the
        exact gate error, with the redundant ``exploration`` dropped (AC3). The
        rendered ``text`` is always smaller than the raw attempt would have been.

    Raises:
        ValueError: if ``goal`` is empty or ``gate_error`` has no reason — either
            would defeat the purpose of the handoff.
    """
    goal_clean = (goal or "").strip()
    if not goal_clean:
        raise ValueError("goal must be non-empty: the handoff must preserve what the issue asked for")

    rendered_error = _render_gate_error(gate_error)
    # Preserve the attempt diff VERBATIM (AC2) — only inspect a trimmed copy to
    # decide whether there was a diff at all; the stored/rendered diff is unaltered.
    diff = attempt_diff or ""
    diff_block = diff if diff.strip() else "(the cheap attempt produced no diff before failing)"

    # ``exploration`` is deliberately not referenced past validation — it is the
    # redundant re-derivation we drop (AC3). Keeping the parameter lets the caller
    # pass the raw attempt without pre-filtering.

    sections: List[str] = [
        "## Escalation: cheap-model attempt failed the Objective Gate",
        "",
        "### Goal",
        goal_clean,
        "",
        "### Cheap attempt diff",
        diff_block,
        "",
        "### Exact gate error",
        rendered_error,
    ]
    text = "\n".join(sections)

    return FailureHandoff(
        goal=goal_clean,
        attempt_diff=diff,
        gate_error=rendered_error,
        text=text,
    )
