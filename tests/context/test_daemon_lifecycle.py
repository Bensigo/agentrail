"""Tests for daemon lifecycle: start, stop, status via CLI and helper module.

Strategy: the actual daemon server (agentrail/context/daemon_server.py) is
the blocking prerequisite from a separate issue and may not exist yet.  These
tests therefore:

  1. Unit-test the daemon helper functions (socket_path_for, ping, rpc) in
     isolation using a tiny in-process echo server running in a thread.
  2. Integration-test the CLI subcommands (start/stop/status) by patching the
     daemon module at the CLI boundary so no real subprocess is spawned — the
     mock satisfies the socket contract the CLI expects.
  3. Verify the not-running path for status (exit 1, correct message).

All tests clean up sockets in finally-blocks and use unique temp directories
so they never collide across worktrees or test runs.
"""
from __future__ import annotations

import json
import os
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from agentrail.context import daemon as daemon_mod
from agentrail.cli.commands.context import _run_daemon, _resolve_target


# ---------------------------------------------------------------------------
# Helpers: a tiny Unix-socket server that replies to JSON RPC calls
# ---------------------------------------------------------------------------

class _FakeDaemonServer:
    """A minimal Unix-socket server that serves canned daemon RPC responses."""

    def __init__(self, socket_path: Path, pid: int = 99999) -> None:
        self.socket_path = socket_path
        self.pid = pid
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._server: socket.socket | None = None

    def _status_response(self) -> dict:
        return {
            "pid": self.pid,
            "uptimeSeconds": 42,
            "lastIndexedAt": "2026-06-14T00:00:00Z",
            "socketPath": str(self.socket_path),
            "state": "running",
        }

    def _handle(self, conn: socket.socket) -> None:
        try:
            chunks = []
            conn.settimeout(1.0)
            while True:
                try:
                    chunk = conn.recv(4096)
                except socket.timeout:
                    break
                if not chunk:
                    break
                chunks.append(chunk)
            raw = b"".join(chunks)
            try:
                req = json.loads(raw.decode())
            except (ValueError, UnicodeDecodeError):
                return
            method = req.get("method", "")
            if method == "status":
                resp = self._status_response()
            elif method == "shutdown":
                resp = {"ok": True}
                conn.sendall(json.dumps(resp).encode())
                conn.close()
                # Shut down the server after responding
                self._stop.set()
                return
            else:
                resp = {"error": f"unknown method: {method}"}
            conn.sendall(json.dumps(resp).encode())
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def _serve(self) -> None:
        self._server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self._server.bind(str(self.socket_path))
            self._server.listen(5)
            self._server.settimeout(0.1)
            while not self._stop.is_set():
                try:
                    conn, _ = self._server.accept()
                except socket.timeout:
                    continue
                t = threading.Thread(target=self._handle, args=(conn,), daemon=True)
                t.start()
        finally:
            try:
                self._server.close()
            except OSError:
                pass
            try:
                self.socket_path.unlink()
            except OSError:
                pass

    def start(self) -> None:
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()
        # Wait for socket to appear
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            if self.socket_path.exists():
                break
            time.sleep(0.02)

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3.0)


# ---------------------------------------------------------------------------
# Tests: daemon helper module (unit)
# ---------------------------------------------------------------------------

class TestSocketPathFor(unittest.TestCase):
    def test_returns_path_under_home_agentrail(self) -> None:
        target = Path(tempfile.mkdtemp()).resolve()
        sock_path = daemon_mod.socket_path_for(target)
        self.assertTrue(str(sock_path).startswith(str(Path.home() / ".agentrail")))
        self.assertTrue(sock_path.name.startswith("daemon-"))
        self.assertTrue(sock_path.name.endswith(".sock"))

    def test_different_targets_give_different_paths(self) -> None:
        t1 = Path(tempfile.mkdtemp()).resolve()
        t2 = Path(tempfile.mkdtemp()).resolve()
        self.assertNotEqual(daemon_mod.socket_path_for(t1), daemon_mod.socket_path_for(t2))

    def test_same_target_same_path(self) -> None:
        t = Path(tempfile.mkdtemp()).resolve()
        self.assertEqual(daemon_mod.socket_path_for(t), daemon_mod.socket_path_for(t))


