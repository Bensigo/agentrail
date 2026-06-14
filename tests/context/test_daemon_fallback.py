"""Tests for _resolve_context_client transparent fallback (issue #592).

Strategy: the actual daemon server may not exist yet.  These tests use a tiny
in-process Unix-socket server (adapted from test_daemon_lifecycle.py) to
exercise the warm path, and verify the cold-path fallback when the socket is
absent or returns malformed data.

AC coverage:
  AC1  warm-client and cold-client return identical results for the same query.
  AC3  socket absent → cold path returned, no stdout/stderr emitted.
  AC4  malformed daemon response → cold path fallback, no raised exception.
"""
from __future__ import annotations

import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from agentrail.context import daemon as daemon_mod
from agentrail.context.client import _ColdClient, _WarmClient, _resolve_context_client
from agentrail.context.index import build_index


# ---------------------------------------------------------------------------
# Fake daemon servers
# ---------------------------------------------------------------------------

class _EchoServer:
    """Unix-socket server that returns canned responses for retrieval RPCs."""

    def __init__(self, socket_path: Path, responses: dict | None = None) -> None:
        self.socket_path = socket_path
        # method → result value placed under {"result": ...}
        self._responses: dict = responses or {}
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
            if method in self._responses:
                resp = {"result": self._responses[method]}
            elif method == "ping":
                resp = {"result": "pong"}
            elif method == "status":
                resp = {"pid": 99999, "state": "running"}
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
        # Wait until the server is actually accepting connections (not just bound).
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            if self.socket_path.exists() and daemon_mod.ping(self.socket_path, timeout=0.5):
                break
            time.sleep(0.02)

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3.0)


class _MalformedServer:
    """Unix-socket server that always sends invalid JSON."""

    def __init__(self, socket_path: Path) -> None:
        self.socket_path = socket_path
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _handle(self, conn: socket.socket) -> None:
        try:
            conn.settimeout(1.0)
            # drain input
            while True:
                try:
                    chunk = conn.recv(4096)
                except socket.timeout:
                    break
                if not chunk:
                    break
            conn.sendall(b"not-valid-json!!!")
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
        # Wait until socket file exists (server bound); connections may fail
        # with malformed response, which is intentional for this test server.
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            if self.socket_path.exists():
                break
            time.sleep(0.02)
        # Give the thread a brief moment to call listen()
        time.sleep(0.05)

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3.0)


# ---------------------------------------------------------------------------
# AC3: socket absent → cold path, no stderr/stdout
# ---------------------------------------------------------------------------

class TestSocketAbsentFallback(unittest.TestCase):
    """When the daemon socket does not exist, resolver returns a _ColdClient silently."""

    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp()).resolve()

    def test_returns_cold_client_when_socket_absent(self) -> None:
        client = _resolve_context_client(self._tmp)
        self.assertIsInstance(client, _ColdClient)
        self.assertEqual(client.mode, "cold")

    def test_no_output_to_stdout_or_stderr_when_socket_absent(self) -> None:
        buf_out = io.StringIO()
        buf_err = io.StringIO()
        with mock.patch("sys.stdout", buf_out), mock.patch("sys.stderr", buf_err):
            _resolve_context_client(self._tmp)
        self.assertEqual(buf_out.getvalue(), "", "unexpected stdout output on socket-absent fallback")
        self.assertEqual(buf_err.getvalue(), "", "unexpected stderr output on socket-absent fallback")

    def test_cold_client_mode_attribute(self) -> None:
        client = _resolve_context_client(self._tmp)
        self.assertEqual(client.mode, "cold")


# ---------------------------------------------------------------------------
# AC4: malformed daemon response → cold path, no exception raised
# ---------------------------------------------------------------------------

class TestMalformedResponseFallback(unittest.TestCase):
    """When the daemon returns malformed JSON on ping, resolver falls back silently."""

    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp())
        self._sock = daemon_mod.socket_path_for(self._tmp.resolve())
        self._server = _MalformedServer(self._sock)
        self._server.start()

    def tearDown(self) -> None:
        self._server.stop()
        try:
            self._sock.unlink()
        except OSError:
            pass

    def test_returns_cold_client_on_malformed_json(self) -> None:
        client = _resolve_context_client(self._tmp.resolve())
        self.assertIsInstance(client, _ColdClient)

    def test_no_exception_raised_on_malformed_json(self) -> None:
        # Must not raise — the resolver absorbs all errors.
        try:
            _resolve_context_client(self._tmp.resolve())
        except Exception as exc:
            self.fail(f"_resolve_context_client raised an exception: {exc}")

    def test_no_stderr_output_on_malformed_json(self) -> None:
        buf_err = io.StringIO()
        with mock.patch("sys.stderr", buf_err):
            _resolve_context_client(self._tmp.resolve())
        self.assertEqual(buf_err.getvalue(), "")


# ---------------------------------------------------------------------------
# AC1: warm client returns identical result shape as cold client
# ---------------------------------------------------------------------------

