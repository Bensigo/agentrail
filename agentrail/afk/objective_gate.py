"""Re-export shim for the async (``afk``) harness's Objective Gate (issue #920).

The async harness's deterministic objective gate (CI checks + committed-secret
scan + deleted-file-still-referenced) used to live here as its own module, drifted
from a *second* copy in ``agentrail/run/objective_gate.py``. #920 consolidated BOTH
into ONE policy at :mod:`agentrail.guardrails.policies.objective` (CONTEXT.md: there
must be exactly one definition of done). This module is now a **thin re-export
shim** carrying NO decision logic of its own — every function forwards to the
unified gate so existing imports (``from agentrail.afk import objective_gate as og``;
``og.evaluate_ci`` / ``og.evaluate`` / ``og.fix_prompt`` / ``og.scan_secrets`` /
``og.deleted_files_in_use``) keep working unchanged (AC4).

The async harness's result vocabulary (``ObjectiveGateResult`` with a tri-state
``state`` and ``.passed`` / ``.reasons``) is preserved by aliasing it to the
unified :class:`ObjectiveVerdict`, which carries the same fields.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional

from agentrail.guardrails.policies.objective import (
    deleted_files_in_use,
    evaluate_objective,
    fix_prompt,
    scan_secrets,
)
from agentrail.guardrails.policies.objective import (
    evaluate_ci as _evaluate_ci,
)

__all__ = [
    "ObjectiveGateResult",
    "evaluate_ci",
    "scan_secrets",
    "deleted_files_in_use",
    "evaluate",
    "fix_prompt",
]


@dataclass(frozen=True)
class ObjectiveGateResult:
    """The async harness's verdict view — a plain result type (no decision logic).

    Preserves the pre-#920 ``(state, reasons)`` constructor shape exactly so
    callers/tests that build one positionally keep working (AC4). It is only a
    data carrier; all *decisions* are made by the unified gate, which returns an
    :class:`~agentrail.guardrails.policies.objective.ObjectiveVerdict`; this shim
    narrows that verdict to the two fields the async harness ever read.
    """

    state: str               # "pass" | "fail" | "pending"
    reasons: List[str] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return self.state == "pass"


def _narrow(verdict) -> ObjectiveGateResult:
    """Narrow a unified ObjectiveVerdict to the async harness's result shape."""
    return ObjectiveGateResult(state=verdict.state, reasons=list(verdict.failed_reasons))


def evaluate_ci(checks: List[dict]) -> Optional[ObjectiveGateResult]:
    """Evaluate CI checks (shim → unified gate).

    Returns a fail/pending verdict, or ``None`` when all checks pass. Zero checks
    is a FAIL. Forwards verbatim to the unified gate's ``evaluate_ci``.
    """
    verdict = _evaluate_ci(checks)
    return None if verdict is None else _narrow(verdict)


def evaluate(
    checks: List[dict],
    added_lines: List[str],
    deleted_files: List[str],
    references: Dict[str, List[str]],
) -> ObjectiveGateResult:
    """Top-level async gate: CI first (may be pending), then deterministic security.

    Thin pass-through to the unified gate with exactly the async harness's inputs
    (CI checks + diff data; no tests/build/lint or AC coverage). Identical
    semantics to the pre-#920 async gate: CI fail/pending short-circuits, then a
    committed-secret scan and deleted-file-still-referenced check.
    """
    return _narrow(
        evaluate_objective(
            ci_checks=checks,
            added_lines=added_lines,
            deleted_files=deleted_files,
            references=references,
        )
    )
