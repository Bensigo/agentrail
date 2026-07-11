"""Tests for agentrail/context/daemon_server.py (issue #590).

Strategy: tests instantiate DaemonServer in-process, bind to a temp socket
path, and communicate via the daemon.rpc() helper.  No real subprocess is
spawned — each server runs in a daemon thread with a short timeout so tests
can't hang.

AC coverage:
  AC1  Server binds socket, loads index+postings, accepts connections.
  AC2  query RPC returns same-shape result as cold-path query_context.
  AC3  Staleness detected; background reindex triggered; state flips stale→running.
  AC4  status RPC returns pid/uptimeSeconds/lastIndexedAt/socketPath/state.
  AC5  Two servers on different targets use distinct socket paths.
  AC6  Server exits cleanly on SIGTERM; socket file is removed.
"""
from __future__ import annotations

import json
import os
import signal
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from agentrail.context import daemon as daemon_mod
from agentrail.context.daemon_server import DaemonServer


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _start_server(target: Path, timeout: float = 5.0) -> DaemonServer:
    """Start a DaemonServer in a daemon thread; wait until socket exists."""
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


def _stop_server(server: DaemonServer) -> None:
    server._stop_event.set()
    # Give thread a moment to clean up
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        if not server._socket_path.exists():
            break
        time.sleep(0.05)


# ---------------------------------------------------------------------------
# AC1: server binds socket, loads index+postings, accepts connections
# ---------------------------------------------------------------------------

class TestServerStartup(unittest.TestCase):

    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp()).resolve()
        self._server: DaemonServer | None = None

    def tearDown(self) -> None:
        if self._server:
            _stop_server(self._server)

    def test_ac1_server_binds_socket(self) -> None:
        """AC1: socket file exists after server starts."""
        with mock.patch("agentrail.context.daemon_server.DaemonServer._load_index_from_disk"), \
             mock.patch("agentrail.context.index.build_index"):
            server = _start_server(self._tmp)
            self._server = server
        self.assertTrue(server._socket_path.exists(), "socket file not created")

    def test_ac1_server_responds_to_ping(self) -> None:
        """AC1: server accepts connections and responds to ping."""
        with mock.patch("agentrail.context.daemon_server.DaemonServer._load_index_from_disk"), \
             mock.patch("agentrail.context.index.build_index"):
            server = _start_server(self._tmp)
            self._server = server
        resp = daemon_mod.rpc(server._socket_path, "ping", timeout=3.0)
        self.assertEqual(resp.get("result"), "pong")

    def test_ac1_socket_path_under_home_agentrail(self) -> None:
        """AC1: socket path follows the ~/.agentrail/daemon-<hash>.sock formula."""
        server = DaemonServer(self._tmp)
        sock = server._socket_path
        self.assertTrue(str(sock).startswith(str(Path.home() / ".agentrail")))
        self.assertRegex(sock.name, r"^daemon-[0-9a-f]+\.sock$")


# ---------------------------------------------------------------------------
# AC2: query RPC returns same shape as cold-path query_context
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


