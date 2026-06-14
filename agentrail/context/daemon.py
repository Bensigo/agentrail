"""Daemon helpers for the warm context query daemon.

This module provides the thin interface consumed by the daemon CLI subcommands:

  socket_path_for(target) -> Path
  start_detached(target) -> int          # returns PID
  ping(socket_path, timeout=2.0) -> bool
  rpc(socket_path, method, timeout=5.0) -> dict

The actual Unix-socket server process lives in daemon_server.py (the daemon
core issue).  This module only contains the operator-side helpers needed by
``agentrail context daemon start|stop|status``.
"""
from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Socket-path derivation
# ---------------------------------------------------------------------------

# Formula: ~/.agentrail/daemon-<sha256(str(realpath(target)))[:8]>.sock
#
# The sha256 prefix is intentional: AFK runs multiple worktrees concurrently,
# each with a different resolved --target path.  Keying the socket name on a
# hash of that path guarantees per-worktree isolation — two worktrees sharing
# the same daemon socket would corrupt each other's index state.
#
# Note: callers are responsible for resolving symlinks before passing *target*
# (i.e. ``target = Path(target).resolve()``).  The hash covers the resolved
# string so that ``/repo`` and ``/private/repo`` (macOS symlink for /var)
# produce the same socket path when they resolve to the same inode.
SOCKET_PATH_FORMULA = "~/.agentrail/daemon-<sha256(str(realpath(target)))[:8]>.sock"


def _target_hash(target: Path) -> str:
    """Return an 8-char hex digest keyed on the resolved absolute target path.

    The target is resolved here so the socket path is identical whether the
    caller passes a raw or already-resolved path. This MUST match the server,
    which resolves its target before binding (daemon_server.py: ``target.resolve()``);
    without resolving here, a caller passing ``/var/...`` would look at a
    different socket than the server bound at ``/private/var/...`` (macOS
    symlink), so the daemon would appear absent and every query fell back to
    the cold path.
    """
    return hashlib.sha256(str(Path(target).resolve()).encode()).hexdigest()[:8]


def socket_path_for(target: Path) -> Path:
    """Return the Unix-domain socket path for *target*.

    The path is keyed by a hash of the resolved absolute target path so that
    different worktrees never share a socket.  See :data:`SOCKET_PATH_FORMULA`
    for the exact formula and rationale.

    Layout: ``~/.agentrail/daemon-<hash>.sock``
    """
    home_dir = Path.home() / ".agentrail"
    home_dir.mkdir(parents=True, exist_ok=True)
    return home_dir / f"daemon-{_target_hash(target)}.sock"


# ---------------------------------------------------------------------------
# RPC client
# ---------------------------------------------------------------------------

def rpc(
    socket_path: Path,
    method: str,
    timeout: float = 5.0,
    *,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Send a JSON-RPC-style request to the daemon and return the response dict.

    Raises ``ConnectionRefusedError`` / ``FileNotFoundError`` if the socket is
    absent or connection is refused.  Raises ``TimeoutError`` if no response
    arrives within *timeout* seconds.  Raises ``ValueError`` on malformed JSON.

    *params* is an optional dict sent as the ``"params"`` field of the request.
    When ``None`` (the default), the field is omitted for backward compatibility.
    """
    payload: dict[str, Any] = {"method": method}
    if params is not None:
        payload["params"] = params
    request = json.dumps(payload).encode()
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect(str(socket_path))
        sock.sendall(request)
        # Signal end-of-request so the server can read cleanly
        try:
            sock.shutdown(socket.SHUT_WR)
        except OSError:
            pass
        chunks: list[bytes] = []
        while True:
            try:
                chunk = sock.recv(4096)
            except socket.timeout as exc:
                raise TimeoutError(f"No response from daemon at {socket_path}") from exc
            if not chunk:
                break
            chunks.append(chunk)
        raw = b"".join(chunks)
    finally:
        sock.close()
    return json.loads(raw.decode())


def ping(socket_path: Path, timeout: float = 2.0) -> bool:
    """Return True if the daemon at *socket_path* responds to a status ping."""
    try:
        rpc(socket_path, "status", timeout=timeout)
        return True
    except (OSError, TimeoutError, ValueError, ConnectionRefusedError):
        return False


# ---------------------------------------------------------------------------
# Start detached daemon
# ---------------------------------------------------------------------------

def start_detached(target: Path) -> int:
    """Spawn the daemon server as a detached background process.

    Returns the PID of the spawned process.  The daemon outlives the CLI
    because it is started with ``start_new_session=True`` (which calls
    ``setsid()`` on POSIX), detaching it from the terminal session.
    """
    # The server module must be importable as agentrail.context.daemon_server.
    # If it does not exist yet the CLI will catch the ImportError / FileNotFoundError
    # and tell the user to install the daemon core.
    server_module = "agentrail.context.daemon_server"
    cmd = [sys.executable, "-m", server_module, "--target", str(target)]
    proc = subprocess.Popen(
        cmd,
        start_new_session=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return proc.pid


# ---------------------------------------------------------------------------
# Wait helpers
# ---------------------------------------------------------------------------

def _wait_for_socket(socket_path: Path, timeout: float = 10.0, interval: float = 0.1) -> bool:
    """Poll until the socket file appears and ping succeeds, or *timeout* expires."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if socket_path.exists() and ping(socket_path):
            return True
        time.sleep(interval)
    return False


def _wait_for_socket_gone(socket_path: Path, timeout: float = 5.0, interval: float = 0.1) -> bool:
    """Poll until the socket file disappears, or *timeout* expires."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not socket_path.exists():
            return True
        time.sleep(interval)
    return False


# ---------------------------------------------------------------------------
# __main__ shim — allows: python -m agentrail.context.daemon --target DIR
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    from agentrail.context.daemon_server import main as _server_main
    _server_main()
