"""Tests for daemon concurrency safety under AFK worktrees (issue #593).

Strategy: the actual daemon server (agentrail/context/daemon_server.py) is the
blocking prerequisite from a separate issue and may not exist yet.  These tests
therefore use in-process fake Unix-socket servers — the same pattern used by
test_daemon_lifecycle.py and test_daemon_fallback.py — to verify the socket
isolation contract:

  socket_path_for(targetA) != socket_path_for(targetB)

and that each daemon responds only with data scoped to its own target.

AC coverage:
  AC1  Two daemons run concurrently against separate target directories; both
       respond to queries at the same time.
  AC2  The two socket file paths are not equal strings.
  AC3  Daemon A returns results citing a file from target A only; daemon B
       returns results citing a file from target B only; neither response
       contains the other target's file path.
  AC4  Stopping daemon A leaves daemon B responsive; B still returns its
       target-B-scoped results.
  AC5  SOCKET_PATH_FORMULA constant exists in agentrail.context.daemon and
       encodes the correct formula.

All tests clean up sockets in tearDown/finally blocks and use unique temp
directories so they never collide across worktrees or test runs.
"""
from __future__ import annotations

import json
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path

from agentrail.context import daemon as daemon_mod


# ---------------------------------------------------------------------------
# Fake daemon server (adapted from test_daemon_fallback._EchoServer)
# ---------------------------------------------------------------------------

class _ScopedDaemonServer:
    """Unix-socket server that serves canned query results for one target.

    *query_result* is the value returned under ``{"result": ...}`` for any
    "query" RPC.  "status" RPCs return a minimal running-state response.
    """

    def __init__(self, socket_path: Path, query_result: dict) -> None:
        self.socket_path = socket_path
        self._query_result = query_result
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

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
                conn.sendall(b"{}")
                return
            method = req.get("method", "")
            if method == "status":
                resp = {"pid": 99999, "state": "running",
                        "socketPath": str(self.socket_path)}
            elif method == "query":
                resp = {"result": self._query_result}
            else:
                resp = {"error": f"unknown method: {method}"}
            conn.sendall(json.dumps(resp).encode())
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def _serve(self) -> None:
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            srv.bind(str(self.socket_path))
            srv.listen(5)
            srv.settimeout(0.1)
            while not self._stop.is_set():
                try:
                    conn, _ = srv.accept()
                except socket.timeout:
                    continue
                t = threading.Thread(target=self._handle, args=(conn,), daemon=True)
                t.start()
        finally:
            try:
                srv.close()
            except OSError:
                pass
            try:
                self.socket_path.unlink()
            except OSError:
                pass

    def start(self) -> None:
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()
        # Wait until the socket is accepting connections.
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            if self.socket_path.exists() and daemon_mod.ping(self.socket_path, timeout=0.5):
                break
            time.sleep(0.02)

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3.0)
        # Ensure socket file is gone so ping() immediately returns False.
        try:
            self.socket_path.unlink()
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Concurrency tests
# ---------------------------------------------------------------------------

