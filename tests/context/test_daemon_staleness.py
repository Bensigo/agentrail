"""Tests for daemon staleness detection and background re-index (issue #596, AC2).

Strategy: start the real daemon against a temp repo with a fast freshness
interval (AGENTRAIL_DAEMON_FRESHNESS_INTERVAL=2 s), modify a source file so
that its mtime > index.json mtime, poll `status` until state transitions
running → stale → running, then assert the modified content is queryable.

All subprocess interactions have explicit timeouts ≤ 10 s.  The poll loop uses
a 60 s ceiling as specified in the issue.  Teardown always kills the daemon.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from agentrail.context import daemon as daemon_mod
from agentrail.context.index import build_index


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_staleness_repo() -> Path:
    """Create a temp repo with a pre-built, age-stamped index.

    The repo is set up so that any file write after daemon start will produce a
    mtime clearly newer than index.json, guaranteeing stale detection on the
    next freshness loop iteration regardless of system clock resolution.

    Design:
    - Pre-build the index (so daemon startup's build_index is a no-op).
    - Set ALL source files and index artifacts to a mtime 60 s in the past.
    - When the test writes a source file, its mtime = now >> aged index mtime,
      making staleness detection deterministic.
    """
    root = Path(tempfile.mkdtemp()).resolve()
    (root / ".agentrail").mkdir()
    cfg = {
        "schemaVersion": 1,
        "context": {
            "includeGlobs": ["**/*.py"],
            "excludeGlobs": [".git/**", ".agentrail/**"],
            "maxFileSizeBytes": 262144,
            "skipBinary": True,
            "respectGitIgnore": False,
            "secretRedaction": {"enabled": False, "action": "exclude", "denyGlobs": []},
            "embedding": {"mode": "disabled", "provider": None, "model": None},
            "summary": {"mode": "disabled", "provider": None, "model": None},
        },
    }
    (root / ".agentrail" / "config.json").write_text(
        json.dumps(cfg), encoding="utf-8"
    )
    (root / "src").mkdir()
    (root / "src" / "base.py").write_text(
        "def base_function():\n    return 0\n", encoding="utf-8"
    )

    # Pre-build the index so the daemon's startup build_index is a no-op.
    build_index(root)

    # Age ALL files under root to 60 s in the past.  This ensures that any
    # write the test performs after daemon startup has mtime = now >> 60 s ago,
    # giving a clear staleness signal on the very next freshness loop tick.
    old_mtime = time.time() - 60.0
    for p in root.rglob("*"):
        if p.is_file():
            try:
                os.utime(p, (old_mtime, old_mtime))
            except OSError:
                pass

    return root


def _poll_state(sock: Path, target_state: str, deadline: float, interval: float = 0.05) -> bool:
    """Poll daemon status until state == target_state or deadline expires.

    Uses a 50 ms default interval so brief transient states (like 'stale'
    during a fast single-file reindex) are reliably caught.
    """
    while time.monotonic() < deadline:
        try:
            resp = daemon_mod.rpc(sock, "status", timeout=5.0)
            if resp.get("state") == target_state:
                return True
        except (OSError, TimeoutError, ValueError):
            pass
        time.sleep(interval)
    return False


def _poll_until_reindexed(sock: Path, initial_indexed_at: str | None, deadline: float) -> bool:
    """Poll until lastIndexedAt changes from initial_indexed_at (reindex occurred)."""
    while time.monotonic() < deadline:
        try:
            resp = daemon_mod.rpc(sock, "status", timeout=5.0)
            current = resp.get("lastIndexedAt")
            if current is not None and current != initial_indexed_at:
                return True
        except (OSError, TimeoutError, ValueError):
            pass
        time.sleep(0.2)
    return False


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestDaemonStaleness(unittest.TestCase):
    """AC2: state transitions running → stale → running after a source edit."""

    def setUp(self) -> None:
        self._tmp = _make_staleness_repo()
        self._sock = daemon_mod.socket_path_for(self._tmp)
        self._proc: subprocess.Popen | None = None
        self._sock.unlink(missing_ok=True)

    def tearDown(self) -> None:
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
        self._sock.unlink(missing_ok=True)
        import shutil
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _spawn(self, interval: float = 2.0) -> None:
        env = os.environ.copy()
        env["AGENTRAIL_DAEMON_FRESHNESS_INTERVAL"] = str(interval)
        self._proc = subprocess.Popen(
            [
                sys.executable, "-m", "agentrail.context.daemon_server",
                "--target", str(self._tmp),
            ],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def test_state_transitions_to_stale_after_file_modify(self) -> None:
        """AC2: state goes from running → stale when a source file is bumped.

        The repo fixture ages all files to 60 s in the past so that any write
        the test performs has mtime ≈ now >> index.json mtime.  Combined with a
        10 ms poll interval, this reliably catches the transient stale state.
        """
        self._spawn(interval=2.0)
        self.assertTrue(
            daemon_mod._wait_for_socket(self._sock, timeout=10.0),
            "Daemon socket did not appear",
        )

        # Confirm initial state is running
        resp = daemon_mod.rpc(self._sock, "status", timeout=5.0)
        self.assertEqual(resp.get("state"), "running", "Expected initial state=running")

        # Write to the source file.  Because the repo fixture aged index.json to
        # 60 s ago, any write with current mtime is clearly newer.
        source_file = self._tmp / "src" / "base.py"
        source_file.write_text(
            "def base_function():\n    return 0\n\n# bumped for staleness test\n",
            encoding="utf-8",
        )

        # Poll at 10 ms interval (to catch the brief stale window).
        stale_reached = _poll_state(
            self._sock, "stale", time.monotonic() + 30.0, interval=0.01
        )
        self.assertTrue(stale_reached, "Daemon never transitioned to state=stale")

    def test_state_returns_to_running_after_reindex(self) -> None:
        """AC2: state returns to running after reindex completes."""
        self._spawn(interval=2.0)
        self.assertTrue(daemon_mod._wait_for_socket(self._sock, timeout=10.0))

        initial_resp = daemon_mod.rpc(self._sock, "status", timeout=5.0)
        initial_indexed_at = initial_resp.get("lastIndexedAt")

        # Write to the source file (current mtime >> aged index.json mtime).
        source_file = self._tmp / "src" / "base.py"
        source_file.write_text(
            "def base_function():\n    return 0\n\n# bumped for reindex test\n",
            encoding="utf-8",
        )

        # Catch the brief stale window with a fast 10 ms poll.
        stale_reached = _poll_state(
            self._sock, "stale", time.monotonic() + 30.0, interval=0.01
        )
        self.assertTrue(stale_reached, "Never reached stale")

        # Wait for running (reindex complete) — use lastIndexedAt change as
        # a robust signal that a full reindex cycle occurred.
        reindexed = _poll_until_reindexed(
            self._sock, initial_indexed_at, time.monotonic() + 60.0
        )
        self.assertTrue(reindexed, "lastIndexedAt did not change — reindex may not have completed")

        resp = daemon_mod.rpc(self._sock, "status", timeout=5.0)
        self.assertEqual(
            resp.get("state"), "running", "Expected state=running after reindex"
        )

    def test_post_reindex_query_reflects_modified_file(self) -> None:
        """AC2: a unique token added between reindex cycles appears in query results."""
        unique_token = "STALENESS_TEST_SENTINEL_XZ99"
        self._spawn(interval=2.0)
        self.assertTrue(daemon_mod._wait_for_socket(self._sock, timeout=10.0))

        # Capture the initial lastIndexedAt so we can detect the reindex.
        initial_resp = daemon_mod.rpc(self._sock, "status", timeout=5.0)
        initial_indexed_at = initial_resp.get("lastIndexedAt")

        # Write a new file with the unique token (fingerprint change → reliably stale).
        new_file = self._tmp / "src" / "new_feature.py"
        new_file.write_text(
            f"def new_feature():\n    \"\"\"Contains {unique_token}.\"\"\"\n    return 1\n",
            encoding="utf-8",
        )

        # Wait for a completed reindex: lastIndexedAt must change from the initial
        # value.  This is more reliable than catching the brief stale window.
        reindexed = _poll_until_reindexed(
            self._sock, initial_indexed_at, time.monotonic() + 60.0
        )
        self.assertTrue(
            reindexed,
            "lastIndexedAt did not change within 60 s — reindex did not occur",
        )

        # State must be running after the reindex settles.
        resp = daemon_mod.rpc(self._sock, "status", timeout=5.0)
        self.assertEqual(resp.get("state"), "running", "Expected state=running after reindex")

        # Query the daemon for the unique token via RPC.
        resp = daemon_mod.rpc(
            self._sock,
            "query",
            timeout=10.0,
            params={"query": unique_token, "limit": 10},
        )
        result = resp.get("result", {})
        results = result.get("results", [])
        citations = [r.get("citation", "") for r in results]
        found = any("new_feature" in c for c in citations) or any(
            unique_token in json.dumps(r) for r in results
        )
        self.assertTrue(
            found,
            f"Unique token {unique_token!r} not found in post-reindex query results.\n"
            f"Citations: {citations}",
        )


if __name__ == "__main__":
    unittest.main()
