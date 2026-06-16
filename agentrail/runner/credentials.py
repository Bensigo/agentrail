"""Machine-scoped runner credentials — what ``agentrail login`` writes.

One file per machine at ``~/.agentrail/credentials.json`` holding where the
backend is and the login token to authenticate as. The runner reads it to know
how to ``claim``/``report``. This is deliberately separate from the per-repo
``.agentrail/server.json`` (``agentrail link``): login is about the *account*,
link is about a *repo*.

The token is a secret, so the file is written ``0600`` (owner-only).
"""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional

CREDENTIALS_RELPATH = (".agentrail", "credentials.json")


@dataclass(frozen=True)
class Credentials:
    base_url: str
    token: str
    workspace_id: str


def _home(home: Optional[Path]) -> Path:
    return home if home is not None else Path.home()


def _path(home: Optional[Path]) -> Path:
    return _home(home).joinpath(*CREDENTIALS_RELPATH)


def save_credentials(creds: Credentials, *, home: Optional[Path] = None) -> Path:
    """Write credentials to ``~/.agentrail/credentials.json`` (mode 0600)."""
    creds = Credentials(
        base_url=creds.base_url.rstrip("/"),
        token=creds.token,
        workspace_id=creds.workspace_id,
    )
    path = _path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(asdict(creds), indent=2))
    os.chmod(path, 0o600)
    return path


def load_credentials(*, home: Optional[Path] = None) -> Optional[Credentials]:
    """Return saved credentials, or ``None`` if not logged in / unreadable."""
    path = _path(home)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
        return Credentials(
            base_url=str(data["base_url"]).rstrip("/"),
            token=str(data["token"]),
            workspace_id=str(data["workspace_id"]),
        )
    except (KeyError, ValueError, OSError):
        return None
