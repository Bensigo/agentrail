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
from .corpus import (
    AcceptanceCorpus,
    AcceptanceCorpusError,
    CORPUS_FORMAT_VERSION,
    CORPUS_MANIFEST_FILE,
    load_acceptance_case_corpus,
)
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
from .evaluator import run_manifest_bound_offline_evaluation

__all__ = [
    "ARMS",
    "AcceptanceCase",
    "AcceptanceCaseError",
    "AcceptanceCorpus",
    "AcceptanceCorpusError",
    "AcceptanceRunReport",
    "AcceptanceLineage",
    "BuilderAttempt",
    "BuilderExecutor",
    "BuilderInput",
    "BuilderWorkspace",
    "ContextPackDescriptor",
    "CORPUS_FORMAT_VERSION",
    "CORPUS_MANIFEST_FILE",
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
    "load_acceptance_case_corpus",
    "load_cases",
    "run_offline_four_arm_evaluation",
    "run_manifest_bound_offline_evaluation",
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
