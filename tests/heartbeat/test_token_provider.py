"""Python GitHub token provider — reads the workspace owner's OAuth access_token.

The daemon is Python; the existing ``getGithubToken`` is TS. This helper mirrors
that query (workspace_memberships → accounts, role=owner, provider=github) over
the same QueueStore Executor seam, so it is hermetic with an in-memory fake.
"""
from __future__ import annotations

from typing import Any, Dict, List

from agentrail.heartbeat.token_provider import get_github_token


class FakeExecutor:
    """In-memory Executor: returns canned rows for the github-token query op."""

    def __init__(self, rows: List[Dict[str, Any]]):
        self._rows = rows
        self.queries: List[tuple] = []

    def execute(self, op: str, params: Dict[str, Any]) -> None:  # pragma: no cover
        raise AssertionError("token provider only reads")

    def query(self, op: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        self.queries.append((op, params))
        return list(self._rows)


def test_returns_owner_access_token():
    ex = FakeExecutor([{"access_token": "gho_stored_token"}])
    token = get_github_token("ws-1", ex)
    assert token == "gho_stored_token"
    # queried scoped to the workspace.
    op, params = ex.queries[0]
    assert params["workspace_id"] == "ws-1"


def test_returns_none_when_no_linked_account():
    ex = FakeExecutor([])
    assert get_github_token("ws-2", ex) is None


def test_returns_none_when_access_token_null():
    ex = FakeExecutor([{"access_token": None}])
    assert get_github_token("ws-3", ex) is None


def test_query_op_is_registered_in_postgres_sql():
    # The op the provider issues must exist in the PostgresExecutor SQL map so the
    # real executor can serve it (guards against a silently-missing query).
    from agentrail.heartbeat.token_provider import GITHUB_TOKEN_OP
    from agentrail.heartbeat import token_provider

    assert GITHUB_TOKEN_OP in token_provider.TOKEN_SQL
