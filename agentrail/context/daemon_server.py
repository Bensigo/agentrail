"""Context daemon server process — persistent in-memory index server.

Run as a standalone module::

    python -m agentrail.context.daemon_server --target /path/to/repo

The server binds a Unix-domain socket at the path returned by
``daemon.socket_path_for(target)`` and speaks a minimal request/response
JSON protocol (one JSON object per connection, no streaming):

  Request:  ``{"method": "query", "params": {...}}``
  Response: ``{"result": ...}``  or  ``{"error": "<message>"}``

Supported methods: query, search, def, callers, callees, impact, status,
ping, shutdown.

The daemon keeps the index warm via a background freshness thread (30 s
interval) that re-indexes without blocking in-flight requests.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import socket
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Threading-local guard: suppresses synchronous build_index inside daemon
# request threads.  Set before calling retrieval functions that call build_index.
# ---------------------------------------------------------------------------
_serve_cached = threading.local()


def _is_serve_cached() -> bool:
    return getattr(_serve_cached, "active", False)


# ---------------------------------------------------------------------------
# Daemon server class
# ---------------------------------------------------------------------------

class DaemonServer:
    """Persistent Unix-socket JSON-RPC server for the context index."""

    def __init__(self, target: Path) -> None:
        self._root = target.resolve()
        self._socket_path: Path = _socket_path_for(self._root)
        self._lock = threading.Lock()
        self._index: Dict[str, Any] = {}
        self._postings: Dict[str, Any] = {}
        self._started_at: datetime = datetime.now(timezone.utc)
        self._last_indexed_at: datetime | None = None
        self._state: str = "starting"
        self._stop_event = threading.Event()
        self._server_sock: socket.socket | None = None
        self._reindex_thread: threading.Thread | None = None

    # ------------------------------------------------------------------
    # Startup / index loading
    # ------------------------------------------------------------------

    def _load_index_from_disk(self) -> None:
        """Load (or reload) index.json + postings.json from disk into memory."""
        from agentrail.context.index import load_index
        index_dir = self._root / ".agentrail" / "context" / "index"
        index = load_index(self._root)
        postings: Dict[str, Any] = {}
        postings_path = index_dir / "postings.json"
        if postings_path.exists():
            try:
                postings = json.loads(postings_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                postings = {}
        with self._lock:
            self._index = index
            self._postings = postings
            self._last_indexed_at = datetime.now(timezone.utc)
            self._state = "running"

    # ------------------------------------------------------------------
    # Freshness / background re-index
    # ------------------------------------------------------------------

    def _is_fresh(self) -> bool:
        """Return True if the on-disk index is up-to-date."""
        from agentrail.context.index import _cached_index_is_fresh
        from agentrail.context.config import read_context_config
        index_path = self._root / ".agentrail" / "context" / "index" / "index.json"
        try:
            cfg = read_context_config(self._root)
            return _cached_index_is_fresh(self._root, cfg, index_path)
        except Exception:
            return False

    def _do_reindex(self) -> None:
        """Run build_index in a background thread and atomically swap the index."""
        try:
            from agentrail.context.index import build_index
            build_index(self._root)
            self._load_index_from_disk()
        except Exception as exc:
            logger.warning("daemon reindex failed: %s", exc)
            with self._lock:
                self._state = "error"

    def _freshness_loop(self) -> None:
        """Periodically check staleness and trigger background re-index."""
        while not self._stop_event.wait(30.0):
            try:
                if not self._is_fresh():
                    with self._lock:
                        if self._state != "stale":
                            self._state = "stale"
                    # Only one reindex thread at a time
                    if self._reindex_thread is None or not self._reindex_thread.is_alive():
                        t = threading.Thread(target=self._do_reindex, daemon=True)
                        self._reindex_thread = t
                        t.start()
            except Exception as exc:
                logger.debug("freshness check error: %s", exc)

    # ------------------------------------------------------------------
    # RPC method dispatch
    # ------------------------------------------------------------------

    def _handle_request(self, req: Dict[str, Any]) -> Dict[str, Any]:
        method = req.get("method", "")
        params = req.get("params") or {}

        if method == "ping":
            return {"result": "pong"}

        if method == "status":
            with self._lock:
                state = self._state
                last_indexed = self._last_indexed_at
            uptime = (datetime.now(timezone.utc) - self._started_at).total_seconds()
            return {
                "pid": os.getpid(),
                "uptimeSeconds": uptime,
                "lastIndexedAt": last_indexed.isoformat() if last_indexed else None,
                "socketPath": str(self._socket_path),
                "state": state,
            }

        if method == "shutdown":
            self._stop_event.set()
            return {"ok": True}

        # Retrieval methods — serve from in-memory index (no rebuild)
        _serve_cached.active = True
        try:
            return self._dispatch_retrieval(method, params)
        finally:
            _serve_cached.active = False

    def _dispatch_retrieval(self, method: str, params: Dict[str, Any]) -> Dict[str, Any]:
        from agentrail.context.retrieval import (
            query_context,
            search_context,
            context_def,
            context_callers,
            context_callees,
            context_impact,
        )
        root = self._root
        try:
            if method == "query":
                query = params.get("query", "")
                limit = int(params.get("limit", 20))
                return {"result": query_context(root, query, limit=limit)}
            if method == "search":
                query = params.get("query", "")
                limit = int(params.get("limit", 20))
                return {"result": search_context(root, query, limit=limit)}
            if method == "def":
                name = params.get("name", "")
                return {"result": context_def(root, name)}
            if method == "callers":
                name = params.get("name", "")
                return {"result": context_callers(root, name)}
            if method == "callees":
                name = params.get("name", "")
                return {"result": context_callees(root, name)}
            if method == "impact":
                name = params.get("name", "")
                depth = int(params.get("depth", 3))
                return {"result": context_impact(root, name, depth=depth)}
            return {"error": f"unknown method: {method}"}
        except Exception as exc:
            return {"error": str(exc)}

    # ------------------------------------------------------------------
    # Connection handler
    # ------------------------------------------------------------------

    def _handle_conn(self, conn: socket.socket) -> None:
        try:
            chunks: list[bytes] = []
            conn.settimeout(5.0)
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
            except (ValueError, UnicodeDecodeError) as exc:
                resp = {"error": f"invalid JSON: {exc}"}
                conn.sendall(json.dumps(resp).encode())
                return
            resp = self._handle_request(req)
            conn.sendall(json.dumps(resp).encode())
        except OSError:
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass

    # ------------------------------------------------------------------
    # Main serve loop
    # ------------------------------------------------------------------

    def serve(self) -> None:
        """Start the server: load index, bind socket, accept connections."""
        # Initial index load (best-effort — socket opens even if index missing)
        try:
            from agentrail.context.index import build_index
            build_index(self._root)
            self._load_index_from_disk()
        except Exception as exc:
            logger.warning("initial index load failed: %s", exc)
            with self._lock:
                self._state = "error"
                self._last_indexed_at = datetime.now(timezone.utc)

        # Install signal handlers (only valid in the main thread)
        def _handle_signal(signum: int, frame: object) -> None:
            self._stop_event.set()

        if threading.current_thread() is threading.main_thread():
            signal.signal(signal.SIGTERM, _handle_signal)
            signal.signal(signal.SIGINT, _handle_signal)

        # Start freshness thread
        ft = threading.Thread(target=self._freshness_loop, daemon=True)
        ft.start()

        # Bind socket
        sock_path = self._socket_path
        sock_path.parent.mkdir(parents=True, exist_ok=True)
        if sock_path.exists():
            sock_path.unlink()

        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._server_sock = server
        try:
            server.bind(str(sock_path))
            server.listen(32)
            server.settimeout(0.5)
            while not self._stop_event.is_set():
                try:
                    conn, _ = server.accept()
                except socket.timeout:
                    continue
                t = threading.Thread(target=self._handle_conn, args=(conn,), daemon=True)
                t.start()
        finally:
            try:
                server.close()
            except OSError:
                pass
            try:
                sock_path.unlink(missing_ok=True)
            except OSError:
                pass

        self._stop_event.wait()


# ---------------------------------------------------------------------------
# Socket path helper (mirrors daemon.socket_path_for but avoids circular import)
# ---------------------------------------------------------------------------

def _socket_path_for(target: Path) -> Path:
    """Return socket path for *target* (resolved absolute path)."""
    from agentrail.context.daemon import socket_path_for
    return socket_path_for(target)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="agentrail context daemon server",
        prog="python -m agentrail.context.daemon_server",
    )
    parser.add_argument("--target", required=True, help="repository root directory")
    parser.add_argument("--log-level", default="WARNING", help="logging level")
    args = parser.parse_args(argv)

    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.WARNING))

    target = Path(args.target).resolve()
    server = DaemonServer(target)
    server.serve()


if __name__ == "__main__":
    main()
