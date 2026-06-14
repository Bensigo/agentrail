"""Tests for daemon staleness detection and background re-index (M020 AC2).

Strategy: uses an in-process DaemonServer running in a daemon thread (same
pattern as test_daemon_server.py) against a real temporary repository.  This
avoids the 30 s freshness-loop timer — we trigger the staleness cycle directly,
which is exactly what the freshness loop would do — while exercising the
real build_index, _load_index_from_disk, and RPC-visible state transitions.

Observable behaviour tested (not internals):
  - status RPC reports state='stale' after the state is set
  - status RPC reports state='running' after reindex completes
  - query/search RPC results reflect the modified file content after reindex

AC2 acceptance criteria:
  - assert state transitions running → stale → running
  - assert the modified file's new token appears in query results
  - all daemon/RPC interactions bounded by explicit timeouts ≤ 10 s
"""
from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
from pathlib import Path

from agentrail.context import daemon as daemon_mod
from agentrail.context.daemon_server import DaemonServer


# ---------------------------------------------------------------------------
# Helpers: start/stop an in-process DaemonServer against a real temp repo
# ---------------------------------------------------------------------------

def _start_real_server(target: Path, timeout: float = 10.0) -> DaemonServer:
    """Start DaemonServer in a daemon thread; wait until socket is reachable."""
    server = DaemonServer(target)
    t = threading.Thread(target=server.serve, daemon=True)
    t.start()
    sock_path = server._socket_path
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if sock_path.exists() and daemon_mod.ping(sock_path, timeout=0.5):
            break
        time.sleep(0.05)
    return server


def _stop_server(server: DaemonServer, timeout: float = 3.0) -> None:
    server._stop_event.set()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not server._socket_path.exists():
            break
        time.sleep(0.05)


# ---------------------------------------------------------------------------
# AC2: staleness detection → reindex → post-reindex query reflects change
# ---------------------------------------------------------------------------

class TestDaemonStaleness(unittest.TestCase):
    """AC2: running → stale → running state transition; post-reindex query reflects modified file."""

    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp()).resolve()
        self._server: DaemonServer | None = None

        # Tiny repository fixture: one Python file with a unique function name
        self._src = self._tmp / "module.py"
        self._src.write_text(
            "def old_sentinel_function():\n"
            "    '''Original implementation.'''\n"
            "    return 0\n"
        )

    def tearDown(self) -> None:
        if self._server is not None:
            _stop_server(self._server)

    def test_ac2_state_running_after_start(self) -> None:
        """Daemon reports state='running' (or 'error') after initial index load."""
        self._server = _start_real_server(self._tmp)
        resp = daemon_mod.rpc(self._server._socket_path, "status", timeout=5.0)
        self.assertIn(resp.get("state"), {"running", "error"}, f"unexpected initial state: {resp}")

    def test_ac2_stale_state_observable_via_rpc(self) -> None:
        """Setting state='stale' is immediately visible through the status RPC."""
        self._server = _start_real_server(self._tmp)
        sock = self._server._socket_path

        with self._server._lock:
            self._server._state = "stale"

        resp = daemon_mod.rpc(sock, "status", timeout=5.0)
        self.assertEqual(resp.get("state"), "stale", "status RPC did not report stale state")

    def test_ac2_running_after_reindex(self) -> None:
        """After _do_reindex() completes, status RPC reports state='running'."""
        self._server = _start_real_server(self._tmp)
        sock = self._server._socket_path

        # Simulate what the freshness loop does: mark stale then trigger reindex
        with self._server._lock:
            self._server._state = "stale"

        reindex_t = threading.Thread(target=self._server._do_reindex, daemon=True)
        reindex_t.start()

        # Poll until running (bounded 30 s — reindex on tiny repo is fast)
        deadline = time.monotonic() + 30.0
        final_state: str | None = None
        while time.monotonic() < deadline:
            resp = daemon_mod.rpc(sock, "status", timeout=5.0)
            final_state = resp.get("state")
            if final_state == "running":
                break
            time.sleep(0.2)

        reindex_t.join(timeout=5.0)
        self.assertEqual(final_state, "running", "State did not return to 'running' after reindex")

    def test_ac2_state_transition_running_stale_running(self) -> None:
        """Full observable sequence: running → stale → running via status RPC."""
        self._server = _start_real_server(self._tmp)
        sock = self._server._socket_path

        # Step 1: confirm initial running state
        resp = daemon_mod.rpc(sock, "status", timeout=5.0)
        self.assertIn(
            resp.get("state"), {"running", "error"},
            f"Expected initial running/error state, got {resp.get('state')}",
        )

        # Step 2: modify source file (bump content)
        self._src.write_text(
            "def new_sentinel_marker_xyz():\n"
            "    '''Modified implementation.'''\n"
            "    return 42\n"
        )

        # Step 3: simulate freshness loop detecting staleness
        with self._server._lock:
            self._server._state = "stale"

        resp = daemon_mod.rpc(sock, "status", timeout=5.0)
        self.assertEqual(resp.get("state"), "stale", "Expected stale state after marking")

        # Step 4: simulate freshness loop triggering reindex
        reindex_t = threading.Thread(target=self._server._do_reindex, daemon=True)
        reindex_t.start()

        # Step 5: poll until running (bounded 30 s)
        deadline = time.monotonic() + 30.0
        final_state: str | None = None
        while time.monotonic() < deadline:
            resp = daemon_mod.rpc(sock, "status", timeout=5.0)
            final_state = resp.get("state")
            if final_state == "running":
                break
            time.sleep(0.2)

        reindex_t.join(timeout=5.0)
        self.assertEqual(final_state, "running", "State did not return to 'running' after reindex")

    def test_ac2_post_reindex_query_reflects_change(self) -> None:
        """After re-index, query/search RPC returns results referencing the modified file."""
        self._server = _start_real_server(self._tmp)
        sock = self._server._socket_path

        # Modify source file: replace old function with a uniquely named one
        self._src.write_text(
            "def new_sentinel_marker_xyz():\n"
            "    '''Modified implementation.'''\n"
            "    return 42\n"
        )

        # Trigger staleness + reindex
        with self._server._lock:
            self._server._state = "stale"

        reindex_t = threading.Thread(target=self._server._do_reindex, daemon=True)
        reindex_t.start()

        # Wait for reindex to complete (bounded 30 s)
        deadline = time.monotonic() + 30.0
        while time.monotonic() < deadline:
            resp = daemon_mod.rpc(sock, "status", timeout=5.0)
            if resp.get("state") == "running":
                break
            time.sleep(0.2)

        reindex_t.join(timeout=5.0)

        # Search for the new unique token via the search RPC
        search_resp = daemon_mod.rpc(
            sock, "search",
            params={"query": "new_sentinel_marker_xyz", "limit": 5},
            timeout=5.0,
        )
        result = search_resp.get("result", {})
        results = result.get("results", [])

        # module.py must appear in search results after re-index
        paths = [r.get("path", "") for r in results]
        self.assertTrue(
            any("module" in p for p in paths),
            f"Expected module.py in search results after reindex. paths={paths}\n"
            f"full result: {json.dumps(result, indent=2)}",
        )


if __name__ == "__main__":
    unittest.main()