_QUERY_RESULT = {
    "results": [
        {
            "rank": 1,
            "citation": "agentrail/context/retrieval.py:1-10",
            "score": {"final": 0.95},
            "reason": "exact match",
        }
    ],
    "excluded": [],
}

_SEARCH_RESULT = {
    "results": [
        {
            "rank": 1,
            "path": "agentrail/context/retrieval.py",
            "lineStart": 1,
            "lineEnd": 10,
            "tokenEstimate": 42,
            "symbol": "query_context",
            "reason": "keyword match",
        }
    ]
}

_DEF_RESULT = [{"path": "agentrail/context/retrieval.py", "lineStart": 100, "kind": "function"}]
_CALLERS_RESULT = [{"callerPath": "agentrail/cli/commands/context.py", "callerLine": 453}]
_CALLEES_RESULT = [{"path": "agentrail/context/index.py", "lineStart": 5, "resolved": True, "citation": "x:5"}]
_IMPACT_RESULT = [{"path": "agentrail/context/retrieval.py", "lineStart": 200, "reason": "direct caller"}]

_CANNED: dict = {
    "query": _QUERY_RESULT,
    "search": _SEARCH_RESULT,
    "def": _DEF_RESULT,
    "callers": _CALLERS_RESULT,
    "callees": _CALLEES_RESULT,
    "impact": _IMPACT_RESULT,
}


class TestWarmClientReturnsWarmMode(unittest.TestCase):
    """When a well-behaved daemon is running, resolver returns a _WarmClient."""

    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp()).resolve()
        self._sock = daemon_mod.socket_path_for(self._tmp)
        self._server = _EchoServer(self._sock, responses=_CANNED)
        self._server.start()

    def tearDown(self) -> None:
        self._server.stop()
        try:
            self._sock.unlink()
        except OSError:
            pass

    def test_returns_warm_client_when_daemon_running(self) -> None:
        client = _resolve_context_client(self._tmp)
        self.assertIsInstance(client, _WarmClient)
        self.assertEqual(client.mode, "warm")

    def test_warm_client_query_returns_daemon_result(self) -> None:
        client = _resolve_context_client(self._tmp)
        result = client.query("test query", limit=5)
        self.assertEqual(result, _QUERY_RESULT)

    def test_warm_client_search_returns_daemon_result(self) -> None:
        client = _resolve_context_client(self._tmp)
        result = client.search("test search", limit=5)
        self.assertEqual(result, _SEARCH_RESULT)

    def test_warm_client_def_returns_daemon_result(self) -> None:
        client = _resolve_context_client(self._tmp)
        result = client.def_("query_context")
        self.assertEqual(result, _DEF_RESULT)

    def test_warm_client_callers_returns_daemon_result(self) -> None:
        client = _resolve_context_client(self._tmp)
        result = client.callers("query_context")
        self.assertEqual(result, _CALLERS_RESULT)

    def test_warm_client_callees_returns_daemon_result(self) -> None:
        client = _resolve_context_client(self._tmp)
        result = client.callees("query_context")
        self.assertEqual(result, _CALLEES_RESULT)

    def test_warm_client_impact_returns_daemon_result(self) -> None:
        client = _resolve_context_client(self._tmp)
        result = client.impact("query_context", depth=2)
        self.assertEqual(result, _IMPACT_RESULT)


# ---------------------------------------------------------------------------
# AC1 parity: _ColdClient methods call retrieval functions with correct args
# ---------------------------------------------------------------------------

class TestColdClientDispatch(unittest.TestCase):
    """_ColdClient must forward calls to retrieval.py with the correct arguments."""

    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp()).resolve()

    def test_query_forwards_args(self) -> None:
        client = _ColdClient(self._tmp)
        with mock.patch("agentrail.context.client.query_context", return_value=_QUERY_RESULT) as m:
            result = client.query("my query", limit=7)
        m.assert_called_once_with(self._tmp, "my query", limit=7)
        self.assertEqual(result, _QUERY_RESULT)

    def test_search_forwards_args(self) -> None:
        client = _ColdClient(self._tmp)
        with mock.patch("agentrail.context.client.search_context", return_value=_SEARCH_RESULT) as m:
            result = client.search("my search", limit=3)
        m.assert_called_once_with(self._tmp, "my search", limit=3)
        self.assertEqual(result, _SEARCH_RESULT)

    def test_def_forwards_args(self) -> None:
        client = _ColdClient(self._tmp)
        with mock.patch("agentrail.context.client.context_def", return_value=_DEF_RESULT) as m:
            result = client.def_("my_symbol")
        m.assert_called_once_with(self._tmp, "my_symbol")
        self.assertEqual(result, _DEF_RESULT)

    def test_callers_forwards_args(self) -> None:
        client = _ColdClient(self._tmp)
        with mock.patch("agentrail.context.client.context_callers", return_value=_CALLERS_RESULT) as m:
            result = client.callers("my_symbol")
        m.assert_called_once_with(self._tmp, "my_symbol")
        self.assertEqual(result, _CALLERS_RESULT)

    def test_callees_forwards_args(self) -> None:
        client = _ColdClient(self._tmp)
        with mock.patch("agentrail.context.client.context_callees", return_value=_CALLEES_RESULT) as m:
            result = client.callees("my_symbol")
        m.assert_called_once_with(self._tmp, "my_symbol")
        self.assertEqual(result, _CALLEES_RESULT)

    def test_impact_forwards_args(self) -> None:
        client = _ColdClient(self._tmp)
        with mock.patch("agentrail.context.client.context_impact", return_value=_IMPACT_RESULT) as m:
            result = client.impact("my_symbol", depth=5)
        m.assert_called_once_with(self._tmp, "my_symbol", depth=5)
        self.assertEqual(result, _IMPACT_RESULT)


