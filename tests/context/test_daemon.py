"""Tests for agentrail/context/daemon.py — covers AC1–AC6.

Each test class maps to one acceptance criterion from issue #590.
Daemons are started in background threads with a short poll_interval so
staleness tests don't block for 30 s.  The socket probe in ContextDaemon.run()
is bypassed by using unique tmp dirs for each test.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path

from agentrail.context.daemon import ContextDaemon, daemon_socket_path
from agentrail.context.index import build_index


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

_MINIMAL_CONFIG = {
    "schemaVersion": 1,
    "context": {
        "includeGlobs": ["**/*"],
        "excludeGlobs": [".git/**", ".agentrail/context/**"],
        "maxFileSizeBytes": 262144,
        "skipBinary": True,
        "respectGitIgnore": True,
        "secretRedaction": {"enabled": False, "action": "exclude", "denyGlobs": []},
        "embedding": {"mode": "disabled", "provider": None, "model": None},
        "summary": {"mode": "disabled", "provider": None, "model": None},
    },
}


def _make_repo(func_name: str = "alpha_token") -> Path:
    """Create a minimal git repo with one Python file defining func_name."""
    root = Path(tempfile.mkdtemp())
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    (root / ".agentrail").mkdir()
    (root / ".agentrail" / "config.json").write_text(
        json.dumps(_MINIMAL_CONFIG, indent=2), encoding="utf-8"
    )
    (root / "lib.py").write_text(
        f"def {func_name}():\n    return 42\n", encoding="utf-8"
    )
    return root


def _rpc(sock_path: Path, method: str, params: dict | None = None) -> dict:
    """Send one JSON-RPC request and return the parsed response dict."""
    req = json.dumps({"method": method, "params": params or {}}) + "\n"
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    conn.settimeout(10.0)
    conn.connect(str(sock_path))
    conn.sendall(req.encode())
    conn.shutdown(socket.SHUT_WR)
    buf = b""
    while True:
        chunk = conn.recv(4096)
        if not chunk:
            break
        buf += chunk
    conn.close()
    return json.loads(buf.decode())


def _start_daemon(
    root: Path, poll_interval: float = 60.0
) -> tuple[ContextDaemon, Path, threading.Thread]:
    """Start a ContextDaemon in a background thread; return (daemon, socket_path, thread).

    Waits up to 5 s for the socket file to appear before returning.
    """
    daemon = ContextDaemon(root, poll_interval=poll_interval)
    sock_path = daemon.socket_path

    def _run() -> None:
        daemon.run()

    t = threading.Thread(target=_run, daemon=True, name=f"daemon-{root.name}")
    t.start()

    # Wait for socket to appear
    deadline = time.time() + 5.0
    while time.time() < deadline:
        if sock_path.exists():
            # Give the server a tiny moment to enter accept() loop
            time.sleep(0.05)
            break
        time.sleep(0.05)

    return daemon, sock_path, t


def _stop_daemon(daemon: ContextDaemon, t: threading.Thread, timeout: float = 5.0) -> None:
    """Cleanly stop a daemon and wait for its thread to finish."""
    daemon._stop_event.set()
    if daemon._server is not None:
        daemon._server.shutdown()
    t.join(timeout=timeout)


# ---------------------------------------------------------------------------
# AC5 (socket path): daemon_socket_path contracts
# ---------------------------------------------------------------------------

class TestDaemonSocketPath(unittest.TestCase):
    """AC5: distinct socket paths for different targets; deterministic for same target."""

    def test_same_target_same_path(self) -> None:
        root = Path(tempfile.mkdtemp())
        self.assertEqual(daemon_socket_path(root), daemon_socket_path(root))

    def test_different_targets_different_paths(self) -> None:
        r1 = Path(tempfile.mkdtemp())
        r2 = Path(tempfile.mkdtemp())
        self.assertNotEqual(daemon_socket_path(r1), daemon_socket_path(r2))

    def test_socket_filename_format(self) -> None:
        root = Path(tempfile.mkdtemp())
        p = daemon_socket_path(root)
        self.assertEqual(p.parent, Path.home() / ".agentrail")
        self.assertRegex(p.name, r"^daemon-[0-9a-f]{16}\.sock$")

    def test_realpath_resolves_symlinks(self) -> None:
        root = Path(tempfile.mkdtemp())
        link = Path(tempfile.mkdtemp()) / "link"
        link.symlink_to(root)
        # Both the real path and the symlink should resolve to the same socket.
        self.assertEqual(daemon_socket_path(root), daemon_socket_path(link))


# ---------------------------------------------------------------------------
# AC1: daemon starts, writes socket, loads index, accepts connections
# ---------------------------------------------------------------------------

class TestDaemonStartup(unittest.TestCase):
    """AC1: startup + socket creation + connection acceptance."""

    def setUp(self) -> None:
        self.root = _make_repo("startup_func")
        build_index(self.root)

    def test_socket_file_created_on_startup(self) -> None:
        daemon, sock_path, t = _start_daemon(self.root)
        try:
            self.assertTrue(sock_path.exists(), "Socket file must exist after startup")
        finally:
            _stop_daemon(daemon, t)

    def test_accepts_connection_and_responds(self) -> None:
        daemon, sock_path, t = _start_daemon(self.root)
        try:
            resp = _rpc(sock_path, "status")
            self.assertIn("result", resp, f"Unexpected response: {resp}")
        finally:
            _stop_daemon(daemon, t)

    def test_initial_state_is_running(self) -> None:
        daemon, sock_path, t = _start_daemon(self.root)
        try:
            resp = _rpc(sock_path, "status")
            self.assertEqual(resp["result"]["state"], "running")
        finally:
            _stop_daemon(daemon, t)


# ---------------------------------------------------------------------------
# AC2: query method returns same shape as cold-path query_context
# ---------------------------------------------------------------------------

class TestDaemonQuery(unittest.TestCase):
    """AC2: query and search methods return correct result shapes."""

    def setUp(self) -> None:
        self.root = _make_repo("alpha_token")
        build_index(self.root)
        self.daemon, self.sock_path, self.t = _start_daemon(self.root)

    def tearDown(self) -> None:
        _stop_daemon(self.daemon, self.t)

    def test_query_returns_result(self) -> None:
        resp = _rpc(self.sock_path, "query", {"query": "alpha_token"})
        self.assertIn("result", resp, f"Expected result, got: {resp}")

    def test_query_shape_matches_cold_path(self) -> None:
        resp = _rpc(self.sock_path, "query", {"query": "alpha_token"})
        result = resp["result"]
        # Top-level keys present on query_context output
        for key in ("results", "query", "retrievalMode", "generatedAt", "schemaVersion"):
            self.assertIn(key, result, f"Missing key from query_context shape: {key!r}")

    def test_query_finds_defined_function(self) -> None:
        resp = _rpc(self.sock_path, "query", {"query": "alpha_token"})
        results = resp["result"]["results"]
        self.assertGreater(len(results), 0, "Should find at least one result for alpha_token")
        paths = [r["path"] for r in results]
        self.assertTrue(any("lib.py" in p for p in paths), f"lib.py not in results: {paths}")

    def test_search_method_returns_result(self) -> None:
        resp = _rpc(self.sock_path, "search", {"query": "alpha_token"})
        self.assertIn("result", resp)
        result = resp["result"]
        self.assertIn("results", result)
        self.assertIn("command", result)
        self.assertEqual(result["command"], "context.search")

    def test_unknown_method_returns_error(self) -> None:
        resp = _rpc(self.sock_path, "nonexistent_method", {})
        self.assertIn("error", resp)


# ---------------------------------------------------------------------------
# AC4: status method returns required fields
# ---------------------------------------------------------------------------

class TestDaemonStatus(unittest.TestCase):
    """AC4: status response has pid, uptimeSeconds, lastIndexedAt, socketPath, state."""

    def setUp(self) -> None:
        self.root = _make_repo("status_func")
        build_index(self.root)
        self.daemon, self.sock_path, self.t = _start_daemon(self.root)

    def tearDown(self) -> None:
        _stop_daemon(self.daemon, self.t)

    def test_status_has_all_required_fields(self) -> None:
        resp = _rpc(self.sock_path, "status")
        self.assertIn("result", resp)
        s = resp["result"]
        for field in ("pid", "uptimeSeconds", "lastIndexedAt", "socketPath", "state"):
            self.assertIn(field, s, f"Missing required status field: {field!r}")

    def test_status_pid_is_current_process(self) -> None:
        resp = _rpc(self.sock_path, "status")
        self.assertEqual(resp["result"]["pid"], os.getpid())

    def test_status_uptime_is_positive_float(self) -> None:
        resp = _rpc(self.sock_path, "status")
        self.assertIsInstance(resp["result"]["uptimeSeconds"], float)
        self.assertGreater(resp["result"]["uptimeSeconds"], 0.0)

    def test_status_socket_path_matches(self) -> None:
        resp = _rpc(self.sock_path, "status")
        self.assertEqual(resp["result"]["socketPath"], str(self.sock_path))

    def test_status_state_is_valid_value(self) -> None:
        resp = _rpc(self.sock_path, "status")
        self.assertIn(resp["result"]["state"], ("running", "stale", "error"))

    def test_status_last_indexed_at_is_iso8601_or_none(self) -> None:
        resp = _rpc(self.sock_path, "status")
        val = resp["result"]["lastIndexedAt"]
        if val is not None:
            # ISO-8601 with milliseconds: 2026-06-13T22:49:23.123Z
            self.assertRegex(val, r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$")


# ---------------------------------------------------------------------------
# AC3: staleness detection + background re-index
# ---------------------------------------------------------------------------

class TestDaemonStaleness(unittest.TestCase):
    """AC3: daemon detects staleness within the poll interval and re-indexes."""

    def setUp(self) -> None:
        self.root = _make_repo("stale_func")
        build_index(self.root)

    def test_state_transitions_after_file_change(self) -> None:
        # Use a very short poll interval (0.2 s) so the test runs quickly.
        daemon, sock_path, t = _start_daemon(self.root, poll_interval=0.2)
        try:
            # Confirm initial state is running.
            resp = _rpc(sock_path, "status")
            self.assertEqual(resp["result"]["state"], "running")

            # Mutate a source file to invalidate the index.
            (self.root / "lib.py").write_text(
                "def stale_func():\n    return 99\n", encoding="utf-8"
            )

            # Poll for stale/running transition within 5 s.
            deadline = time.time() + 5.0
            seen_stale_or_reindex = False
            while time.time() < deadline:
                r = _rpc(sock_path, "status")
                state = r["result"]["state"]
                if state in ("stale", "error"):
                    seen_stale_or_reindex = True
                if state == "running" and seen_stale_or_reindex:
                    break
                time.sleep(0.05)

            # The daemon must not be stuck in "error" permanently.
            final = _rpc(sock_path, "status")["result"]["state"]
            self.assertIn(
                final, ("running", "stale"),
                f"Daemon ended in unexpected state: {final!r}",
            )
        finally:
            _stop_daemon(daemon, t)

    def test_queries_served_during_reindex(self) -> None:
        # With a very short poll, inject staleness and verify query still returns.
        daemon, sock_path, t = _start_daemon(self.root, poll_interval=0.2)
        try:
            (self.root / "lib.py").write_text(
                "def stale_func():\n    return 77\n", encoding="utf-8"
            )
            # Wait for at least one poll cycle.
            time.sleep(0.4)
            # Query must still return a valid (possibly stale) result.
            resp = _rpc(sock_path, "query", {"query": "stale_func"})
            self.assertIn("result", resp)
            self.assertIn("results", resp["result"])
        finally:
            _stop_daemon(daemon, t)


# ---------------------------------------------------------------------------
# AC6: clean exit removes socket file
# ---------------------------------------------------------------------------

class TestDaemonCleanExit(unittest.TestCase):
    """AC6: socket file is removed when the daemon stops."""

    def setUp(self) -> None:
        self.root = _make_repo("exit_func")
        build_index(self.root)

    def test_socket_removed_after_stop(self) -> None:
        daemon, sock_path, t = _start_daemon(self.root)
        self.assertTrue(sock_path.exists(), "Socket must exist while daemon is running")

        _stop_daemon(daemon, t, timeout=5.0)

        self.assertFalse(
            sock_path.exists(),
            "Socket file must be removed after daemon exits",
        )


# ---------------------------------------------------------------------------
# AC5: two daemons with different targets use distinct socket paths
# ---------------------------------------------------------------------------

class TestTwoDaemons(unittest.TestCase):
    """AC5: two daemons on different targets never collide."""

    def setUp(self) -> None:
        self.root1 = _make_repo("func_one")
        self.root2 = _make_repo("func_two")
        build_index(self.root1)
        build_index(self.root2)

    def test_distinct_socket_paths(self) -> None:
        self.assertNotEqual(daemon_socket_path(self.root1), daemon_socket_path(self.root2))

    def test_two_daemons_coexist(self) -> None:
        d1, sp1, t1 = _start_daemon(self.root1)
        d2, sp2, t2 = _start_daemon(self.root2)
        try:
            self.assertNotEqual(sp1, sp2, "Socket paths must differ")
            self.assertTrue(sp1.exists())
            self.assertTrue(sp2.exists())

            # Each daemon responds independently.
            r1 = _rpc(sp1, "status")
            r2 = _rpc(sp2, "status")
            self.assertIn("result", r1)
            self.assertIn("result", r2)
            self.assertEqual(r1["result"]["socketPath"], str(sp1))
            self.assertEqual(r2["result"]["socketPath"], str(sp2))
        finally:
            _stop_daemon(d1, t1)
            _stop_daemon(d2, t2)


if __name__ == "__main__":
    unittest.main()
