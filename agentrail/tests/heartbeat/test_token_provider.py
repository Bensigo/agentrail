"""Python GitHub token provider — mints App installation tokens.

The daemon is Python; the existing ``getInstallationToken`` is TS. This
helper mirrors that resolution (``workspaces.github_installation_id`` ->
mint) over the same QueueStore Executor seam, so it is hermetic with an
in-memory fake executor plus a monkeypatched mint.
"""
from __future__ import annotations

from typing import Any, Dict, List

import pytest

from agentrail import github_app
from agentrail.heartbeat.token_provider import get_github_token


class FakeExecutor:
    """In-memory Executor: returns canned rows for the installation-id query op."""

    def __init__(self, rows: List[Dict[str, Any]]):
        self._rows = rows
        self.queries: List[tuple] = []

    def execute(self, op: str, params: Dict[str, Any]) -> None:  # pragma: no cover
        raise AssertionError("token provider only reads")

    def query(self, op: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        self.queries.append((op, params))
        return list(self._rows)


@pytest.fixture(autouse=True)
def _app_env(monkeypatch: pytest.MonkeyPatch) -> None:
    # Configured by default so tests exercise the mint path; individual
    # tests that need the App-unconfigured case delete these themselves.
    monkeypatch.setenv("GITHUB_APP_ID", "app-123")
    monkeypatch.setenv("GITHUB_APP_PRIVATE_KEY", "test-private-key-pem")


def test_returns_minted_token_when_installation_bound(monkeypatch: pytest.MonkeyPatch):
    ex = FakeExecutor([{"github_installation_id": "inst-42"}])
    calls = []

    def _fake_mint(installation_id, *, app_id, private_key_pem, transport=None):
        calls.append((installation_id, app_id, private_key_pem))
        return "ghs_minted_token"

    monkeypatch.setattr(github_app, "mint_installation_token", _fake_mint)

    token = get_github_token("ws-1", ex)

    assert token == "ghs_minted_token"
    assert calls == [("inst-42", "app-123", "test-private-key-pem")]
    # queried scoped to the workspace.
    op, params = ex.queries[0]
    assert params["workspace_id"] == "ws-1"


def test_returns_none_when_no_installation_bound():
    ex = FakeExecutor([])
    assert get_github_token("ws-2", ex) is None


def test_returns_none_when_installation_id_null():
    ex = FakeExecutor([{"github_installation_id": None}])
    assert get_github_token("ws-3", ex) is None


def test_returns_none_when_app_env_unconfigured(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("GITHUB_APP_ID", raising=False)
    monkeypatch.delenv("GITHUB_APP_PRIVATE_KEY", raising=False)
    ex = FakeExecutor([{"github_installation_id": "inst-42"}])

    assert get_github_token("ws-4", ex) is None
    # never even reaches the mint step, but confirm no crash either way.


def test_returns_none_when_mint_fails(monkeypatch: pytest.MonkeyPatch):
    ex = FakeExecutor([{"github_installation_id": "inst-99"}])
    monkeypatch.setattr(github_app, "mint_installation_token", lambda *a, **k: None)

    assert get_github_token("ws-5", ex) is None


def test_query_op_is_registered_in_postgres_sql():
    # The op the provider issues must exist in the PostgresExecutor SQL map so the
    # real executor can serve it (guards against a silently-missing query).
    from agentrail.heartbeat.token_provider import GITHUB_TOKEN_OP
    from agentrail.heartbeat import token_provider

    assert GITHUB_TOKEN_OP in token_provider.TOKEN_SQL
