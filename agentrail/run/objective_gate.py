"""Re-export shim for the sync (``run``) harness's Objective Gate (issue #920).

The Objective Gate — the falsifiable definition of "done" (ADR 0007) — used to
live here as its own ~200-line module, drifted from a *second* copy in
``agentrail/afk/objective_gate.py``. #920 consolidated BOTH into ONE policy at
:mod:`agentrail.guardrails.policies.objective` (CONTEXT.md: there must be exactly
one definition of done). This module is now a **thin re-export shim** carrying NO
decision logic of its own — it forwards to the unified gate so existing imports
(``from agentrail.run.objective_gate import CheckResult, GateResult, evaluate``)
and the heartbeat presence-probe (``importlib.util.find_spec`` on this module's
dotted path) keep working unchanged (AC4).

The unified gate is tri-state (pass/fail/pending); the sync harness never supplies
CI checks, so for this harness it can only ever reach pass/fail — behaviour is
identical to the pre-#920 binary gate. ``GateResult`` is preserved as the sync
harness's binary-vocabulary view (``is_green`` / ``verdict`` / ``to_dict``).
"""
from __future__ import annotations

from typing import Any, List, Mapping, Optional, Sequence

from agentrail.guardrails.policies.objective import (
    REQUIRED_CHECKS,
    AcCoverage,
    CheckResult,
    Evidence,
    ObjectiveVerdict,
    evaluate_objective,
)

__all__ = [
    "REQUIRED_CHECKS",
    "AcCoverage",
    "CheckResult",
    "Evidence",
    "GateResult",
    "evaluate",
]

# Backward-compatible alias: the sync harness called the verdict ``GateResult``.
# The unified verdict already exposes ``is_green`` / ``verdict`` / ``to_dict`` and
# a binary state for this harness, so the legacy name is just an alias — no
# duplicated decision logic, no second result shape (AC4).
GateResult = ObjectiveVerdict


def evaluate(
    *,
    checks: Sequence[CheckResult],
    ac_coverage: AcCoverage,
    red_green_evidence: Optional[Mapping[str, Any]] = None,
    verification_evidence: Optional[Mapping[str, Any]] = None,
) -> GateResult:
    """Evaluate the Objective Gate for the sync (``run``) harness.

    Thin pass-through to :func:`agentrail.guardrails.policies.objective.evaluate_objective`
    with exactly the sync harness's inputs (no CI checks, so the verdict is
    binary pass/fail). Returns the unified :class:`ObjectiveVerdict`, aliased here
    as ``GateResult``; ``is_green`` is the single done signal and ``failed_reasons``
    names each failure — identical semantics to the pre-#920 gate.
    """
    return evaluate_objective(
        checks=checks,
        ac_coverage=ac_coverage,
        red_green_evidence=red_green_evidence,
        verification_evidence=verification_evidence,
    )