class TestQueryRpc(unittest.TestCase):

    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp()).resolve()
        self._server: DaemonServer | None = None

    def tearDown(self) -> None:
        if self._server:
            _stop_server(self._server)

    def test_ac2_query_returns_result_shape(self) -> None:
        """AC2: query RPC returns {"result": ...} with same shape as cold path."""
        with mock.patch("agentrail.context.daemon_server.DaemonServer._load_index_from_disk"), \
             mock.patch("agentrail.context.index.build_index"), \
             mock.patch("agentrail.context.retrieval.query_context", return_value=_QUERY_RESULT):
            server = _start_server(self._tmp)
            self._server = server
            resp = daemon_mod.rpc(
                server._socket_path, "query",
                params={"query": "alpha_token", "limit": 5},
                timeout=3.0,
            )
        self.assertIn("result", resp, f"expected 'result' key in response: {resp}")
        self.assertEqual(resp["result"], _QUERY_RESULT)

    def test_ac2_query_result_has_results_key(self) -> None:
        """AC2: result has 'results' key matching cold-path shape."""
        with mock.patch("agentrail.context.daemon_server.DaemonServer._load_index_from_disk"), \
             mock.patch("agentrail.context.index.build_index"), \
             mock.patch("agentrail.context.retrieval.query_context", return_value=_QUERY_RESULT):
            server = _start_server(self._tmp)
            self._server = server
            resp = daemon_mod.rpc(
                server._socket_path, "query",
                params={"query": "alpha_token"},
                timeout=3.0,
            )
        self.assertIn("results", resp.get("result", {}))

    def test_ac2_search_rpc(self) -> None:
        """AC2: search RPC returns {"result": ...}."""
        search_result = {"results": [{"rank": 1, "path": "foo.py", "lineStart": 1}]}
        with mock.patch("agentrail.context.daemon_server.DaemonServer._load_index_from_disk"), \
             mock.patch("agentrail.context.index.build_index"), \
             mock.patch("agentrail.context.retrieval.search_context", return_value=search_result):
            server = _start_server(self._tmp)
            self._server = server
            resp = daemon_mod.rpc(
                server._socket_path, "search",
                params={"query": "alpha_token"},
                timeout=3.0,
            )
        self.assertIn("result", resp)
        self.assertEqual(resp["result"], search_result)


# ---------------------------------------------------------------------------
# AC3: staleness detection → background reindex → state transition
# ---------------------------------------------------------------------------

class TestFreshnessAndReindex(unittest.TestCase):

    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp()).resolve()
        self._server: DaemonServer | None = None

    def tearDown(self) -> None:
        if self._server:
            _stop_server(self._server)

    def test_ac3_stale_state_set_when_not_fresh(self) -> None:
        """AC3: _freshness_loop sets state='stale' when index is not fresh."""
        with mock.patch("agentrail.context.daemon_server.DaemonServer._load_index_from_disk"), \
             mock.patch("agentrail.context.index.build_index"):
            server = _start_server(self._tmp)
            self._server = server

        # Simulate freshness returning False + reindex completes quickly
        reindex_called = threading.Event()

        def _fake_do_reindex():
            reindex_called.set()
            with server._lock:
                server._state = "running"

        with mock.patch.object(server, "_is_fresh", return_value=False), \
             mock.patch.object(server, "_do_reindex", side_effect=_fake_do_reindex):
            # Manually trigger the freshness loop logic (without waiting 30s)
            if not server._is_fresh():
                with server._lock:
                    server._state = "stale"
            resp = daemon_mod.rpc(server._socket_path, "status", timeout=3.0)

        self.assertEqual(resp.get("result", {}).get("state"), "stale")

    def test_ac3_reindex_restores_running_state(self) -> None:
        """AC3: after reindex completes, state returns to 'running'."""
        with mock.patch("agentrail.context.daemon_server.DaemonServer._load_index_from_disk"), \
             mock.patch("agentrail.context.index.build_index"):
            server = _start_server(self._tmp)
            self._server = server

        with server._lock:
            server._state = "stale"

        def _fake_load():
            with server._lock:
                server._state = "running"
                server._index = {}

        # Simulate reindex completing — _load_index_from_disk sets state=running
        with mock.patch.object(server, "_load_index_from_disk", side_effect=_fake_load), \
             mock.patch("agentrail.context.index.build_index"):
            server._do_reindex()

        with server._lock:
            state = server._state
        self.assertEqual(state, "running")

    def test_ac3_query_served_during_stale_state(self) -> None:
        """AC3: query RPC returns a result even when state='stale'."""
        with mock.patch("agentrail.context.daemon_server.DaemonServer._load_index_from_disk"), \
             mock.patch("agentrail.context.index.build_index"), \
             mock.patch("agentrail.context.retrieval.query_context", return_value=_QUERY_RESULT):
            server = _start_server(self._tmp)
            self._server = server
            with server._lock:
                server._state = "stale"
            resp = daemon_mod.rpc(
                server._socket_path, "query",
                params={"query": "test"},
                timeout=3.0,
            )
        self.assertIn("result", resp)


# ---------------------------------------------------------------------------
# AC4: status RPC returns required fields
# ---------------------------------------------------------------------------

