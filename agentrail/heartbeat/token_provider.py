"""Python GitHub token provider for the Heartbeat daemon.

The daemon that runs the live loop is Python, but the canonical GitHub-token
lookup (``getGithubToken``) lives in TypeScript
(``packages/db-postgres/src/queries/index.ts``). This helper is the Python twin:
it reads the **workspace owner's** stored GitHub OAuth ``access_token`` so the
``GitHubOAuthClient`` can poll/post as that user.

It reuses the **same persistence seam** the Issue Queue uses — the QueueStore's
:class:`~agentrail.afk.queue_store.Executor` (``PostgresExecutor`` in
production) — so there is one DB edge, not two. The SQL mirrors the TS query
exactly: join ``workspace_memberships`` (role = ``owner``) to ``accounts``
(provider = ``github``) and read ``access_token``. We register that SQL into the
shared ``queue_store._SQL`` op map so the real ``PostgresExecutor`` can serve the
op; tests inject an in-memory executor and never touch a database.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Protocol

from agentrail.afk import queue_store

# The op name the provider issues against the Executor. Registered into the
# PostgresExecutor SQL map below so the real executor can serve it.
GITHUB_TOKEN_OP = "github_token_for_owner"

# Mirrors the TS getGithubToken query: the workspace OWNER's github account
# access_token. One row at most (LIMIT 1).
TOKEN_SQL: Dict[str, str] = {
    GITHUB_TOKEN_OP: (
        "SELECT a.access_token AS access_token "
        "FROM workspace_memberships m "
        "JOIN accounts a "
        "  ON a.user_id = m.user_id AND a.provider = 'github' "
        "WHERE m.workspace_id = %(workspace_id)s AND m.role = 'owner' "
        "LIMIT 1"
    )
}

# Register the op into the shared SQL map so PostgresExecutor.query/execute can
# resolve it (the executor looks ops up in queue_store._SQL). Idempotent.
queue_store._SQL.update(TOKEN_SQL)


class _Reader(Protocol):
    def query(self, op: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:  # pragma: no cover
        ...


def get_github_token(workspace_id: str, executor: _Reader) -> Optional[str]:
    """Return the workspace owner's GitHub OAuth ``access_token``, or ``None``.

    Mirrors the TS ``getGithubToken``: ``None`` when the owner has no linked
    GitHub account *or* the stored token is null. ``executor`` is the same
    Executor the QueueStore uses (``PostgresExecutor`` in the CLI, a fake in
    tests), so the daemon has a single DB edge.
    """
    rows = executor.query(GITHUB_TOKEN_OP, {"workspace_id": workspace_id})
    if not rows:
        return None
    token = rows[0].get("access_token")
    return token or None
