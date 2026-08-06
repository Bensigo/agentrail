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
    # An AcceptanceCorpus is a convenient typed locator, not an authority:
    # callers can construct or mutate one in memory. Always re-admit its root
    # so manifest digests, labels, authority, and held-out presence are read
    # from disk at this production boundary.
    root = corpus_or_root.root if isinstance(corpus_or_root, AcceptanceCorpus) else Path(corpus_or_root)
    corpus = load_acceptance_case_corpus(
        root,
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