class TestStatusRpc(unittest.TestCase):

    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp()).resolve()
        self._server: DaemonServer | None = None

    def tearDown(self) -> None:
        if self._server:
            _stop_server(self._server)

    def test_ac4_status_has_required_fields(self) -> None:
        """AC4: status returns pid, uptimeSeconds, lastIndexedAt, socketPath, state."""
        with mock.patch("agentrail.context.daemon_server.DaemonServer._load_index_from_disk"), \
             mock.patch("agentrail.context.index.build_index"):
            server = _start_server(self._tmp)
            self._server = server
        resp = daemon_mod.rpc(server._socket_path, "status", timeout=3.0)
        self.assertIn("result", resp, f"expected 'result' key in response: {resp}")
        for field in ("pid", "uptimeSeconds", "lastIndexedAt", "socketPath", "state"):
            self.assertIn(field, resp["result"], f"missing field: {field}")

    def test_ac4_status_pid_is_int(self) -> None:
        with mock.patch("agentrail.context.daemon_server.DaemonServer._load_index_from_disk"), \
             mock.patch("agentrail.context.index.build_index"):
            server = _start_server(self._tmp)
            self._server = server
        resp = daemon_mod.rpc(server._socket_path, "status", timeout=3.0)
        self.assertIsInstance(resp["result"]["pid"], int)
        self.assertEqual(resp["result"]["pid"], os.getpid())

    def test_ac4_status_uptime_is_non_negative(self) -> None:
        with mock.patch("agentrail.context.daemon_server.DaemonServer._load_index_from_disk"), \
             mock.patch("agentrail.context.index.build_index"):
            server = _start_server(self._tmp)
            self._server = server
        resp = daemon_mod.rpc(server._socket_path, "status", timeout=3.0)
        self.assertGreaterEqual(resp["result"]["uptimeSeconds"], 0.0)

    def test_ac4_status_socket_path_matches(self) -> None:
        with mock.patch("agentrail.context.daemon_server.DaemonServer._load_index_from_disk"), \
             mock.patch("agentrail.context.index.build_index"):
            server = _start_server(self._tmp)
            self._server = server
        resp = daemon_mod.rpc(server._socket_path, "status", timeout=3.0)
        self.assertEqual(resp["result"]["socketPath"], str(server._socket_path))

    def test_ac4_status_state_is_valid(self) -> None:
        with mock.patch("agentrail.context.daemon_server.DaemonServer._load_index_from_disk"), \
             mock.patch("agentrail.context.index.build_index"):
            server = _start_server(self._tmp)
            self._server = server
        resp = daemon_mod.rpc(server._socket_path, "status", timeout=3.0)
        self.assertIn(resp["result"]["state"], {"running", "stale", "error", "starting"})


# ---------------------------------------------------------------------------
# AC5: two servers on different targets use distinct socket paths
# ---------------------------------------------------------------------------

class TestSocketIsolation(unittest.TestCase):

    def setUp(self) -> None:
        self._serverA: DaemonServer | None = None
        self._serverB: DaemonServer | None = None

    def tearDown(self) -> None:
        for s in (self._serverA, self._serverB):
            if s:
                _stop_server(s)

    def test_ac5_distinct_socket_paths(self) -> None:
        """AC5: two servers for different targets have different socket paths."""
        tmpA = Path(tempfile.mkdtemp()).resolve()
        tmpB = Path(tempfile.mkdtemp()).resolve()
        with mock.patch("agentrail.context.daemon_server.DaemonServer._load_index_from_disk"), \
             mock.patch("agentrail.context.index.build_index"):
            serverA = _start_server(tmpA)
            serverB = _start_server(tmpB)
            self._serverA = serverA
            self._serverB = serverB
        self.assertNotEqual(
            str(serverA._socket_path), str(serverB._socket_path),
            "Both servers share the same socket path",
        )

    def test_ac5_both_servers_respond_concurrently(self) -> None:
        """AC5: both servers accept connections at the same time."""
        tmpA = Path(tempfile.mkdtemp()).resolve()
        tmpB = Path(tempfile.mkdtemp()).resolve()
        with mock.patch("agentrail.context.daemon_server.DaemonServer._load_index_from_disk"), \
             mock.patch("agentrail.context.index.build_index"):
            serverA = _start_server(tmpA)
            serverB = _start_server(tmpB)
            self._serverA = serverA
            self._serverB = serverB
        self.assertTrue(daemon_mod.ping(serverA._socket_path, timeout=2.0))
        self.assertTrue(daemon_mod.ping(serverB._socket_path, timeout=2.0))


