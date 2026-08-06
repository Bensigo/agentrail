"""Frozen, independently scored Acceptance Case fixtures for Jace evals."""

from .loader import ARMS, AcceptanceCase, AcceptanceCaseError, ContextPackDescriptor, load_case, load_cases
from .offline_runner import (
    AcceptanceRunReport,
    BuilderExecutor,
    EvaluationTarget,
    IndependentScorer,
    RunProvenance,
    ScoredAttempt,
    run_offline_four_arm_evaluation,
)
from .runner import AcceptanceLineage, BuilderInput, acceptance_lineage, builder_input
from .promotion import MetricFloor, PromotionPolicy, PromotionResult, evaluate_promotion

__all__ = [
    "ARMS",
    "AcceptanceCase",
    "AcceptanceCaseError",
    "AcceptanceRunReport",
    "AcceptanceLineage",
    "BuilderExecutor",
    "BuilderInput",
    "ContextPackDescriptor",
    "EvaluationTarget",
    "IndependentScorer",
    "MetricFloor",
    "PromotionPolicy",
    "PromotionResult",
    "RunProvenance",
    "ScoredAttempt",
    "acceptance_lineage",
    "builder_input",
    "evaluate_promotion",
    "load_case",
    "load_cases",
    "run_offline_four_arm_evaluation",
]