class TestRpcAndPing(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp())
        self._sock = self._tmp / "test-daemon.sock"
        self._server = _FakeDaemonServer(self._sock)
        self._server.start()

    def tearDown(self) -> None:
        self._server.stop()
        try:
            self._sock.unlink()
        except OSError:
            pass

    def test_rpc_status_returns_expected_fields(self) -> None:
        resp = daemon_mod.rpc(self._sock, "status", timeout=3.0)
        self.assertIn("pid", resp)
        self.assertIn("uptimeSeconds", resp)
        self.assertIn("lastIndexedAt", resp)
        self.assertIn("socketPath", resp)
        self.assertIn("state", resp)

    def test_ping_returns_true_when_server_running(self) -> None:
        self.assertTrue(daemon_mod.ping(self._sock, timeout=2.0))

    def test_ping_returns_false_when_no_server(self) -> None:
        absent = self._tmp / "absent.sock"
        self.assertFalse(daemon_mod.ping(absent, timeout=0.3))

    def test_rpc_raises_on_absent_socket(self) -> None:
        absent = self._tmp / "absent.sock"
        with self.assertRaises(OSError):
            daemon_mod.rpc(absent, "status", timeout=0.3)


# ---------------------------------------------------------------------------
# Tests: CLI subcommands (integration via _run_daemon, mocked daemon module)
# ---------------------------------------------------------------------------

class TestDaemonStartCLI(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp()).resolve()
        self._sock = daemon_mod.socket_path_for(self._tmp)
        self._server: _FakeDaemonServer | None = None

    def tearDown(self) -> None:
        if self._server:
            self._server.stop()
        try:
            self._sock.unlink()
        except OSError:
            pass

    def test_start_spawns_daemon_and_prints_pid(self) -> None:
        """AC1: start when not running prints Daemon started (pid=N)."""
        server = _FakeDaemonServer(self._sock, pid=12345)
        self._server = server

        def _fake_start_detached(target: Path) -> int:
            server.start()
            return server.pid

        with mock.patch.object(daemon_mod, "start_detached", side_effect=_fake_start_detached), \
             mock.patch("sys.stdout") as mock_out:
            ret = _run_daemon(["start", "--target", str(self._tmp)])

        self.assertEqual(ret, 0)
        printed = "".join(call.args[0] for call in mock_out.write.call_args_list)
        self.assertIn("Daemon started", printed)
        self.assertIn("12345", printed)

    def test_start_idempotent_when_already_running(self) -> None:
        """AC2: start when already running prints Daemon already running (pid=N), exit 0."""
        server = _FakeDaemonServer(self._sock, pid=77777)
        server.start()
        self._server = server

        with mock.patch.object(daemon_mod, "start_detached") as mock_spawn, \
             mock.patch("sys.stdout") as mock_out:
            ret = _run_daemon(["start", "--target", str(self._tmp)])

        self.assertEqual(ret, 0)
        mock_spawn.assert_not_called()
        printed = "".join(call.args[0] for call in mock_out.write.call_args_list)
        self.assertIn("Daemon already running", printed)
        self.assertIn("77777", printed)


