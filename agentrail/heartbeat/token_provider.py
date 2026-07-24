"""Python GitHub token provider — mints App installation tokens.

The daemon that runs the live loop is Python, but the canonical GitHub
credential resolver (``getInstallationToken``) lives in TypeScript
(``packages/db-postgres/src/queries/github-app-token.ts``). This helper is
the Python twin: it reads the workspace's bound GitHub App
``installation_id`` and mints a fresh, short-lived installation access
token via :mod:`agentrail.github_app` — the same identity model every
console GitHub call now uses (spec:
docs/superpowers/specs/2026-07-24-jace-github-app-identity-design.md §7,
second rider). It no longer reads a stored OAuth ``access_token`` from an
``accounts`` row — that join is gone.

It reuses the **same persistence seam** the Issue Queue uses — the
QueueStore's :class:`~agentrail.afk.queue_store.Executor`
(``PostgresExecutor`` in production) — so there is one DB edge, not two. We
register the read SQL into the shared ``queue_store._SQL`` op map so the
real ``PostgresExecutor`` can serve it; tests inject an in-memory executor
and never touch a database.

Two callers, both unaffected by this internal swap: the heartbeat daemon's
GitHub polling (``agentrail/cli/commands/heartbeat.py``), and
``agentrail.cli.commands.issue._resolve_workspace_connection`` — Jace's
``create_issue`` shell-path fallback. Both keep working off this function's
unchanged ``(workspace_id, executor) -> Optional[str]`` signature; ``None``
still means "no usable GitHub credential for this workspace", so every
caller's existing None-handling (e.g. issue.py's "connect a repo" guidance)
needs no changes.

The ``GITHUB_OAUTH_TOKEN``/``GITHUB_TOKEN`` env-based auth path (explicit
self-host PAT use — see ``issue.py``'s ``_github_oauth_token()``) is
untouched by this module: that path never calls ``get_github_token`` at
all, and stays available for hosted deployments that leave the App env
unset in favor of a manually configured PAT.
"""
from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Protocol

from agentrail import github_app
from agentrail.afk import queue_store

# The op name the provider issues against the Executor. Registered into the
# PostgresExecutor SQL map below so the real executor can serve it.
GITHUB_TOKEN_OP = "github_installation_id_for_workspace"

# The workspace's bound GitHub App installation id (Task 2's migration:
# workspaces.github_installation_id, additive/nullable). NULL means "GitHub
# not connected" — mirrors the TS getGithubInstallation query exactly.
TOKEN_SQL: Dict[str, str] = {
    GITHUB_TOKEN_OP: (
        "SELECT github_installation_id FROM workspaces WHERE id = %(workspace_id)s"
    )
}

# Register the op into the shared SQL map so PostgresExecutor.query/execute can
# resolve it (the executor looks ops up in queue_store._SQL). Idempotent.
queue_store._SQL.update(TOKEN_SQL)

# Env vars carrying the GitHub App's own credentials — same names as the TS
# side's resolveGithubAppConfig (packages/github-app/src/index.ts). Either
# missing means the App itself is unconfigured for this deployment.
_APP_ID_ENV = "GITHUB_APP_ID"
_APP_PRIVATE_KEY_ENV = "GITHUB_APP_PRIVATE_KEY"


class _Reader(Protocol):
    def query(self, op: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:  # pragma: no cover
        ...


def get_github_token(workspace_id: str, executor: _Reader) -> Optional[str]:
    """Mint and return a fresh GitHub App installation token, or ``None``.

    Three-step resolution — the Python mirror of the TS
    ``getInstallationToken``:

      1. Read ``github_installation_id`` for ``workspace_id`` from
         ``workspaces`` via ``executor``. Absent/``NULL`` → workspace has no
         GitHub App installation bound.
      2. Read ``GITHUB_APP_ID``/``GITHUB_APP_PRIVATE_KEY`` from the
         environment. Either missing → the App itself is unconfigured.
      3. Mint via :func:`agentrail.github_app.mint_installation_token`
         (module-qualified so tests can monkeypatch
         ``agentrail.github_app.mint_installation_token`` directly). Any
         failure there — network, 404/uninstalled, rejected, malformed body
         — already collapses to ``None``.

    ``None`` covers every "no usable GitHub credential" reason, so callers'
    existing None-handling is unchanged. Tokens are minted fresh on every
    call — never cached, never logged.
    """
    rows = executor.query(GITHUB_TOKEN_OP, {"workspace_id": workspace_id})
    if not rows:
        return None
    installation_id = rows[0].get("github_installation_id")
    if not installation_id:
        return None

    app_id = os.environ.get(_APP_ID_ENV)
    private_key_pem = os.environ.get(_APP_PRIVATE_KEY_ENV)
    if not app_id or not private_key_pem:
        return None

    return github_app.mint_installation_token(
        str(installation_id),
        app_id=app_id,
        private_key_pem=private_key_pem,
    )
