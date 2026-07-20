"""Repo-wide pytest fixtures."""
from __future__ import annotations

import pytest

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
