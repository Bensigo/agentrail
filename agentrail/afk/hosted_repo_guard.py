"""Hosted-repo quarantine (#1271) — refuse to run AFK against a repo that
belongs to a HOSTED CUSTOMER workspace.

``agentrail afk`` can auto-merge once its review gate passes, but only
opt-in: grantable merge permission (#1278) shipped as the ``--auto-merge``
CLI flag, default OFF (``Runner.auto_merge`` / ``Runner._review_and_gate``
-> ``Runner._merge`` -> ``gh.merge_pr_squash``, ``afk/runner.py``). That
default-OFF gate is a SEPARATE, per-invocation trust decision — it does not
change whether AFK should be allowed to touch a repo it doesn't own at all.
This module's job is unchanged by #1278 shipping: AFK must never even START
against a repo connected to somebody else's hosted workspace, ``--auto-merge``
on or off — a foreign hosted repo is out of bounds for ANY AFK activity, not
just merging. This module is the read-only lookup that answers "does this
repo belong to a FOREIGN hosted workspace?"; ``agentrail/cli/commands/afk.py``
is the caller that turns the answer into a refusal (or an explicit, logged
override).

Two independent places record "this repo is connected to workspace X", and a
repo can show up in either one depending on how it was connected, so both are
checked (neither alone is authoritative):

  - the ``github`` **connector**'s ``config.repos`` (self-service "Connect a
    repo" write path — mirrors ``agentrail.afk.connectors_store``, and the TS
    ``findWorkspaceByRepo``, ``packages/db-postgres/src/queries/github_intake.ts``).
  - the **repositories** table's ``name`` (already an ``owner/repo`` slug,
    ``packages/db-postgres/src/queries/index.ts:createRepository``) and ``url``
    (``https://github.com/owner/repo``, parsed the same way the console's
    ``github-slug.ts#parseGithubSlug`` does) — the indexed-repo write path.

Reuses the **same persistence seam** the Issue Queue / connectors / token
provider already use — the QueueStore's ``Executor`` (``PostgresExecutor`` in
production) — registering its SQL into the shared ``queue_store._SQL`` op map
so the real executor can serve it; tests inject an in-memory fake and never
touch a database. Deliberately kept import-free of its sibling seam modules
(``connectors_store.py``, ``heartbeat/token_provider.py``) — each seam module
here is self-contained, matching the existing convention.
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Protocol, Tuple

from agentrail.afk import queue_store

# --- owner/repo parsing --------------------------------------------------- #

# Matches both remote URL forms git can hand back for a GitHub origin:
#   https://github.com/owner/repo(.git)
#   git@github.com:owner/repo(.git)
# Mirrors apps/console/.../failures/[failureId]/github-slug.ts#parseGithubSlug
# so a repo normalizes the same way on both sides of the stack.
_GITHUB_REMOTE_RE = re.compile(r"github\.com[/:]([^/]+)/([^/]+?)(?:\.git)?/?$")


def parse_repo_slug(url: str) -> Optional[str]:
    """Normalize a GitHub remote URL (https or ssh) to a lowercase
    ``owner/repo`` slug. ``None`` for anything that isn't a recognizable
    GitHub remote (a different host, a local path, empty/blank) — the caller
    treats that as "nothing to quarantine-check", not an error.
    """
    if not url:
        return None
    m = _GITHUB_REMOTE_RE.search(url.strip())
    if not m:
        return None
    owner, repo = m.group(1), m.group(2)
    if not owner or not repo:
        return None
    return f"{owner}/{repo}".lower()


# --- DB read edge ---------------------------------------------------------- #

# Op names issued against the Executor. Registered into the shared
# PostgresExecutor SQL map below. Deliberately unscoped by workspace_id (unlike
# connectors_store's CONNECTORS_OP) — this module's whole job is to search
# ACROSS every workspace for a repo, so the workspace_id filter (excluding the
# operator's own) happens in Python, in resolve_foreign_workspaces below.
HOSTED_CONNECTORS_OP = "list_enabled_github_connector_configs"
HOSTED_REPOSITORIES_OP = "list_all_repositories"

HOSTED_REPO_SQL: Dict[str, str] = {
    HOSTED_CONNECTORS_OP: (
        "SELECT workspace_id, config FROM connectors "
        "WHERE provider = 'github' AND enabled = true"
    ),
    HOSTED_REPOSITORIES_OP: "SELECT workspace_id, name, url FROM repositories",
}

# Register into the shared SQL map so PostgresExecutor.query can resolve it.
queue_store._SQL.update(HOSTED_REPO_SQL)


class _Reader(Protocol):
    def query(self, op: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:  # pragma: no cover
        ...


def _coerce_config(raw: Any) -> Dict[str, Any]:
    """Coerce a stored jsonb ``connectors.config`` to a dict — it may arrive as
    a JSON string depending on driver/version (same defensive shape as
    ``connectors_store._parse_config``, duplicated locally rather than
    cross-imported so this seam module stays self-contained).
    """
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            return {}
    return raw if isinstance(raw, dict) else {}


def find_hosted_workspaces(repo_slug: str, executor: _Reader) -> List[str]:
    """Every workspace id whose connected repos include ``repo_slug``
    (``owner/repo``, any case), across BOTH the github connector's
    ``config.repos`` and the ``repositories`` table. Sorted, de-duplicated.
    Does not know about (and never excludes) the operator's own workspace —
    that filtering is the caller's job (``resolve_foreign_workspaces``).

    Thin wrapper over :func:`_find_hosted_workspaces_degrading` (which is the
    one that actually runs each source behind its own try/except) that drops
    the failed-sources list — for callers that only need the hit list itself.
    """
    hits, _failed = _find_hosted_workspaces_degrading(repo_slug, executor)
    return hits


def _find_hosted_workspaces_degrading(
    repo_slug: str, executor: _Reader
) -> Tuple[List[str], List[str]]:
    """Same lookup as :func:`find_hosted_workspaces`, but the two sources —
    the github connector's ``config.repos``, the ``repositories`` table —
    each run behind their OWN try/except, mirroring
    ``agentrail.cli.commands.issue._resolve_workspace_connection``'s
    per-lookup try/except (issue.py:256-268), instead of one try/except
    wrapped around both. That distinction matters: with a single shared
    try/except, a hit the connectors query already found could be discarded
    just because the unrelated repositories query blew up afterwards — the
    guard would fail OPEN even though the DB had already proven the repo
    hosted.

    Returns ``(hits, failed_sources)``. ``failed_sources`` names whichever
    quer(y/ies) raised (``"connectors"``, ``"repositories"``), so the caller
    (:func:`resolve_foreign_workspaces`) can tell apart:
      - both sources down — nothing was actually checked, fail open exactly
        like a hard connection failure;
      - one source down but the OTHER still found a hit — a proven hosted
        match must never be thrown away, so this refuses, no notice needed;
      - one source down and the survivor found nothing — fail open, but say
        so distinctly, since this isn't a clean "no match" (coverage was
        reduced).
    """
    target = repo_slug.strip().lower()
    hits: set = set()
    failed: List[str] = []

    try:
        connector_rows = executor.query(HOSTED_CONNECTORS_OP, {})
    except Exception:
        connector_rows = []
        failed.append("connectors")

    for row in connector_rows:
        cfg = _coerce_config(row.get("config"))
        repos = cfg.get("repos")
        if not isinstance(repos, list):
            continue
        for r in repos:
            if isinstance(r, str) and r.strip().lower() == target:
                ws = row.get("workspace_id")
                if ws:
                    hits.add(str(ws))
                break

    try:
        repository_rows = executor.query(HOSTED_REPOSITORIES_OP, {})
    except Exception:
        repository_rows = []
        failed.append("repositories")

    for row in repository_rows:
        name = str(row.get("name") or "").strip().lower()
        slug = name if name == target else parse_repo_slug(str(row.get("url") or ""))
        if slug == target:
            ws = row.get("workspace_id")
            if ws:
                hits.add(str(ws))

    return sorted(hits), failed


def resolve_foreign_workspaces(
    repo_slug: str,
    *,
    own_workspace_id: Optional[str],
    executor: Optional[_Reader] = None,
) -> Tuple[List[str], Optional[str]]:
    """Return ``(foreign_workspace_ids, db_notice)`` for ``repo_slug``.

    ``foreign_workspace_ids``: workspace ids OTHER than ``own_workspace_id``
    whose connected repos include ``repo_slug``. Empty when no such workspace
    exists, when the DB couldn't be consulted at all, or when exactly one
    lookup degraded and the surviving lookup found nothing.

    ``db_notice``: a one-line, stderr-worthy message, or ``None`` — which is
    returned both when the query actually ran and found nothing AND when a
    hit was found (a proven match always drives a refusal, even if the OTHER
    lookup happened to fail — see :func:`_find_hosted_workspaces_degrading`).
    Two distinct fail-open notices are possible instead:
      - ``"hosted-repo quarantine check skipped: no database reachable"`` —
        the connection itself failed, or BOTH lookups raised, so nothing was
        actually checked;
      - ``"hosted-repo quarantine check partial: <source> unavailable"`` —
        exactly one lookup raised and the other found no hit, so the check
        proceeded on reduced coverage rather than a clean, complete "no
        match".

    Design (fail OPEN on no DB, not closed): AFK is operator-run dogfood
    tooling — a self-hosted runner or a developer's laptop with no reachable
    hosted ``DATABASE_URL`` carries no hosted-customer data on it to protect in
    the first place, so there is nothing for a "quarantine" to guard here.
    Failing CLOSED in that situation would break every self-host/dev user's
    plain ``agentrail afk`` run for a protection that does not apply to them.
    So, exactly like ``agentrail.cli.commands.issue._resolve_workspace_connection``,
    ANY failure to reach the DB degrades to "proceed" (with a notice) rather
    than raising or refusing. This is a controller-resolved decision, not an
    oversight — see #1271.
    """
    try:
        if executor is None:
            from agentrail.afk.queue_store import PostgresExecutor

            executor = PostgresExecutor()
        hits, failed = _find_hosted_workspaces_degrading(repo_slug, executor)
    except Exception:
        return [], "hosted-repo quarantine check skipped: no database reachable"

    foreign = [w for w in hits if w != own_workspace_id]

    if len(failed) >= 2:
        # Both sources raised: nothing was actually checked — identical
        # fail-open to a hard connection failure above.
        return [], "hosted-repo quarantine check skipped: no database reachable"

    if failed and not foreign:
        # Exactly one source degraded and the survivor found no foreign hit:
        # proceed, but don't let this look like a clean "nothing found" —
        # coverage was reduced.
        return [], f"hosted-repo quarantine check partial: {failed[0]} unavailable"

    return foreign, None
