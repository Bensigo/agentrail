from dataclasses import replace
from pathlib import Path

import pytest

from agentrail.evals.acceptance_case.corpus import AcceptanceCorpusError, load_acceptance_case_corpus
from agentrail.evals.acceptance_case.evaluator import run_manifest_bound_offline_evaluation
from agentrail.evals.acceptance_case.offline_runner import BuilderAttempt, RunProvenance, ScoredAttempt
from agentrail.evals.acceptance_case.promotion import MetricFloor, PromotionPolicy
from agentrail.tests.evals.test_acceptance_case_corpus import _write_corpus


class _Executor:
    def execute(self, builder, workspace):
        return BuilderAttempt("head-sha", "preview-1", {"arm": builder.arm})


class _Scorer:
    def score(self, case, lineage, attempt):
        return [ScoredAttempt("proof", "ui", True, True, "artifact-1")]


def _provenance() -> RunProvenance:
    return RunProvenance("builder-v1", "config-v1", "prompt-v1", "guardrail-v1", "scorer-v1", "fixture-labels")


def _policy() -> PromotionPolicy:
    return PromotionPolicy({("proof", "ui"): MetricFloor(1, 1, 0, 0)})


def test_manifest_bound_entrypoint_rejects_synthetic_promotion(tmp_path: Path) -> None:
    _write_corpus(tmp_path, label_class="synthetic")

    with pytest.raises(AcceptanceCorpusError, match="synthetic labels"):
        run_manifest_bound_offline_evaluation(
            tmp_path, executor=_Executor(), scorer=_Scorer(),
            provenance=_provenance(), promotion_policy=_policy(),
        )


def test_forged_corpus_object_is_reloaded_from_its_root_before_promotion(tmp_path: Path) -> None:
    _write_corpus(tmp_path, label_class="synthetic")
    forged = replace(
        load_acceptance_case_corpus(tmp_path),
        label_class="independent",
    )

    with pytest.raises(AcceptanceCorpusError, match="synthetic labels"):
        run_manifest_bound_offline_evaluation(
            forged, executor=_Executor(), scorer=_Scorer(),
            provenance=_provenance(), promotion_policy=_policy(),
        )


def test_manifest_bound_entrypoint_runs_all_cases_and_carries_provenance(tmp_path: Path) -> None:
    _write_corpus(tmp_path, label_class="independent")

    report = run_manifest_bound_offline_evaluation(
        load_acceptance_case_corpus(tmp_path, require_independent_labels=True),
        executor=_Executor(), scorer=_Scorer(),
        provenance=_provenance(), promotion_policy=_policy(),
    )

    assert len(report.observations) == 8
    assert report.promotion is not None and report.promotion.status == "promote"
    assert report.corpus_provenance is not None
    assert report.corpus_provenance["labelClass"] == "independent"
    assert report.corpus_provenance["caseSplits"] == {"dev-save": "dev", "held-save": "held-out"}
    assert set(report.corpus_provenance["caseDigests"]) == {"dev-save", "held-save"}
