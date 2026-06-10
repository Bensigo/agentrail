"""
``agentrail link`` — link this repository to an AgentRail workspace.

Usage:
  agentrail link --workspace <ws_id> --repo <repo_id> --key ar_...
                 [--base-url <url>] [--force]

Posts to {base_url}/api/v1/cli/link with the API key as a Bearer token.
On success writes .agentrail/server.json with base_url, workspace_id,
repository_id, and api_key.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path
from typing import List

# Base URL precedence: --base-url flag > $AGENTRAIL_BASE_URL > localhost default.
# No hardcoded production host — the console URL is environment-specific.
DEFAULT_BASE_URL = os.environ.get("AGENTRAIL_BASE_URL", "http://localhost:3000")
SERVER_JSON = ".agentrail/server.json"


def _usage() -> str:
    return """Usage:
  agentrail link --workspace <ws_id> --repo <repo_id> --key ar_...
                 [--base-url <url>] [--force]

Options:
  --workspace  Workspace ID (UUID)
  --repo       Repository ID (UUID)
  --key        API key (ar_...)
  --base-url   Server base URL (overrides $AGENTRAIL_BASE_URL;
               default http://localhost:3000)
  --force      Overwrite an existing .agentrail/server.json
"""


def _find_server_json(cwd: Path) -> Path:
    return cwd / SERVER_JSON


def run_link(args: List[str]) -> int:
    workspace_id: str | None = None
    repo_id: str | None = None
    api_key: str | None = None
    base_url: str = DEFAULT_BASE_URL
    force: bool = False

    i = 0
    while i < len(args):
        a = args[i]
        if a in ("-h", "--help"):
            print(_usage())
            return 0
        elif a == "--workspace":
            i += 1
            if i >= len(args):
                print("error: --workspace requires a value", file=sys.stderr)
                return 1
            workspace_id = args[i]
        elif a == "--repo":
            i += 1
            if i >= len(args):
                print("error: --repo requires a value", file=sys.stderr)
                return 1
            repo_id = args[i]
        elif a == "--key":
            i += 1
            if i >= len(args):
                print("error: --key requires a value", file=sys.stderr)
                return 1
            api_key = args[i]
        elif a == "--base-url":
            i += 1
            if i >= len(args):
                print("error: --base-url requires a value", file=sys.stderr)
                return 1
            base_url = args[i].rstrip("/")
        elif a == "--force":
            force = True
        else:
            print(f"unknown option: {a}", file=sys.stderr)
            print(_usage(), file=sys.stderr)
            return 1
        i += 1

    missing = [
        flag
        for flag, val in (
            ("--workspace", workspace_id),
            ("--repo", repo_id),
            ("--key", api_key),
        )
        if not val
    ]
    if missing:
        print(f"error: missing required option(s): {', '.join(missing)}", file=sys.stderr)
        print(_usage(), file=sys.stderr)
        return 1

    # AC3: refuse to overwrite unless --force
    cwd = Path.cwd()
    server_json = _find_server_json(cwd)
    if server_json.exists() and not force:
        try:
            existing = json.loads(server_json.read_text())
            existing_ws = existing.get("workspace_id", "?")
            existing_repo = existing.get("repository_id", "?")
        except Exception:
            existing_ws = "?"
            existing_repo = "?"
        print(
            f"error: .agentrail/server.json already exists "
            f"(workspace={existing_ws}, repo={existing_repo}). "
            f"Pass --force to overwrite.",
            file=sys.stderr,
        )
        return 1

    # AC1: POST to /api/v1/cli/link with Bearer auth
    url = f"{base_url}/api/v1/cli/link"
    payload = json.dumps(
        {"workspace_id": workspace_id, "repository_id": repo_id}
    ).encode()
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )

    try:
        with urllib.request.urlopen(req) as resp:
            status = resp.status
            body = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        status = e.code
        try:
            body = json.loads(e.read().decode())
            server_msg = body.get("error", str(e.reason))
        except Exception:
            server_msg = str(e.reason)
        # AC2: single-line error, exit non-zero
        print(f"link failed: HTTP {status} — {server_msg}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"link failed: {e}", file=sys.stderr)
        return 1

    if status != 200:
        server_msg = body.get("error", "unknown error") if isinstance(body, dict) else "unknown error"
        print(f"link failed: HTTP {status} — {server_msg}", file=sys.stderr)
        return 1

    # Write .agentrail/server.json
    server_json.parent.mkdir(parents=True, exist_ok=True)
    config = {
        "base_url": base_url,
        "workspace_id": workspace_id,
        "repository_id": repo_id,
        "api_key": api_key,
    }
    server_json.write_text(json.dumps(config, indent=2))

    ws_name = body.get("workspace", {}).get("name", workspace_id) if isinstance(body, dict) else workspace_id
    repo_name = body.get("repository", {}).get("name", repo_id) if isinstance(body, dict) else repo_id
    print(f"linked: workspace={ws_name}, repo={repo_name}")
    print(f"config written to {server_json}")
    return 0
