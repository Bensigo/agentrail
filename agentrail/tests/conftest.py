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
