"""Context-evidence review gate evaluator.

Pure function, no I/O — fully unit-testable.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


GATE_NAME = "context-evidence"

REQUIRED_FIELDS = ("contextPackFile", "selectedSources", "retrievalBudget", "citations")


@dataclass
class GateResult:
    gate_name: str
    status: str  # "passed" | "failed"
    blocking_reasons: list[str] = field(default_factory=list)
    conditions: list[dict[str, Any]] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return self.status == "passed"


def evaluate_context_evidence(evidence: dict[str, Any], enforce: bool = False) -> GateResult:
    """Evaluate whether a run carries the four required context-evidence fields.

    Args:
        evidence: Mapping of evidence fields from a run record.  Expected keys:
            ``contextPackFile``, ``selectedSources``, ``retrievalBudget``, ``citations``.
        enforce: When *True*, a failed gate signals a hard failure (callers may
            translate this to HTTP 422 or a blocking status).  When *False* the gate
            result is a warning; the run is not blocked.

    Returns:
        :class:`GateResult` with ``status="passed"`` when all fields are present
        and non-empty, or ``status="failed"`` with per-field ``blocking_reasons``
        when any are missing.
    """
    blocking_reasons: list[str] = []

    context_pack_file = evidence.get("contextPackFile")
    if not context_pack_file:
        blocking_reasons.append("missing contextPackFile")

    selected_sources = evidence.get("selectedSources")
    if not selected_sources:
        blocking_reasons.append("missing selectedSources")

    retrieval_budget = evidence.get("retrievalBudget")
    if not retrieval_budget:
        blocking_reasons.append("missing retrievalBudget")

    citations = evidence.get("citations")
    if not citations:
        blocking_reasons.append("missing citations")

    status = "passed" if not blocking_reasons else "failed"
    conditions: list[dict[str, Any]] = [{"enforce": enforce, "gateName": GATE_NAME}]

    return GateResult(
        gate_name=GATE_NAME,
        status=status,
        blocking_reasons=blocking_reasons,
        conditions=conditions,
    )