class TestDaemonStopCLI(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp()).resolve()
        self._sock = daemon_mod.socket_path_for(self._tmp)

    def tearDown(self) -> None:
        try:
            self._sock.unlink()
        except OSError:
            pass

    def test_stop_terminates_running_daemon(self) -> None:
        """AC3: stop prints Daemon stopped and socket is gone."""
        server = _FakeDaemonServer(self._sock, pid=55555)
        server.start()

        with mock.patch("sys.stdout") as mock_out:
            ret = _run_daemon(["stop", "--target", str(self._tmp)])

        self.assertEqual(ret, 0)
        printed = "".join(call.args[0] for call in mock_out.write.call_args_list)
        self.assertIn("Daemon stopped", printed)

    def test_stop_when_not_running_exits_1(self) -> None:
        """stop when no daemon exits 1."""
        with mock.patch("sys.stderr") as mock_err:
            ret = _run_daemon(["stop", "--target", str(self._tmp)])
        self.assertEqual(ret, 1)
        errout = "".join(call.args[0] for call in mock_err.write.call_args_list)
        self.assertIn("Daemon not running", errout)


class TestDaemonStatusCLI(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp()).resolve()
        self._sock = daemon_mod.socket_path_for(self._tmp)
        self._server: _FakeDaemonServer | None = None

    def tearDown(self) -> None:
        if self._server:
            self._server.stop()
        try:
            self._sock.unlink()
        except OSError:
            pass

    def test_status_json_has_required_fields(self) -> None:
        """AC4: status --json prints JSON with pid, uptimeSeconds, lastIndexedAt, socketPath, state."""
        server = _FakeDaemonServer(self._sock, pid=33333)
        server.start()
        self._server = server

        output_lines: list[str] = []
        with mock.patch("builtins.print", side_effect=lambda *a, **kw: output_lines.append(" ".join(str(x) for x in a))):
            ret = _run_daemon(["status", "--json", "--target", str(self._tmp)])

        self.assertEqual(ret, 0)
        combined = "\n".join(output_lines)
        data = json.loads(combined)
        for field in ("pid", "uptimeSeconds", "lastIndexedAt", "socketPath", "state"):
            self.assertIn(field, data, f"Missing field: {field}")

    def test_status_human_format_prints_labeled_lines(self) -> None:
        """AC4: status (no --json) prints labeled lines for each field."""
        server = _FakeDaemonServer(self._sock, pid=44444)
        server.start()
        self._server = server

        output_lines: list[str] = []
        with mock.patch("builtins.print", side_effect=lambda *a, **kw: output_lines.append(" ".join(str(x) for x in a))):
            ret = _run_daemon(["status", "--target", str(self._tmp)])

        self.assertEqual(ret, 0)
        combined = "\n".join(output_lines)
        self.assertIn("PID", combined)
        self.assertIn("uptime", combined)
        self.assertIn("last indexed", combined)
        self.assertIn("socket", combined)
        self.assertIn("state", combined)

    def test_status_not_running_exits_1_with_message(self) -> None:
        """AC5: status when no daemon running exits 1 with Daemon not running for target <path>."""
        stderr_lines: list[str] = []

        def _mock_print(*args: object, **kwargs: object) -> None:
            if kwargs.get("file") is not None:
                stderr_lines.append(" ".join(str(a) for a in args))

        with mock.patch("builtins.print", side_effect=_mock_print):
            ret = _run_daemon(["status", "--target", str(self._tmp)])

        self.assertEqual(ret, 1)
        msg = "\n".join(stderr_lines)
        self.assertIn("Daemon not running for target", msg)
        self.assertIn(str(self._tmp), msg)


# ---------------------------------------------------------------------------
# Tests: _wait_for_socket and _wait_for_socket_gone helpers
# ---------------------------------------------------------------------------

class TestWaitHelpers(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp())

    def test_wait_for_socket_gone_returns_true_when_already_absent(self) -> None:
        absent = self._tmp / "no-such.sock"
        self.assertTrue(daemon_mod._wait_for_socket_gone(absent, timeout=0.5))

    def test_wait_for_socket_gone_returns_false_when_persists(self) -> None:
        sock = self._tmp / "persists.sock"
        sock.touch()
        try:
            result = daemon_mod._wait_for_socket_gone(sock, timeout=0.3, interval=0.05)
            self.assertFalse(result)
        finally:
            sock.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
