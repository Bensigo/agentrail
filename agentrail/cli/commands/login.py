"""``agentrail login`` — sign this machine into an AgentRail workspace.

The deployed dashboard is where the user signed up; this command links the
*downloaded CLI* to that account with zero manual setup. It runs the OAuth
device flow (RFC 8628): we print a short code + URL, the user approves in the
browser they're already signed into, and we persist the returned runner token
to ``~/.agentrail/credentials.json``. After this, ``agentrail runner`` just
works — no DB URL, no API key, no config files to edit.

  agentrail login [--url <base_url>]
  agentrail logout
  agentrail whoami
"""
from __future__ import annotations

import os
import sys
import time
import webbrowser
from pathlib import Path
from typing import List

from agentrail.runner.credentials import (
    Credentials,
    load_credentials,
    save_credentials,
)
from agentrail.runner.login import DeviceAuthError, run_device_login

# Same precedence as `agentrail link`: --url flag > $AGENTRAIL_BASE_URL > local.
DEFAULT_BASE_URL = os.environ.get("AGENTRAIL_BASE_URL", "http://localhost:3000")


def _prompt(user_code: str, verification_uri: str) -> None:
    print()
    print("  To finish signing in, open this page in your browser:")
    print(f"    {verification_uri}")
    print(f"  and enter the code:  {user_code}")
    print()
    print("  Waiting for approval…")
    # Best-effort: pop the browser so the user doesn't even have to copy the URL.
    try:
        webbrowser.open(verification_uri)
    except Exception:  # noqa: BLE001 — never fail login over a browser launch
        pass


def run_login(args: List[str]) -> int:
    base_url = DEFAULT_BASE_URL
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("-h", "--help"):
            print(__doc__)
            return 0
        if a == "--url":
            i += 1
            if i >= len(args):
                print("error: --url requires a value", file=sys.stderr)
                return 1
            base_url = args[i].rstrip("/")
        else:
            print(f"unknown option: {a}", file=sys.stderr)
            return 1
        i += 1

    print(f"Signing in to {base_url}…")
    try:
        creds = run_device_login(
            base_url=base_url,
            sleep=time.sleep,
            on_prompt=_prompt,
        )
    except DeviceAuthError as exc:
        print(f"login failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"login failed: {exc}", file=sys.stderr)
        return 1

    path = save_credentials(creds)
    print(f"✓ Logged in to workspace {creds.workspace_id}.")
    print(f"  Credentials saved to {path}.")
    print("  Run `agentrail runner` to start executing your queued issues locally.")
    return 0


def run_logout(args: List[str]) -> int:
    path = Path.home() / ".agentrail" / "credentials.json"
    if path.exists():
        path.unlink()
        print("✓ Logged out.")
    else:
        print("Not logged in.")
    return 0


def run_whoami(args: List[str]) -> int:
    creds = load_credentials()
    if creds is None:
        print("Not logged in. Run `agentrail login`.", file=sys.stderr)
        return 1
    print(f"Logged in to {creds.base_url} (workspace {creds.workspace_id}).")
    return 0
