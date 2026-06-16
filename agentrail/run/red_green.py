"""The Red-Green Proof recorder — proof a test is real, not tautological (ADR 0008).

The **Red-Green Proof** (CONTEXT.md) is the required evidence that an acceptance
test was observed *failing* before implementation and *passing* after. It proves
the test is real (not tautological) and that the change caused the pass. The
**Objective Gate** requires this evidence trail, not just a final green result.

This is a **deep, pure module** (verification-contract-architecture.md): it takes
an observed sequence of test results and decides whether they constitute a valid
fail→pass trail. It runs no tools, touches no I/O, and imports neither the
pipeline, the DB, nor the network. Collecting the observations (running the test
before/after the implementation) is thin pipeline orchestration; that keeps this
module deterministic and unit-testable in isolation.

The interface is small (a deep module): record ``Observation``s of a test result,
then ``verify_trail`` decides validity and emits the ``red_green_evidence`` mapping
the Objective Gate consumes (``{"required": ..., "valid": ...}``).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Sequence


@dataclass(frozen=True)
class Observation:
    """One observed outcome of an acceptance test at a point in the run.

    ``test`` identifies the acceptance test; ``passed`` is whether it passed when
    observed. The recorder reads the *order* of observations to prove the test was
    red (failing) before it was green (passing).
    """

    test: str
    passed: bool


@dataclass(frozen=True)
class Trail:
    """The verdict on whether the observations constitute a valid Red-Green trail.

    ``is_valid`` is the single bit the gate needs; ``reason`` is human-readable
    evidence for the run surface (e.g. "never observed failing").
    """

    is_valid: bool
    reason: str = ""


def verify_trail(observations: Sequence[Observation]) -> Trail:
    """Decide whether ``observations`` constitute a valid Red-Green Proof trail.

    A trail is valid when, for at least one acceptance test, the test was observed
    *failing* (red) and *later* observed *passing* (green) — proving the test is
    real and the implementation caused the pass. A test that was never observed
    failing is rejected as tautological (never-red).
    """
    by_test: Dict[str, List[bool]] = {}
    order: List[str] = []
    for obs in observations:
        if obs.test not in by_test:
            by_test[obs.test] = []
            order.append(obs.test)
        by_test[obs.test].append(obs.passed)

    if not order:
        return Trail(is_valid=False, reason="no acceptance test was observed")

    proven: List[str] = []
    for test in order:
        outcomes = by_test[test]
        first_fail = next((i for i, p in enumerate(outcomes) if not p), None)
        if first_fail is None:
            continue  # never observed failing → tautological / never-red
        if any(p for p in outcomes[first_fail + 1 :]):
            proven.append(test)  # observed red, then later green

    if not proven:
        return Trail(
            is_valid=False,
            reason="no acceptance test was observed failing then passing",
        )

    return Trail(
        is_valid=True,
        reason="observed failing then passing: " + ", ".join(proven),
    )


def gate_evidence(trail: Trail) -> Dict[str, Any]:
    """Bridge a ``Trail`` to the ``red_green_evidence`` the Objective Gate consumes.

    The gate (``objective_gate.evaluate``) reads a mapping with ``required`` and
    ``valid`` flags and refuses GREEN when a proof is ``required`` but not
    ``valid``. A Red-Green Proof is always *required* (ADR 0008: the gate requires
    the trail, not just a final green), so this always sets ``required=True`` and
    reports ``valid`` from the trail. ``reason`` is carried for the run surface.
    """
    return {
        "required": True,
        "valid": bool(trail.is_valid),
        "reason": trail.reason,
    }