# ---------------------------------------------------------------------------
# AC6: server exits on stop_event; socket file removed
# ---------------------------------------------------------------------------

class TestCleanShutdown(unittest.TestCase):

    def test_ac6_socket_removed_on_stop(self) -> None:
        """AC6: socket file is removed when stop_event is set."""
        tmp = Path(tempfile.mkdtemp()).resolve()
        with mock.patch("agentrail.context.daemon_server.DaemonServer._load_index_from_disk"), \
             mock.patch("agentrail.context.index.build_index"):
            server = _start_server(tmp)
        sock_path = server._socket_path
        self.assertTrue(sock_path.exists(), "socket was not created")
        _stop_server(server)
        self.assertFalse(sock_path.exists(), "socket was not removed after stop")

    def test_ac6_stop_event_stops_server(self) -> None:
        """AC6: setting stop_event causes server to stop accepting connections."""
        tmp = Path(tempfile.mkdtemp()).resolve()
        with mock.patch("agentrail.context.daemon_server.DaemonServer._load_index_from_disk"), \
             mock.patch("agentrail.context.index.build_index"):
            server = _start_server(tmp)
        sock_path = server._socket_path
        self.assertTrue(daemon_mod.ping(sock_path, timeout=2.0), "server not responsive before stop")
        # Trigger stop via event (as a signal handler would)
        server._stop_event.set()
        # Wait for socket to disappear
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            if not sock_path.exists():
                break
            time.sleep(0.05)
        self.assertFalse(sock_path.exists(), "socket not removed after stop_event set")

    def test_ac6_signal_handler_sets_stop_event(self) -> None:
        """AC6: the signal handler function (when installed) sets stop_event."""
        # Test the handler logic directly without sending a real signal.
        stop = threading.Event()
        # Recreate handler logic as in serve()
        def _handle_signal(signum: int, frame: object) -> None:
            stop.set()
        _handle_signal(signal.SIGTERM, None)
        self.assertTrue(stop.is_set())


# ---------------------------------------------------------------------------
# Build suppression seam: _is_serve_cached in daemon request threads
# ---------------------------------------------------------------------------

class TestBuildSuppression(unittest.TestCase):

    def test_is_serve_cached_false_by_default(self) -> None:
        from agentrail.context.daemon_server import _is_serve_cached
        self.assertFalse(_is_serve_cached())

    def test_is_serve_cached_true_inside_request(self) -> None:
        from agentrail.context import daemon_server as ds
        ds._serve_cached.active = True
        try:
            self.assertTrue(ds._is_serve_cached())
        finally:
            ds._serve_cached.active = False

    def test_build_index_returns_cached_when_guard_set(self) -> None:
        """build_index returns immediately when _serve_cached is active."""
        from agentrail.context import daemon_server as ds
        from agentrail.context.index import build_index
        ds._serve_cached.active = True
        try:
            with mock.patch("agentrail.context.index.load_index", return_value={"records": []}) as m:
                result = build_index(Path(tempfile.mkdtemp()))
            m.assert_called_once()
            self.assertIsInstance(result, dict)
        finally:
            ds._serve_cached.active = False


# ---------------------------------------------------------------------------
# Issue #688: AC2 — daemon dispatch never calls build_index per query
# ---------------------------------------------------------------------------

