"""Python connectors seam — ``list_active_connectors`` for the Heartbeat daemon.

The daemon is Python; the connectors table is written by the TS console. This
seam reads it over the same QueueStore Executor seam (``PostgresExecutor`` in
the CLI, an in-memory fake here), so the daemon self-configures from connectors
instead of CLI args/env. Hermetic — no database.
"""
from __future__ import annotations

from typing import Any, Dict, List

from agentrail.afk.connectors_store import (
    CONNECTORS_OP,
    ConnectorConfig,
    list_active_connectors,
)


class FakeExecutor:
    """In-memory Executor: returns canned rows for the connectors query op."""

    def __init__(self, rows: List[Dict[str, Any]]):
        self._rows = rows
        self.queries: List[tuple] = []

    def execute(self, op: str, params: Dict[str, Any]) -> None:  # pragma: no cover
        raise AssertionError("connectors seam only reads")

    def query(self, op: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        self.queries.append((op, params))
        return list(self._rows)


def test_returns_only_enabled_connectors():
    ex = FakeExecutor(
        [
            {
                "provider": "github",
                "enabled": True,
                "config": {
                    "repos": ["bensigo/agentrail"],
                    "triggerLabel": "ready-for-agent",
                    "pollIntervalSeconds": 60,
                },
            },
            {
                "provider": "discord",
                "enabled": False,
                "config": {"repos": [], "triggerLabel": "x", "pollIntervalSeconds": 60},
            },
        ]
    )
    active = list_active_connectors("ws-1", ex)
    assert [c.provider for c in active] == ["github"]
    op, params = ex.queries[0]
    assert op == CONNECTORS_OP
    assert params["workspace_id"] == "ws-1"


def test_parses_config_fields():
    ex = FakeExecutor(
        [
            {
                "provider": "github",
                "enabled": True,
                "config": {
                    "repos": ["o/r", "a/b"],
                    "triggerLabel": "afk",
                    "pollIntervalSeconds": 300,
                },
            }
        ]
    )
    c = list_active_connectors("ws-1", ex)[0]
    assert isinstance(c, ConnectorConfig)
    assert c.provider == "github"
    assert c.enabled is True
    assert c.repos == ["o/r", "a/b"]
    assert c.trigger_label == "afk"
    assert c.poll_interval_seconds == 300


def test_applies_defaults_for_missing_config_keys():
    # A row whose jsonb config is missing keys (or null) still yields a complete
    # ConnectorConfig with sane defaults — the daemon can always rely on it.
    ex = FakeExecutor(
        [{"provider": "github", "enabled": True, "config": {}}]
    )
    c = list_active_connectors("ws-1", ex)[0]
    assert c.repos == []
    assert c.trigger_label == "ready-for-agent"
    assert c.poll_interval_seconds == 60


def test_handles_config_as_json_string():
    # PostgresExecutor may return jsonb as a string depending on the driver; the
    # seam parses it rather than assuming a dict.
    ex = FakeExecutor(
        [
            {
                "provider": "github",
                "enabled": True,
                "config": '{"repos": ["o/r"], "triggerLabel": "afk", "pollIntervalSeconds": 120}',
            }
        ]
    )
    c = list_active_connectors("ws-1", ex)[0]
    assert c.repos == ["o/r"]
    assert c.trigger_label == "afk"
    assert c.poll_interval_seconds == 120


def test_empty_when_no_connectors():
    assert list_active_connectors("ws-x", FakeExecutor([])) == []


def test_query_op_is_registered_in_postgres_sql():
    from agentrail.afk import connectors_store, queue_store

    assert CONNECTORS_OP in connectors_store.CONNECTORS_SQL
    # Registered into the shared SQL map so the real PostgresExecutor serves it.
    assert CONNECTORS_OP in queue_store._SQL
