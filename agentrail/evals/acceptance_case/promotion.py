"""Held-out, independent promotion rules for Acceptance Case evaluation.

Promotion is intentionally a separate pure decision from score aggregation.
It accepts only independently scored offline observations, keeps case splits
external and frozen, and returns ``promote``, ``hold``, or ``reject`` with the
denominators that justify the decision. Production and canary observations
remain visible evidence classes, never substitute ground truth here.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, Mapping, Tuple

from .loader import ARMS
from .scorecards import AcceptanceObservation, SCORECARDS


def _validate_policy_shape(
    floors: Mapping[Tuple[str, str], "MetricFloor"],
    required_arms: Tuple[str, ...],
) -> None:
    if not floors:
        raise ValueError("promotion requires explicit scorecard/segment floors")
    unknown = [key for key in floors if key[0] not in SCORECARDS or not key[1]]
    if unknown:
        raise ValueError("promotion floors must name a known scorecard and non-empty segment")
    if required_arms != ARMS:
        raise ValueError("promotion requires all four canonical Acceptance Case arms")
    missing_artifact_floors = sorted(
        (scorecard, f"{segment}-artifact-validity")
        for scorecard, segment in floors
        if scorecard == "proof"
        and not segment.endswith("-artifact-validity")
        and (scorecard, f"{segment}-artifact-validity") not in floors
    )
    if missing_artifact_floors:
        missing = ", ".join(f"{scorecard}:{segment}" for scorecard, segment in missing_artifact_floors)
        raise ValueError(
            "proof promotion floors require paired artifact-validity floors: " + missing
        )


@dataclass(frozen=True)
class MetricFloor:
    """Explicit safety and quality thresholds for one scorecard/segment."""

    min_scored: int
    min_correct_rate: float
    max_false_green_rate: float
    max_false_block_rate: float

    def __post_init__(self) -> None:
        if self.min_scored <= 0:
            raise ValueError("metric floors require a positive min_scored")
        for name in ("min_correct_rate", "max_false_green_rate", "max_false_block_rate"):
            value = getattr(self, name)
            if not 0 <= value <= 1:
                raise ValueError(f"{name} must be between 0 and 1")


@dataclass(frozen=True)
class PromotionPolicy:
    """No default thresholds: a caller must explicitly declare every floor."""

    floors: Mapping[Tuple[str, str], MetricFloor]
    required_arms: Tuple[str, ...] = ARMS

    def __post_init__(self) -> None:
        _validate_policy_shape(self.floors, self.required_arms)


@dataclass(frozen=True)
class PromotionResult:
    status: str  # promote | hold | reject
    reasons: Tuple[str, ...]
    metrics: Mapping[str, Mapping[str, float | int]]


def _metrics(observations: Iterable[AcceptanceObservation]) -> Dict[str, int]:
    total = scored = correct = false_green = false_block = 0
    for item in observations:
        total += 1
        if item.independent_truth is None:
            continue
        scored += 1
        if item.jace_claim == item.independent_truth:
            correct += 1
        if item.jace_claim is True and item.independent_truth is False:
            false_green += 1
        if item.jace_claim is False and item.independent_truth is True:
            false_block += 1
    return {
        "total": total,
        "scored": scored,
        "unscored": total - scored,
        "correct": correct,
        "false_green": false_green,
        "false_block": false_block,
    }


def evaluate_promotion(
    observations: Iterable[AcceptanceObservation],
    *,
    case_splits: Mapping[str, str],
    policy: PromotionPolicy,
) -> PromotionResult:
    """Evaluate held-out offline observations without mixing evidence classes."""
    _validate_policy_shape(policy.floors, policy.required_arms)
    cells: Dict[Tuple[str, str, str], list[AcceptanceObservation]] = {}
    unknown_cases = set()
    for item in observations:
        if item.evidence_class != "offline":
            continue
        split = case_splits.get(item.case)
        if split is None:
            unknown_cases.add(item.case)
            continue
        if split != "held-out":
            continue
        cells.setdefault((item.arm, item.scorecard, item.segment), []).append(item)

    holds: list[str] = []
    rejects: list[str] = []
    metrics: Dict[str, Mapping[str, float | int]] = {}
    if unknown_cases:
        holds.append(f"unknown case split: {', '.join(sorted(unknown_cases))}")

    for arm in policy.required_arms:
        for (scorecard, segment), floor in policy.floors.items():
            key = (arm, scorecard, segment)
            label = f"{arm}:{scorecard}:{segment}"
            values = _metrics(cells.get(key, ()))
            scored = values["scored"]
            rates: Dict[str, float | int] = {
                **values,
                "correct_rate": values["correct"] / scored if scored else 0.0,
                "false_green_rate": values["false_green"] / scored if scored else 0.0,
                "false_block_rate": values["false_block"] / scored if scored else 0.0,
            }
            metrics[label] = rates
            if scored < floor.min_scored:
                holds.append(
                    f"{label} has {scored}/{floor.min_scored} independently scored held-out observations"
                )
                continue
            if rates["false_green_rate"] > floor.max_false_green_rate:
                rejects.append(
                    f"{label} false-green rate {rates['false_green_rate']:.3f} exceeds {floor.max_false_green_rate:.3f}"
                )
            if rates["false_block_rate"] > floor.max_false_block_rate:
                rejects.append(
                    f"{label} false-block rate {rates['false_block_rate']:.3f} exceeds {floor.max_false_block_rate:.3f}"
                )
            if rates["correct_rate"] < floor.min_correct_rate:
                rejects.append(
                    f"{label} correct rate {rates['correct_rate']:.3f} is below {floor.min_correct_rate:.3f}"
                )

    if rejects:
        return PromotionResult(status="reject", reasons=tuple(rejects), metrics=metrics)
    if holds:
        return PromotionResult(status="hold", reasons=tuple(holds), metrics=metrics)
    return PromotionResult(status="promote", reasons=(), metrics=metrics)
