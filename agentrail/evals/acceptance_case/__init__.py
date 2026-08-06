"""Frozen, independently scored Acceptance Case fixtures for Jace evals."""

from .loader import ARMS, AcceptanceCase, AcceptanceCaseError, ContextPackDescriptor, load_case, load_cases
from .offline_runner import (
    AcceptanceRunReport,
    BuilderAttempt,
    BuilderExecutor,
    BuilderWorkspace,
    IndependentScorer,
    RunProvenance,
    ScoredAttempt,
    run_offline_four_arm_evaluation,
)
from .runner import AcceptanceLineage, BuilderInput, acceptance_lineage, builder_input
from .promotion import MetricFloor, PromotionPolicy, PromotionResult, evaluate_promotion
from .proof_verifier import CriterionProofClaim, ProofArtifact, ProofIndependentScorer, ProofVerification, verify_criterion_proof
from .report import (
    AcceptanceReportFormatError,
    acceptance_run_report_from_dict,
    acceptance_run_report_to_dict,
    parse_acceptance_run_report_json,
    read_acceptance_run_report,
    render_acceptance_run_report_markdown,
    serialize_acceptance_run_report,
    write_acceptance_run_report_markdown,
)

__all__ = [
    "ARMS",
    "AcceptanceCase",
    "AcceptanceCaseError",
    "AcceptanceRunReport",
    "AcceptanceLineage",
    "BuilderAttempt",
    "BuilderExecutor",
    "BuilderInput",
    "BuilderWorkspace",
    "ContextPackDescriptor",
    "IndependentScorer",
    "MetricFloor",
    "PromotionPolicy",
    "PromotionResult",
    "CriterionProofClaim",
    "ProofArtifact",
    "ProofIndependentScorer",
    "ProofVerification",
    "RunProvenance",
    "ScoredAttempt",
    "acceptance_lineage",
    "builder_input",
    "evaluate_promotion",
    "load_case",
    "load_cases",
    "run_offline_four_arm_evaluation",
    "verify_criterion_proof",
    "AcceptanceReportFormatError",
    "acceptance_run_report_from_dict",
    "acceptance_run_report_to_dict",
    "parse_acceptance_run_report_json",
    "read_acceptance_run_report",
    "render_acceptance_run_report_markdown",
    "serialize_acceptance_run_report",
    "write_acceptance_run_report_markdown",
]
