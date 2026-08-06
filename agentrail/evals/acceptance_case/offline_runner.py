"""Pure four-arm orchestration for frozen Acceptance Case evaluation.

This is an evaluator boundary, not an agent runner. The builder adapter receives
only the arm-specific input; the independent scorer receives the frozen case
and can consult hidden labels. Every PR-head/environment target is explicit.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Mapping, Optional, Protocol, Sequence

from .loader import ARMS, AcceptanceCase
from .promotion import PromotionPolicy, PromotionResult, evaluate_promotion
from .runner import AcceptanceLineage, BuilderInput, acceptance_lineage, builder_input
from .scorecards import AcceptanceObservation, aggregate


@dataclass(frozen=True)
class EvaluationTarget:
    """One explicit frozen PR head/environment binding for a case arm."""

    pr_head: str
    environment_id: str


@dataclass(frozen=True)
class RunProvenance:
    """Versions owned by the evaluator, never supplied by a builder."""

    model: str
    config_version: str
    prompt_version: str
    guardrail_version: str
    scorer_version: str
    outcome_source: str

    def __post_init__(self) -> None:
        if any(not isinstance(value, str) or not value.strip() for value in self.__dict__.values()):
            raise ValueError("Acceptance Case run provenance values must be non-empty strings")


@dataclass(frozen=True)
class ScoredAttempt:
    """One independent score produced only after a builder attempt completes."""

    scorecard: str
    segment: str
    independent_truth: Optional[bool]
    jace_claim: Optional[bool]
    artifact_refs: str = "none"

    def __post_init__(self) -> None:
        if not self.scorecard or not self.segment:
            raise ValueError("Acceptance Case scores require a scorecard and segment")
        if not isinstance(self.artifact_refs, str) or not self.artifact_refs.strip():
            raise ValueError("Acceptance Case scores require artifact refs or explicit none")


class BuilderExecutor(Protocol):
    """Adapter for a selected external builder; never receives hidden labels."""

    def execute(self, builder: BuilderInput, lineage: AcceptanceLineage) -> object: ...


class IndependentScorer(Protocol):
    """Evaluator-owned scorer; it may read frozen labels, unlike a builder."""

    def score(
        self,
        case: AcceptanceCase,
        lineage: AcceptanceLineage,
        attempt: object,
    ) -> Iterable[ScoredAttempt]: ...


@dataclass(frozen=True)
class AcceptanceRunReport:
    """Reproducible arm-separated observations and optional held-out decision."""

    observations: tuple[AcceptanceObservation, ...]
    scorecards: Mapping[str, Mapping[str, int]]
    promotion: Optional[PromotionResult]


def run_offline_four_arm_evaluation(
    cases: Sequence[AcceptanceCase],
    *,
    targets: Mapping[tuple[str, str], EvaluationTarget],
    executor: BuilderExecutor,
    scorer: IndependentScorer,
    provenance: RunProvenance,
    promotion_policy: Optional[PromotionPolicy] = None,
) -> AcceptanceRunReport:
    """Run all canonical arms against explicit frozen revision/environment pairs.

    Missing targets are rejected rather than allowing a random PR head or
    environment to be scored. Promotion remains offline/held-out only because
    the existing gate excludes canary and production evidence by design.
    """
    names = [case.name for case in cases]
    if len(names) != len(set(names)):
        raise ValueError("Acceptance Case names must be unique within one evaluation run")
    required_targets = {(case.name, arm) for case in cases for arm in ARMS}
    supplied_targets = set(targets)
    if supplied_targets != required_targets:
        missing = sorted(required_targets - supplied_targets)
        unknown = sorted(supplied_targets - required_targets)
        details = []
        if missing:
            details.append(f"missing targets: {missing}")
        if unknown:
            details.append(f"unknown targets: {unknown}")
        raise ValueError("Acceptance Case evaluation targets must exactly cover all arms; " + "; ".join(details))

    observations: list[AcceptanceObservation] = []
    for case in cases:
        for arm in ARMS:
            target = targets[(case.name, arm)]
            lineage = acceptance_lineage(case, arm, pr_head=target.pr_head, environment_id=target.environment_id)
            # Case conversation, labels, source oracle, and repository metadata
            # remain evaluator-only; the builder adapter gets no case object.
            attempt = executor.execute(builder_input(case, arm), lineage)
            for score in scorer.score(case, lineage, attempt):
                if not isinstance(score, ScoredAttempt):
                    raise TypeError("independent scorer must return ScoredAttempt values")
                observations.append(_observation(case, lineage, score, provenance))

    result = tuple(observations)
    promotion = evaluate_promotion(
        result,
        case_splits={case.name: case.split for case in cases},
        policy=promotion_policy,
    ) if promotion_policy is not None else None
    return AcceptanceRunReport(observations=result, scorecards=aggregate(result), promotion=promotion)


def _observation(
    case: AcceptanceCase,
    lineage: AcceptanceLineage,
    score: ScoredAttempt,
    run: RunProvenance,
) -> AcceptanceObservation:
    includes_pack = lineage.context_pack_hash is not None
    return AcceptanceObservation(
        case=case.name,
        arm=lineage.arm,
        scorecard=score.scorecard,
        segment=score.segment,
        evidence_class="offline",
        independent_truth=score.independent_truth,
        jace_claim=score.jace_claim,
        provenance={
            "caseVersion": lineage.case_version,
            "corpusVersion": case.corpus_version,
            "repository": lineage.repository,
            "repositoryCommit": lineage.repository_commit,
            "contractVersion": lineage.contract_version,
            "model": run.model,
            "configVersion": run.config_version,
            "promptVersion": run.prompt_version,
            "guardrailVersion": run.guardrail_version,
            "contextPackHash": lineage.context_pack_hash if includes_pack else "none",
            "contextPackTokenBudget": str(lineage.context_pack_token_budget) if includes_pack else "none",
            "prHead": lineage.pr_head,
            "diffIdentity": lineage.diff_identity,
            "environmentId": lineage.environment_id,
            "artifactRefs": score.artifact_refs,
            "scorerVersion": run.scorer_version,
            "outcomeSource": run.outcome_source,
        },
    )
