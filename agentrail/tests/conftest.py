"""Repo-wide pytest fixtures."""
from __future__ import annotations

import pytest


# These tests intentionally exercise the repository checkout itself rather than
# a small temporary fixture. Keep them out of the fast PR lane so a missing
# generated index cannot trigger a full-repository build as a side effect of
# an otherwise ordinary unit-test run. The path-triggered integration workflow
# runs them with an explicitly prepared index.
_INTEGRATION_NODE_FRAGMENTS = (
    # Full-checkout retrieval/evaluation quality gates.
    "tests/context/test_file_level_precision.py::ReportWiringTests",
    "tests/context/test_nonsaturated_fixtures.py::NonSaturatedCorpusTests",
    "tests/context/test_pack_cutoff.py::PackCutoffNoOpTests",
    "tests/context/test_pack_cutoff.py::PackCutoffCertificationTests",
    "tests/context/test_rank_aware_metric.py::ReportWiringTests",
    "tests/context/test_rank_nonsaturated_fixtures.py::RankNonSaturatedCorpusTests",
    "tests/context/test_retrieval_grep_baseline.py::",
    "tests/context/test_retrieval_precision_fixtures.py::AC2_EvalProducesLiveNonZeroMetrics",
    "tests/context/test_retrieval_precision_fixtures.py::AC4_PackPrecisionIsFalsifiable",
    "tests/context/test_rerank.py::RerankPrecisionImprovementTests",
    "tests/context/test_symbol_candidates.py::HardFixtureRecallCertification",
    "tests/context/test_symbol_packing.py::SymbolPackingRecallUnchangedTests",
    "tests/context/test_wiki_retrieval.py::OrientationProbesFixtureTests",
    # Real corpus/index canaries and commit-pinned hidden-test proofs.
    "tests/evals/test_spine.py::test_e2e_pack_precision_recall_populated_on_real_run",
    "tests/evals/test_spine.py::test_e2e_rerank_flag_toggles_the_cited_set",
    "tests/evals/test_spine.py::test_cli_evals_run_smoke_drives_spine",
    "tests/evals/test_spine.py::test_cli_evals_run_ablation_runs_full_leave_one_out_set",
    "tests/cli/test_evals_cli.py::EvalsRunNewFlowCliTests",
    "tests/evals/test_corpus_pins.py::test_empty_diff_fails_at_pinned_commit",
    "tests/evals/test_corpus_pins.py::test_solving_diff_passes_at_pinned_commit",
    "tests/evals/test_corpus_pins.py::test_captured_agent_diff_solves_a_real_corpus_task_end_to_end",
    "tests/evals/test_corpus_pins.py::test_wrong_change_fails_for_abstain_task",
    "tests/evals/test_hidden_tests.py::test_ac3_real_corpus_output_format_enforcer_end_to_end",
)


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    """Classify full-checkout tests for the dedicated integration lane."""
    integration = pytest.mark.integration
    for item in items:
        if any(fragment in item.nodeid for fragment in _INTEGRATION_NODE_FRAGMENTS):
            item.add_marker(integration)

# Dashboard-link env fallback used by load_server_config when the target has no
# .agentrail/server.json. AFK sets these for the pipeline process, so any test
# that exercises the run pipeline would otherwise push telemetry (context packs,
# cost events, run events) to the LIVE dashboard. Strip them for every test;
# tests that exercise the env fallback explicitly set them with
# monkeypatch.setenv, which runs after this autouse fixture.
_SERVER_ENV_VARS = (
    "AGENTRAIL_SERVER_BASE_URL",
    "AGENTRAIL_SERVER_API_KEY",
    "AGENTRAIL_SERVER_REPOSITORY_ID",
)


@pytest.fixture(autouse=True)
def _isolate_server_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for var in _SERVER_ENV_VARS:
        monkeypatch.delenv(var, raising=False)


# ---------------------------------------------------------------------------
# agentrail.run.pricing's gateway catalog (#1337, simplified 2026-07-20): the
# committed snapshot file is gone — ``_resolve_rates`` now lazily fetches
# ``https://openrouter.ai/api/v1/models`` (blocking, once per process) the
# first time ANY of ``cost_usd``/``cost_breakdown``/``resolve_price_source``
# runs. Without this fixture, the FIRST such call in the whole test session
# would make a real network call. This resets the lazy-load state before
# every test and stubs the fetch with a small, deterministic fixture covering
# the real slugs several existing tests depend on resolving via the
# "gateway" tier (deploy/runner/agentrail-config.hosted.json's
# execute/verify/critic seats, plus catalog.ts's MODEL_CATALOG "refactor"
# seat) — so the whole suite stays network-free and deterministic. A test
# that wants the FAILURE path re-monkeypatches
# ``agentrail.run.pricing._fetch_gateway_rates`` itself, AFTER this fixture
# runs (monkeypatch is last-set-wins within a single test).
# ---------------------------------------------------------------------------
_FAKE_GATEWAY_RATES: dict[str, tuple[float, float]] = {
    "anthropic/claude-sonnet-5": (3.0, 15.0),
    "anthropic/claude-opus-4.8": (5.0, 25.0),
    "anthropic/claude-haiku-4.5": (1.0, 5.0),
    "z-ai/glm-5.2": (0.30, 0.94),
}


@pytest.fixture(autouse=True)
def _mock_gateway_rates(monkeypatch: pytest.MonkeyPatch) -> None:
    import agentrail.run.pricing as pricing

    monkeypatch.setattr(pricing, "_gateway_rates_loaded", False)
    pricing._GATEWAY_RATES.clear()
    monkeypatch.setattr(pricing, "_fetch_gateway_rates", lambda: dict(_FAKE_GATEWAY_RATES))
    # Trigger the (mocked) load eagerly, matching the pre-#1337-simplification
    # behaviour of eagerly-populated-at-import-time ``_GATEWAY_RATES`` — some
    # tests read that dict directly without first calling a pricing function
    # that would otherwise trigger the lazy load themselves.
    pricing._ensure_gateway_rates_loaded()