# ---------------------------------------------------------------------------
# rpc() backward compatibility: params keyword is optional
# ---------------------------------------------------------------------------

class TestRpcParamsBackcompat(unittest.TestCase):
    """Existing callers of rpc(socket, method) must continue to work unchanged."""

    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp())
        self._sock = self._tmp / "test.sock"
        self._server = _EchoServer(self._sock)
        self._server.start()

    def tearDown(self) -> None:
        self._server.stop()
        try:
            self._sock.unlink()
        except OSError:
            pass

    def test_rpc_without_params_sends_method_only(self) -> None:
        from agentrail.context import daemon as d
        resp = d.rpc(self._sock, "ping", timeout=2.0)
        # Must not raise and must return a dict
        self.assertIsInstance(resp, dict)

    def test_rpc_with_params_sends_params_field(self) -> None:
        from agentrail.context import daemon as d
        resp = d.rpc(self._sock, "query", timeout=2.0, params={"query": "hello", "limit": 5})
        self.assertIsInstance(resp, dict)


# ---------------------------------------------------------------------------
# AC3: cold-path CLI fallback — all six retrieval commands exit 0 with output
# ---------------------------------------------------------------------------

def _make_fallback_repo() -> Path:
    """Create a temp repo with caller/callee relationships for retrieval tests."""
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
    (root / "src" / "helpers.py").write_text(
        "def process():\n    return 42\n",
        encoding="utf-8",
    )
    (root / "src" / "main.py").write_text(
        "from src.helpers import process\n\ndef entry():\n    return process()\n",
        encoding="utf-8",
    )
    # Pre-build the index so CLI commands don't rebuild (avoids any log output)
    build_index(root)
    return root


class TestColdPathCLIFallback(unittest.TestCase):
    """AC3: with no daemon running the six retrieval CLI commands exit 0 with output."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._repo = _make_fallback_repo()
        # Ensure no daemon socket exists for this target
        sock = daemon_mod.socket_path_for(cls._repo)
        sock.unlink(missing_ok=True)

    def _run_cmd(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "-m", "agentrail.cli.main", "context"] + list(args)
            + ["--target", str(self._repo), "--json"],
            capture_output=True,
            text=True,
            timeout=10,
        )

    def test_query_exits_0_with_output(self) -> None:
        r = self._run_cmd("query", "process")
        self.assertEqual(r.returncode, 0, f"stderr: {r.stderr}")
        self.assertTrue(r.stdout.strip(), "Expected non-empty stdout")
        self.assertEqual(r.stderr, "", f"Unexpected stderr: {r.stderr}")

    def test_search_exits_0_with_output(self) -> None:
        r = self._run_cmd("search", "process")
        self.assertEqual(r.returncode, 0, f"stderr: {r.stderr}")
        self.assertTrue(r.stdout.strip(), "Expected non-empty stdout")
        self.assertEqual(r.stderr, "", f"Unexpected stderr: {r.stderr}")

    def test_def_exits_0_with_output(self) -> None:
        r = self._run_cmd("def", "process")
        self.assertEqual(r.returncode, 0, f"stderr: {r.stderr}")
        self.assertTrue(r.stdout.strip(), "Expected non-empty stdout")
        self.assertEqual(r.stderr, "", f"Unexpected stderr: {r.stderr}")

    def test_callers_exits_0_with_output(self) -> None:
        r = self._run_cmd("callers", "process")
        self.assertEqual(r.returncode, 0, f"stderr: {r.stderr}")
        self.assertTrue(r.stdout.strip(), "Expected non-empty stdout")
        self.assertEqual(r.stderr, "", f"Unexpected stderr: {r.stderr}")

    def test_callees_exits_0_with_output(self) -> None:
        r = self._run_cmd("callees", "entry")
        self.assertEqual(r.returncode, 0, f"stderr: {r.stderr}")
        self.assertTrue(r.stdout.strip(), "Expected non-empty stdout")
        self.assertEqual(r.stderr, "", f"Unexpected stderr: {r.stderr}")

    def test_impact_exits_0_with_output(self) -> None:
        r = self._run_cmd("impact", "process")
        self.assertEqual(r.returncode, 0, f"stderr: {r.stderr}")
        self.assertTrue(r.stdout.strip(), "Expected non-empty stdout")
        self.assertEqual(r.stderr, "", f"Unexpected stderr: {r.stderr}")


if __name__ == "__main__":
    unittest.main()
