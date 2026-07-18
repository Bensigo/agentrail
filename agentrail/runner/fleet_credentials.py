"""The hosted fleet's multi-workspace token store.

``agentrail runner`` (see :mod:`agentrail.runner.credentials`) is one machine,
one login, one workspace, forever — ``~/.agentrail/credentials.json`` holds
exactly one ``Credentials``. The fleet is the opposite shape: ONE process
serves every hosted-eligible workspace at once, so it needs a token PER
workspace, minted for it (never by a human clicking through ``/activate`` —
see :mod:`agentrail.runner.fleet_sync`) and kept in sync with the console's
``hosted_execution`` flag.

This module is deliberately just the on-disk store: load/merge/save. It knows
nothing about HTTP (:mod:`agentrail.runner.fleet_sync` calls the sync route and
hands this module the result) or the claim loop
(:mod:`agentrail.runner.fleet_worker` reads the store to build per-workspace
clients).

Storage: one JSON file, ``fleet-credentials.json``, in
``AGENTRAIL_FLEET_HOME`` (default ``~/.agentrail`` — deliberately the SAME
directory ``agentrail login`` writes ``credentials.json`` into; a distinct
filename avoids collision, and reusing the directory means the Railway volume
that would already be mounted at ``~/.agentrail`` for a single-workspace
runner covers the fleet's store for free). Tokens are secrets: the file is
written ``0600`` (owner-only), same discipline as
:mod:`agentrail.runner.credentials`, and additionally via a temp-file +
``os.replace`` so a concurrent reader (the claim loop, refreshing on its own
schedule) can never observe a half-written file — a stronger guarantee than
the single-workspace store needs, because that one is written once at login
and this one is rewritten on every sync cycle while the claim loop keeps
running.
"""
from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional

FLEET_CREDENTIALS_FILENAME = "fleet-credentials.json"

# Documented in agentrail/cli/commands/fleet.py's --help/README; read here too
# so tests and any other caller share one literal.
FLEET_HOME_ENV = "AGENTRAIL_FLEET_HOME"


@dataclass(frozen=True)
class FleetWorkspaceToken:
    """One hosted-eligible workspace's fleet bearer token.

    ``token`` is the raw secret (an ``api_keys`` row's bearer, ``kind:
    'fleet'``) — never log it, never put it in an exception message.
    """

    workspace_id: str
    slug: str
    token: str


def _fleet_home(home: Optional[Path]) -> Path:
    if home is not None:
        return home
    env_home = os.environ.get(FLEET_HOME_ENV)
    if env_home:
        return Path(env_home).expanduser()
    return Path.home() / ".agentrail"


def _path(home: Optional[Path]) -> Path:
    return _fleet_home(home) / FLEET_CREDENTIALS_FILENAME


def load_fleet_store(*, home: Optional[Path] = None) -> Dict[str, FleetWorkspaceToken]:
    """Return ``{workspace_id: FleetWorkspaceToken}``, or ``{}`` if unreadable.

    A missing file, corrupt JSON, or a malformed shape all degrade to an empty
    store rather than raising — the same fail-open posture
    :func:`agentrail.runner.credentials.load_credentials` takes for a corrupt
    single-workspace file. The caller (the boot/periodic sync) treats an empty
    store as "nothing known yet," not as an error.
    """
    path = _path(home)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
    except (ValueError, OSError):
        return {}
    workspaces = data.get("workspaces") if isinstance(data, dict) else None
    if not isinstance(workspaces, dict):
        return {}
    out: Dict[str, FleetWorkspaceToken] = {}
    for ws_id, entry in workspaces.items():
        if not isinstance(entry, dict):
            continue
        token = entry.get("token")
        if not isinstance(token, str) or not token:
            continue
        slug = entry.get("slug")
        out[str(ws_id)] = FleetWorkspaceToken(
            workspace_id=str(ws_id),
            slug=str(slug) if isinstance(slug, str) else "",
            token=token,
        )
    return out


def save_fleet_store(
    store: Dict[str, FleetWorkspaceToken], *, home: Optional[Path] = None
) -> Path:
    """Atomically overwrite the fleet token store (temp file + rename, 0600).

    ``os.replace`` is an atomic filesystem rename on POSIX and Windows alike,
    so a reader either sees the OLD complete file or the NEW complete file —
    never a partial write. The temp file is created in the SAME directory
    (required for ``os.replace`` to be atomic — a cross-filesystem rename is
    not) and chmod'd 0600 BEFORE the rename, so the token payload is never
    briefly world/group-readable.
    """
    path = _path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "workspaces": {
            ws_id: {"token": tok.token, "slug": tok.slug}
            for ws_id, tok in store.items()
        }
    }
    fd, tmp_name = tempfile.mkstemp(
        prefix=".fleet-credentials-", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(payload, f, indent=2)
        os.chmod(tmp_name, 0o600)
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    return path