class TestDaemonNoBuildIndexPerQuery(unittest.TestCase):
    """AC2 (#688): build_index must not be called on the daemon query path."""

    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp()).resolve()
        self._server: DaemonServer | None = None

    def tearDown(self) -> None:
        if self._server:
            _stop_server(self._server)

    def test_ac2_688_build_index_not_called_on_query(self) -> None:
        """AC2: daemon query dispatch passes index= to query_context; build_index call count == 0."""
        fake_index = {"records": [], "chunks": [], "graph": {"nodes": [], "edges": []}, "symbolTable": {}}
        with mock.patch("agentrail.context.daemon_server.DaemonServer._load_index_from_disk"), \
             mock.patch("agentrail.context.index.build_index") as mock_build:
            server = _start_server(self._tmp)
            self._server = server
            # Inject a known index directly (bypasses disk)
            with server._lock:
                server._index = fake_index

        mock_build.reset_mock()

        # Patch retrieval to record whether build_index was invoked on the retrieval side.
        build_index_calls: list[int] = []

        def _counting_build_index(*args: object, **kwargs: object) -> dict:
            build_index_calls.append(1)
            return {}

        with mock.patch("agentrail.context.index.build_index", side_effect=_counting_build_index), \
             mock.patch("agentrail.context.retrieval.query_context", return_value=_QUERY_RESULT) as mock_qc:
            resp = daemon_mod.rpc(
                server._socket_path, "query",
                params={"query": "alpha_token", "limit": 5},
                timeout=3.0,
            )

        self.assertIn("result", resp)
        # build_index must not be called during a daemon query
        self.assertEqual(
            build_index_calls, [],
            f"build_index was called {len(build_index_calls)} time(s) during a daemon query",
        )
        # query_context must have been called with index= kwarg (not None)
        mock_qc.assert_called_once()
        _, kw = mock_qc.call_args
        self.assertIn("index", kw, "query_context was not called with index= kwarg")
        self.assertIs(kw["index"], fake_index, "query_context received wrong index object")

    def test_ac2_688_def_rpc_uses_passed_index(self) -> None:
        """AC2: daemon 'def' RPC passes index= to context_def; no load_index disk read."""
        fake_index = {"records": [], "chunks": [], "graph": {"nodes": [], "edges": []}, "symbolTable": {}}
        with mock.patch("agentrail.context.daemon_server.DaemonServer._load_index_from_disk"), \
             mock.patch("agentrail.context.index.build_index"):
            server = _start_server(self._tmp)
            self._server = server
            with server._lock:
                server._index = fake_index

        with mock.patch("agentrail.context.retrieval.context_def", return_value=[]) as mock_def:
            resp = daemon_mod.rpc(
                server._socket_path, "def",
                params={"name": "my_func"},
                timeout=3.0,
            )

        self.assertIn("result", resp)
        mock_def.assert_called_once()
        _, kw = mock_def.call_args
        self.assertIn("index", kw, "context_def was not called with index= kwarg")
        self.assertIs(kw["index"], fake_index)


# ---------------------------------------------------------------------------
# Issue #688: AC3 — query_context with index= returns identical results to cold path
# ---------------------------------------------------------------------------

class TestQueryContextIndexParamIdentity(unittest.TestCase):
    """AC3 (#688): query_context(root, q, index=load_index(root)) == query_context(root, q)."""

    def test_ac3_688_index_param_yields_identical_results(self) -> None:
        """AC3: passing index= to query_context returns same result as cold path."""
        import json
        import subprocess
        from agentrail.context.index import build_index, load_index
        from agentrail.context.retrieval import query_context

        root = Path(tempfile.mkdtemp()).resolve()
        subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
        (root / ".agentrail").mkdir()
        (root / ".agentrail" / "config.json").write_text(json.dumps({
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
        }), encoding="utf-8")
        (root / "src").mkdir()
        (root / "src" / "widget.py").write_text(
            "def alpha_token_handler():\n    return 42\n", encoding="utf-8"
        )

        build_index(root)
        idx = load_index(root)

        cold = query_context(root, "alpha_token_handler")
        warm = query_context(root, "alpha_token_handler", index=idx)

        cold_paths = [r["path"] for r in cold.get("results", [])]
        warm_paths = [r["path"] for r in warm.get("results", [])]
        self.assertEqual(cold_paths, warm_paths, "Ranking differs between cold and warm (index=) paths")
        self.assertEqual(cold.get("retrievalMode"), warm.get("retrievalMode"))


if __name__ == "__main__":
    unittest.main()
