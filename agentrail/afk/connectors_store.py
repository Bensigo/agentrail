"""Python connectors seam for the Heartbeat daemon.

The Heartbeat daemon is Python, but the **connectors** table — the per-workspace,
per-provider control surface that ALSO configures the heartbeat — is written by
the TS console. This seam is the Python read edge: ``list_active_connectors``
returns the *enabled* connectors for a workspace, each with its trigger config
(repos / label / poll interval). The daemon's ``_build_runtime`` reads it to
source the GitHub poll config instead of CLI args/env.

It reuses the **same persistence seam** the Issue Queue uses — the QueueStore's
:class:`~agentrail.afk.queue_store.Executor` (``PostgresExecutor`` in production)
— so there is one DB edge, not two. We register the SQL into the shared
``queue_store._SQL`` op map so the real executor can serve it; tests inject an
in-memory executor and never touch a database.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Protocol

from agentrail.afk import queue_store

# The op name issued against the Executor. Registered into the shared SQL map so
# the real PostgresExecutor can resolve it.
CONNECTORS_OP = "list_connectors_for_workspace"

# Defaults applied when a connector's stored jsonb config is missing keys (or is
# null). Mirrors CONNECTOR_CONFIG_DEFAULTS in
# packages/db-postgres/src/schema/connectors.ts.
DEFAULT_TRIGGER_LABEL = "ready-for-agent"
DEFAULT_POLL_INTERVAL_SECONDS = 60

# Mirrors the TS getConnectors query: every connector row for a workspace,
# ordered by provider for a stable surface.
CONNECTORS_SQL: Dict[str, str] = {
    CONNECTORS_OP: (
        "SELECT provider, enabled, config "
        "FROM connectors WHERE workspace_id = %(workspace_id)s "
        "ORDER BY provider ASC"
    )
}

# Register into the shared SQL map so PostgresExecutor.query can resolve it.
queue_store._SQL.update(CONNECTORS_SQL)


@dataclass(frozen=True)
class ConnectorConfig:
    """One active connector's daemon-facing config (parsed from a table row)."""

    provider: str
    enabled: bool
    repos: List[str] = field(default_factory=list)
    trigger_label: str = DEFAULT_TRIGGER_LABEL
    poll_interval_seconds: int = DEFAULT_POLL_INTERVAL_SECONDS


class _Reader(Protocol):
    def query(self, op: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:  # pragma: no cover
        ...


def _parse_config(raw: Any) -> Dict[str, Any]:
    """Coerce a stored jsonb config to a dict (it may arrive as a JSON string)."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            return {}
    return raw if isinstance(raw, dict) else {}


def _row_to_config(row: Dict[str, Any]) -> ConnectorConfig:
    cfg = _parse_config(row.get("config"))
    repos = cfg.get("repos")
    if not isinstance(repos, list):
        repos = []
    label = cfg.get("triggerLabel")
    interval = cfg.get("pollIntervalSeconds")
    return ConnectorConfig(
        provider=str(row.get("provider", "")),
        enabled=bool(row.get("enabled")),
        repos=[str(r) for r in repos],
        trigger_label=str(label) if label else DEFAULT_TRIGGER_LABEL,
        poll_interval_seconds=(
            int(interval)
            if isinstance(interval, (int, float))
            else DEFAULT_POLL_INTERVAL_SECONDS
        ),
    )


def list_active_connectors(
    workspace_id: str, executor: _Reader
) -> List[ConnectorConfig]:
    """Return the workspace's **enabled** connectors with their trigger config.

    The daemon reads this to self-configure (repos / label / interval) instead of
    CLI args/env. Disabled connectors are filtered out — ``enabled`` is the
    operator's intent. ``executor`` is the same Executor the QueueStore uses
    (``PostgresExecutor`` in the CLI, a fake in tests), so there is one DB edge.
    """
    rows = executor.query(CONNECTORS_OP, {"workspace_id": workspace_id})
    configs = [_row_to_config(r) for r in rows]
    return [c for c in configs if c.enabled]


def get_active_connector(
    workspace_id: str, provider: str, executor: _Reader
) -> Optional[ConnectorConfig]:
    """The single enabled connector for ``provider``, or ``None``.

    Convenience for the daemon's GitHub poll config (it watches one provider).
    """
    for c in list_active_connectors(workspace_id, executor):
        if c.provider == provider:
            return c
    return None
