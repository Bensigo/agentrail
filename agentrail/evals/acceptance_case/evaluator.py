"""Manifest-bound production entrypoint for Acceptance Case evaluation."""
from __future__ import annotations

from pathlib import Path
from typing import Union

from .corpus import AcceptanceCorpus, AcceptanceCorpusError, load_acceptance_case_corpus
from .offline_runner import (
    AcceptanceRunReport,
    BuilderExecutor,
    IndependentScorer,
    PromotionPolicy,
    RunProvenance,
    run_offline_four_arm_evaluation,
)


def run_manifest_bound_offline_evaluation(
    corpus_or_root: Union[AcceptanceCorpus, Path, str],
    *,
    executor: BuilderExecutor,
    scorer: IndependentScorer,
    provenance: RunProvenance,
    promotion_policy: PromotionPolicy | None = None,
) -> AcceptanceRunReport:
    """Run the four-arm evaluator only from a manifest-bound corpus.

    A promotion-bearing run requires independent labels and at least one
    held-out Case. Cases and splits always come from the admitted corpus; the
    caller cannot supply an arbitrary in-memory split mapping.
    """
    if isinstance(corpus_or_root, AcceptanceCorpus):
        corpus = corpus_or_root
        if promotion_policy is not None and corpus.label_class != "independent":
            raise AcceptanceCorpusError(
                "Acceptance Case corpus: synthetic labels cannot support held-out promotion"
            )
        if promotion_policy is not None and not any(case.split == "held-out" for case in corpus.cases):
            raise AcceptanceCorpusError(
                "Acceptance Case corpus: independent promotion requires at least one held-out Case"
            )
    else:
        corpus = load_acceptance_case_corpus(
            Path(corpus_or_root),
            require_independent_labels=promotion_policy is not None,
        )

    report = run_offline_four_arm_evaluation(
        corpus.cases,
        executor=executor,
        scorer=scorer,
        provenance=provenance,
        promotion_policy=promotion_policy,
    )
    return AcceptanceRunReport(
        observations=report.observations,
        scorecards=report.scorecards,
        promotion=report.promotion,
        corpus_provenance={
            "corpusVersion": corpus.corpus_version,
            "labelClass": corpus.label_class,
            "labelAuthority": dict(corpus.label_authority),
            "caseDigests": dict(corpus.case_digests),
            "caseSplits": {case.name: case.split for case in corpus.cases},
        },
    )
