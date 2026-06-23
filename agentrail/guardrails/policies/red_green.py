"""Red-Green Proof guardrail — PURE policy (no I/O).

Migrated verbatim (decision semantics unchanged) from ``agentrail/run/red_green.py``
for issue #921.  The **Red-Green Proof** (CONTEXT.md) is the required evidence that
an acceptance test was observed *failing* before implementation and *passing*
after.  It proves the test is real (not tautological) and that the change caused
the pass.

What lives here (pure)
----------------------
* :class:`Observation` — one observed outcome of an acceptance test.
* :class:`Trail` — the verdict on whether the observations form a valid trail.
* :func:`verify_trail` — the pure decision: ``Observation``s → ``Trail``.
* :func:`gate_evidence` — bridges a ``Trail`` to the ``red_green_evidence``
  mapping the Objective Gate consumes.
* :class:`RedGreenGuardrail` — the seam adapter wrapping :func:`verify_trail`
  behind the :class:`~agentrail.guardrails.base.Guardrail` protocol.

Purity (AC2)
------------
No ``subprocess``/``git``/``gh``/``pytest`` import.  Collecting the observations
(running the test before/after implementation) is thin pipeline orchestration; this
module only decides whether an observed sequence is a valid fail→pass trail.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Sequence

from agentrail.guardrails.base import Verdict
from agentrail.guardrails.registry import register


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


# ---------------------------------------------------------------------------
# Guardrail seam adapter (pure) — registered so `list_guardrails()` sees it.
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class RedGreenGuardrail:
    """Adapts :func:`verify_trail` to the :class:`Guardrail` protocol.

    Blocking guardrail: an invalid (or never-red) trail is a ``FAIL``.
    ``evaluate(observations=[...])`` runs :func:`verify_trail` and maps the
    ``Trail`` 1:1 — valid → ``PASS``, invalid → ``FAIL`` with the trail's reason.
    """

    name: str = "red_green"
    description: str = (
        "Requires a Red-Green Proof: an acceptance test must be observed failing "
        "(red) before implementation and passing (green) after — proving the test "
        "is real, not tautological."
    )
    blocking: bool = True

    def evaluate(self, **kwargs: object) -> Verdict:
        observations = kwargs.get("observations", ())
        if not isinstance(observations, Sequence):
            raise TypeError(
                "RedGreenGuardrail.evaluate requires an observations= sequence of "
                "Observation"
            )
        trail = verify_trail(tuple(observations))  # type: ignore[arg-type]
        if trail.is_valid:
            return Verdict.passing(trail.reason) if trail.reason else Verdict.passing()
        return Verdict.failing(trail.reason)


# Register the singleton instance at import time so `list_guardrails()` sees it.
RED_GREEN_GUARDRAIL = register(RedGreenGuardrail())