class TestDaemonConcurrencySocketIsolation(unittest.TestCase):
    """Two daemons bound to separate targets must use distinct socket paths."""

    def setUp(self) -> None:
        # Two independent temporary target directories.
        self._dirA = Path(tempfile.mkdtemp()).resolve()
        self._dirB = Path(tempfile.mkdtemp()).resolve()

        # Each target gets a unique "owned" file whose path appears in query
        # results — this is how we verify cross-contamination is absent.
        self._file_A = str(self._dirA / "only_in_target_a.py")
        self._file_B = str(self._dirB / "only_in_target_b.py")

        self._result_A = {
            "results": [{"rank": 1, "citation": self._file_A, "score": 0.9}]
        }
        self._result_B = {
            "results": [{"rank": 1, "citation": self._file_B, "score": 0.9}]
        }

        self._sockA = daemon_mod.socket_path_for(self._dirA)
        self._sockB = daemon_mod.socket_path_for(self._dirB)

        self._serverA = _ScopedDaemonServer(self._sockA, self._result_A)
        self._serverB = _ScopedDaemonServer(self._sockB, self._result_B)

        self._serverA.start()
        self._serverB.start()

    def tearDown(self) -> None:
        self._serverA.stop()
        self._serverB.stop()
        for path in (self._sockA, self._sockB):
            try:
                path.unlink()
            except OSError:
                pass

    # AC2 ----------------------------------------------------------------

    def test_ac2_socket_paths_are_different(self) -> None:
        """AC2: the two socket file paths must be distinct strings."""
        self.assertNotEqual(str(self._sockA), str(self._sockB),
                            "socket_path_for() returned the same path for two different targets")

    # AC1 ----------------------------------------------------------------

    def test_ac1_both_daemons_respond_concurrently(self) -> None:
        """AC1: both fake daemons are alive and responsive at the same time."""
        self.assertTrue(
            daemon_mod.ping(self._sockA, timeout=2.0),
            "Daemon A did not respond to a ping while Daemon B was also running",
        )
        self.assertTrue(
            daemon_mod.ping(self._sockB, timeout=2.0),
            "Daemon B did not respond to a ping while Daemon A was also running",
        )

    # AC3 ----------------------------------------------------------------

    def test_ac3_daemon_a_returns_target_a_results(self) -> None:
        """AC3: querying daemon A returns a citation from target A."""
        resp = daemon_mod.rpc(self._sockA, "query", timeout=3.0, params={"query": "test"})
        result = resp.get("result", {})
        citations = [r.get("citation", "") for r in result.get("results", [])]
        self.assertTrue(
            any(self._file_A in c for c in citations),
            f"Daemon A response did not cite target-A file {self._file_A!r}: {citations}",
        )

    def test_ac3_daemon_a_does_not_return_target_b_results(self) -> None:
        """AC3: daemon A response must not contain target-B file path."""
        resp = daemon_mod.rpc(self._sockA, "query", timeout=3.0, params={"query": "test"})
        result = resp.get("result", {})
        citations = [r.get("citation", "") for r in result.get("results", [])]
        self.assertFalse(
            any(self._file_B in c for c in citations),
            f"Daemon A response leaked target-B file {self._file_B!r}: {citations}",
        )

    def test_ac3_daemon_b_returns_target_b_results(self) -> None:
        """AC3: querying daemon B returns a citation from target B."""
        resp = daemon_mod.rpc(self._sockB, "query", timeout=3.0, params={"query": "test"})
        result = resp.get("result", {})
        citations = [r.get("citation", "") for r in result.get("results", [])]
        self.assertTrue(
            any(self._file_B in c for c in citations),
            f"Daemon B response did not cite target-B file {self._file_B!r}: {citations}",
        )

    def test_ac3_daemon_b_does_not_return_target_a_results(self) -> None:
        """AC3: daemon B response must not contain target-A file path."""
        resp = daemon_mod.rpc(self._sockB, "query", timeout=3.0, params={"query": "test"})
        result = resp.get("result", {})
        citations = [r.get("citation", "") for r in result.get("results", [])]
        self.assertFalse(
            any(self._file_A in c for c in citations),
            f"Daemon B response leaked target-A file {self._file_A!r}: {citations}",
        )

    # AC4 ----------------------------------------------------------------

    def test_ac4_stopping_a_leaves_b_responsive(self) -> None:
        """AC4: after stopping daemon A, daemon B still responds."""
        # Verify both up first.
        self.assertTrue(daemon_mod.ping(self._sockA, timeout=2.0))
        self.assertTrue(daemon_mod.ping(self._sockB, timeout=2.0))

        # Stop daemon A.
        self._serverA.stop()

        # Daemon A socket must be gone / unresponsive.
        self.assertFalse(
            daemon_mod.ping(self._sockA, timeout=0.5),
            "Daemon A still responds after stop()",
        )

        # Daemon B must still be alive and return target-B results.
        self.assertTrue(
            daemon_mod.ping(self._sockB, timeout=2.0),
            "Daemon B stopped responding after daemon A was stopped",
        )
        resp = daemon_mod.rpc(self._sockB, "query", timeout=3.0, params={"query": "test"})
        result = resp.get("result", {})
        citations = [r.get("citation", "") for r in result.get("results", [])]
        self.assertTrue(
            any(self._file_B in c for c in citations),
            f"Daemon B returned wrong results after A stopped: {citations}",
        )


# ---------------------------------------------------------------------------
# AC5: SOCKET_PATH_FORMULA constant is documented in daemon module
# ---------------------------------------------------------------------------

class TestSocketPathFormulaDocumented(unittest.TestCase):
    """AC5: daemon.py exports SOCKET_PATH_FORMULA describing the socket path contract."""

    def test_ac5_formula_constant_exists(self) -> None:
        """SOCKET_PATH_FORMULA must be a non-empty string attribute on daemon_mod."""
        self.assertTrue(
            hasattr(daemon_mod, "SOCKET_PATH_FORMULA"),
            "daemon_mod does not export SOCKET_PATH_FORMULA",
        )
        self.assertIsInstance(daemon_mod.SOCKET_PATH_FORMULA, str)
        self.assertTrue(len(daemon_mod.SOCKET_PATH_FORMULA) > 0)

    def test_ac5_formula_references_sha256(self) -> None:
        """The formula string must mention sha256 (documents the hashing algorithm)."""
        formula = daemon_mod.SOCKET_PATH_FORMULA
        self.assertIn("sha256", formula,
                      f"SOCKET_PATH_FORMULA does not mention sha256: {formula!r}")

    def test_ac5_formula_references_agentrail_dir(self) -> None:
        """The formula string must reference .agentrail (documents the directory)."""
        formula = daemon_mod.SOCKET_PATH_FORMULA
        self.assertIn(".agentrail", formula,
                      f"SOCKET_PATH_FORMULA does not reference .agentrail: {formula!r}")

    def test_ac5_socket_path_for_matches_formula(self) -> None:
        """socket_path_for() output must match the documented layout."""
        target = Path(tempfile.mkdtemp()).resolve()
        sock = daemon_mod.socket_path_for(target)
        # Must be under ~/.agentrail/
        self.assertTrue(str(sock).startswith(str(Path.home() / ".agentrail")))
        # Must be named daemon-<hash>.sock
        self.assertRegex(sock.name, r"^daemon-[0-9a-f]+\.sock$")


if __name__ == "__main__":
    unittest.main()
