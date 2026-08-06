"""Pure independent scorecard aggregation for Acceptance Case evals."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, Literal, Optional

from .loader import ARMS

SCORECARDS = ("contract", "context", "review", "proof", "correction", "outcome")
EvidenceClass = Literal["offline", "canary", "production"]


@dataclass(frozen=True)
class AcceptanceObservation:
    case: str
    arm: str
    scorecard: str
    segment: str
    evidence_class: EvidenceClass
    # ``None`` means independently unscored, never a manufactured failure/pass.
    independent_truth: Optional[bool]
    jace_claim: Optional[bool]
    provenance: Dict[str, str]

    def __post_init__(self) -> None:
        if self.arm not in ARMS:
            raise ValueError(f"unknown Acceptance Case arm: {self.arm}")
        if self.scorecard not in SCORECARDS:
            raise ValueError(f"unknown Acceptance Case scorecard: {self.scorecard}")
        if not self.case or not self.segment:
            raise ValueError("case and segment are required")
        required = {"caseVersion", "scorerVersion"}
        if not required.issubset(self.provenance):
            raise ValueError("Acceptance Case observations require caseVersion and scorerVersion provenance")


def aggregate(observations: Iterable[AcceptanceObservation]) -> Dict[str, Dict[str, int]]:
    """Return arm-separated explicit denominators without mixing evidence classes."""
    result: Dict[str, Dict[str, int]] = {}
    for item in observations:
        # An ablation is meaningful only when every arm remains independently
        # reportable.  Omitting ``arm`` here would make a winning builder input
        # and a failing baseline average into one misleading scorecard.
        key = f"{item.arm}:{item.evidence_class}:{item.scorecard}:{item.segment}"
        bucket = result.setdefault(key, {"total": 0, "scored": 0, "unscored": 0, "claim_true": 0, "truth_true": 0, "false_green": 0, "false_block": 0})
        bucket["total"] += 1
        if item.independent_truth is None:
            bucket["unscored"] += 1
            continue
        bucket["scored"] += 1
        if item.independent_truth:
            bucket["truth_true"] += 1
        if item.jace_claim:
            bucket["claim_true"] += 1
        if item.jace_claim is True and item.independent_truth is False:
            bucket["false_green"] += 1
        if item.jace_claim is False and item.independent_truth is True:
            bucket["false_block"] += 1
    return result
