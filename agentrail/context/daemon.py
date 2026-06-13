"""Context daemon: holds index/symbols/calls/postings hot in memory.

Run as:
    python -m agentrail.context.daemon --target DIR

Listens on a Unix domain socket at ~/.agentrail/daemon-<hash16>.sock and
speaks newline-delimited JSON-RPC:

    request:   {"method": <str>, "params": <dict>}
    response:  {"result": <any>} | {"error": <str>}

One request/response pair per connection; each line is a complete JSON object.

Methods mirror the retrieval functions in retrieval.py:
    query     → query_context(root, query, limit=20)
    search    → search_context(root, query, limit=20)
    def       → context_def(root, name)
    callers   → context_callers(root, name)
    callees   → context_callees(root, name)
    impact    → context_impact(root, name, depth=3)
    status    → {pid, uptimeSeconds, lastIndexedAt, socketPath, state}
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import signal
import socketserver
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from agentrail.context.config import read_context_config
from agentrail.context.index import _cached_index_is_fresh, build_index
from agentrail.context.retrieval import (
    context_callers,
    context_callees,
    context_def,
    context_impact,
    query_context,
    search_context,
)

logger = logging.getLogger(__name__)

_POLL_INTERVAL = 30  # seconds between freshness checks


def daemon_socket_path(target_dir: str | Path) -> Path:
    """Return the Unix socket path for a given target directory.

    The path is derived from the SHA-256 of the realpath of ``target_dir`` so
    that two daemons pointed at different directories never share a socket, and
    two daemons pointed at the same directory (possibly via symlinks) always
    share one.
    """
    real = os.path.realpath(str(target_dir))
    h = hashlib.sha256(real.encode()).hexdigest()[:16]
    sock_dir = Path.home() / ".agentrail"
    sock_dir.mkdir(parents=True, exist_ok=True)
    return sock_dir / f"daemon-{h}.sock"


class ContextDaemon:
    """Persistent in-process context daemon.

    Startup sequence:
    1. ``build_index(root)`` primes the on-disk index (fast cache-hit if fresh).
    2. Binds a ``ThreadingUnixStreamServer`` on the per-target socket path.
    3. Starts a background poller that checks freshness every ``poll_interval``
       seconds; on stale, re-runs ``build_index`` and swaps state to "running".
    4. Serves JSON-RPC requests in handler threads that call retrieval functions
       directly.  In-process ``_index_cache`` in index.py keeps data hot across
       handler calls so every request is a memory hit unless the index was just
       rebuilt.
    """

    def __init__(self, target_dir: Path, *, poll_interval: float = _POLL_INTERVAL) -> None:
        self.root = Path(os.path.realpath(str(target_dir)))
        self.socket_path = daemon_socket_path(self.root)
        self.poll_interval = poll_interval

        # Daemon identity / status fields (read under _lock)
        self.pid: int = os.getpid()
        self.started_at: float = time.time()
        self.last_indexed_at: Optional[float] = None
        self.state: str = "running"

        self._lock = threading.Lock()
        self._server: Optional[socketserver.TCPServer] = None
        self._stop_event = threading.Event()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _do_index(self) -> None:
        """Run build_index (may be a fast cache hit); update last_indexed_at."""
        try:
            build_index(self.root)
            with self._lock:
                self.last_indexed_at = time.time()
                self.state = "running"
        except Exception:
            logger.exception("Re-index failed for %s", self.root)
            with self._lock:
                self.state = "error"

    def _freshness_loop(self) -> None:
        """Background thread: poll staleness every poll_interval seconds.

        On stale: set state → "stale", trigger _do_index(), then state → "running".
        Serves the previous in-process _index_cache during the rebuild window.
        """
        while not self._stop_event.wait(self.poll_interval):
            try:
                cfg = read_context_config(self.root)
                index_path = self.root / ".agentrail" / "context" / "index" / "index.json"
                fresh = _cached_index_is_fresh(self.root, cfg, index_path)
                if not fresh:
                    with self._lock:
                        self.state = "stale"
                    self._do_index()
            except Exception:
                logger.exception("Freshness check failed for %s", self.root)

    # ------------------------------------------------------------------
    # Dispatch
    # ------------------------------------------------------------------

    def dispatch(self, method: str, params: Dict[str, Any]) -> Any:
        """Dispatch a JSON-RPC method call; return the result (serialisable)."""
        root = self.root
        if method == "query":
            return query_context(root, params["query"], limit=int(params.get("limit", 20)))
        if method == "search":
            return search_context(root, params["query"], limit=int(params.get("limit", 20)))
        if method == "def":
            return context_def(root, params["name"])
        if method == "callers":
            return context_callers(root, params["name"])
        if method == "callees":
            return context_callees(root, params["name"])
        if method == "impact":
            return context_impact(root, params["name"], depth=int(params.get("depth", 3)))
        if method == "status":
            return self._status()
        raise ValueError(f"Unknown method: {method!r}")

    def _status(self) -> Dict[str, Any]:
        with self._lock:
            uptime = time.time() - self.started_at
            last_indexed: Optional[str] = None
            if self.last_indexed_at is not None:
                last_indexed = (
                    datetime.fromtimestamp(self.last_indexed_at, tz=timezone.utc)
                    .isoformat(timespec="milliseconds")
                    .replace("+00:00", "Z")
                )
            return {
                "pid": self.pid,
                "uptimeSeconds": uptime,
                "lastIndexedAt": last_indexed,
                "socketPath": str(self.socket_path),
                "state": self.state,
            }

    # ------------------------------------------------------------------
    # Server lifecycle
    # ------------------------------------------------------------------

    def run(self) -> None:
        """Start the daemon: prime index, bind socket, serve until stopped."""
        # 1. Prime the index (fast cache-hit if already fresh on disk).
        self._do_index()

        # 2. Bind socket (unlink stale socket from a prior crashed daemon first).
        sock_path = str(self.socket_path)
        try:
            # Probe: if a live daemon is already on this socket, leave it alone.
            probe = __import__("socket").socket(__import__("socket").AF_UNIX, __import__("socket").SOCK_STREAM)
            try:
                probe.connect(sock_path)
                probe.close()
                raise RuntimeError(f"A live daemon is already listening at {sock_path}")
            except (OSError, ConnectionRefusedError):
                probe.close()
        except RuntimeError:
            raise
        except Exception:
            pass  # No live daemon; safe to (re)create the socket file.
        try:
            os.unlink(sock_path)
        except OSError:
            pass

        daemon = self

        class _Handler(socketserver.StreamRequestHandler):
            """Handle one connection: read one JSON-RPC request, write response."""

            def handle(self) -> None:
                for raw_line in self.rfile:
                    line = raw_line.strip()
                    if not line:
                        continue
                    try:
                        req = json.loads(line)
                    except json.JSONDecodeError as exc:
                        self._send({"error": f"invalid JSON: {exc}"})
                        continue
                    method = req.get("method", "")
                    params = req.get("params") or {}
                    try:
                        result = daemon.dispatch(method, params)
                        self._send({"result": result})
                    except Exception as exc:
                        self._send({"error": str(exc)})

            def _send(self, obj: Any) -> None:
                self.wfile.write((json.dumps(obj) + "\n").encode())

        # 3. Set up signal handlers (only on the main thread; tests run daemons
        #    in worker threads where signal registration is disallowed).
        def _shutdown(signum: int, frame: Any) -> None:
            self._stop_event.set()
            if self._server is not None:
                threading.Thread(target=self._server.shutdown, daemon=True).start()

        if threading.current_thread() is threading.main_thread():
            signal.signal(signal.SIGTERM, _shutdown)
            signal.signal(signal.SIGINT, _shutdown)

        # 4. Start freshness poller.
        poller = threading.Thread(target=self._freshness_loop, daemon=True, name="daemon-poller")
        poller.start()

        # 5. Serve.
        try:
            server = socketserver.ThreadingUnixStreamServer(sock_path, _Handler)
            server.daemon_threads = True
            self._server = server
            server.serve_forever()
        finally:
            try:
                os.unlink(sock_path)
            except OSError:
                pass


def main(argv: List[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="AgentRail context daemon")
    parser.add_argument("--target", required=True, help="Target repository directory")
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=_POLL_INTERVAL,
        metavar="SECS",
        help="Freshness poll interval in seconds (default: %(default)s)",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    target = Path(args.target)
    if not target.is_dir():
        parser.error(f"Target directory does not exist: {target}")

    ContextDaemon(target, poll_interval=args.poll_interval).run()


if __name__ == "__main__":
    main()
