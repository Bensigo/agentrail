"""Boot lifecycle for preview sandboxes (B2b "boot plane", Task 6).

Clones a PR head, boots it as a supervised child process on the host, polls
it healthy over TCP+HTTP, and tears it down. This is the ONLY module in the
boot plane that actually spawns the untrusted repo's own start command as a
live child process — every other Task 6 concern (recipe detection, queueing)
happens elsewhere and never touches a process.

Security invariant (load-bearing — see ``TestBootEnvSecurityInvariant`` in
the test suite): the boot child runs UNTRUSTED repo code checked out from a
PR. Its environment is built ONLY through
:func:`agentrail.sandbox.native_runner.build_native_child_env` — the same
public-safe boundary the host-native agent runner uses — plus the two
values the child legitimately needs to bind correctly (``PORT``, ``HOST``).
It is NEVER handed a raw copy of the caller's/fleet's own process env
(``os.environ``), which on a real fleet host carries ``DATABASE_URL``,
``FLEET_CONSOLE_TOKEN`` (mints every tenant's runner token), and
``AUTH_SECRET``. A malicious repo driving its own "start" command could
otherwise ``printenv`` its way to any of them.

Reachability: the child binds ``0.0.0.0:<port>`` (so it can actually accept
the loopback connection health_check makes, and — later — a reverse proxy
on the same host); ``health_check`` always probes ``127.0.0.1:<port>``; the
``url`` handed back in :class:`BootHandle` uses the CALLER-supplied
``advertise_host``, never a public interface literal. This module never
itself binds a public interface.
"""
from __future__ import annotations

import contextlib
import os
import shutil
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

from agentrail.sandbox.clone_auth import authenticated_clone_url, redact_token
from agentrail.sandbox.native_runner import build_native_child_env
from agentrail.sandbox.preview_recipe import PreviewRecipe

# TCP connect + HTTP GET probe timeouts for a SINGLE health_check attempt —
# deliberately short and fixed, independent of the caller's overall
# ``timeout`` (which bounds the whole poll loop, not any one attempt).
_PROBE_CONNECT_TIMEOUT = 1.0
_PROBE_HTTP_TIMEOUT = 1.0

# Boot-child stdout+stderr are teed to this file inside clone_dir (not a
# pipe): a pipe can deadlock the parent if a grandchild the recipe spawns
# keeps the write end open after the direct child exits (the exact hazard
# agentrail/run/proc.py's run_with_timeout works around with a reader
# thread) — a file has no such failure mode and needs no draining thread.
# It lives INSIDE clone_dir so ordinary teardown (rmtree) cleans it up too;
# on a health-check failure its tail is read out BEFORE that rmtree runs.
_LOG_FILENAME = ".agentrail-preview-boot.log"
_LOG_TAIL_BYTES = 4000

# subprocess.run's captured stdout/stderr on an install failure is bounded
# to this many trailing lines in the raised BootError, mirroring
# native_runner.py's own _LOGS_TAIL_LINES convention.
_INSTALL_TAIL_LINES = 40


@dataclass
class BootHandle:
    """A live, health-checked boot child. Returned only once the port is
    confirmed serving; ``teardown`` is the only valid way to end its life."""

    proc: subprocess.Popen
    pgid: int
    port: int
    url: str  # http://<advertise_host>:<port>
    clone_dir: str


class BootError(RuntimeError):
    """Raised when a boot step (install, spawn, or health-check) fails.

    By the time this is raised, :func:`boot` has already cleaned up
    anything it started for this attempt — no leaked process, no leftover
    ``clone_dir`` — so callers never need a compensating teardown of their
    own on this path.
    """


# ---------------------------------------------------------------------------
# clone_pr_head
# ---------------------------------------------------------------------------


def clone_pr_head(
    repo_url: str,
    ref: str,
    dest: str,
    *,
    token: str,
    runner=subprocess,
    timeout: float = 120.0,
) -> None:
    """Shallow-clone ``repo_url`` into ``dest``, then land it exactly on a PR
    head's commit: ``ref`` may be a bare commit SHA or a
    ``refs/pull/<N>/head`` ref, and ``git clone --branch`` accepts NEITHER
    form (a bare SHA is rejected outright; a ``refs/pull/...`` ref is not a
    branch/tag name on the ``origin`` remote git's ``--branch`` resolves
    against). So instead of ``--branch`` (the approach
    ``agentrail.runner.onboard._clone`` uses for an ordinary branch/tag
    ref), this always does three steps:

      1. ``git clone --depth 1 <authed-url> dest`` — shallow clone of
         whatever the default branch happens to be; its content is
         irrelevant, this step exists only to create ``dest`` as a git
         checkout with ``origin`` configured (and — since ``clone_url``
         embeds the token — already authenticated for the next step).
      2. ``git -C dest fetch --depth 1 origin <ref>`` — fetches exactly
         ``ref`` (whatever form it takes) as ``FETCH_HEAD``, without ever
         needing it to be a resolvable branch/tag name.
      3. ``git -C dest checkout FETCH_HEAD`` — lands the working tree on it.

    ``token`` (a workspace's connected GitHub OAuth token, or a locally
    configured PAT) is embedded as HTTP Basic auth in the clone URL via
    :func:`agentrail.sandbox.clone_auth.authenticated_clone_url` — the SAME
    mechanism ``onboard.py``'s own clone uses. Because step 1's URL carries
    it, ``origin`` is already authenticated for steps 2/3, which is why
    only the clone step's argv needs the credentialed URL.

    Every failure path is routed through
    :func:`agentrail.sandbox.clone_auth.redact_token` before it can leave
    this function — both a non-zero exit's captured stderr AND a raised
    subprocess-level exception's own message, since (per that function's
    docstring) ``subprocess.CalledProcessError``/``TimeoutExpired.__str__()``
    unconditionally embed the raw argv they were constructed with, which
    for the clone step includes the credential-embedded URL regardless of
    what git itself printed.

    ``runner`` is injected (default :mod:`subprocess`) so tests never touch
    the network — mirrors ``agentrail.runner.onboard._clone``'s own seam.
    Raises :class:`RuntimeError`, always token-redacted, on any failure.
    """
    clone_url = authenticated_clone_url(repo_url, token)

    def _run(argv: list, *, cwd: str | None, step: str) -> None:
        try:
            proc = runner.run(argv, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        except (subprocess.SubprocessError, OSError) as exc:
            raise RuntimeError(redact_token(f"{step} failed: {exc}", token)) from None
        if getattr(proc, "returncode", 1) != 0:
            stderr = redact_token((getattr(proc, "stderr", "") or "")[-500:].strip(), token)
            raise RuntimeError(f"{step} failed: {stderr or '(no output)'}")

    _run(["git", "clone", "--depth", "1", clone_url, dest], cwd=None, step="git clone")
    _run(["git", "fetch", "--depth", "1", "origin", ref], cwd=dest, step="git fetch")
    _run(["git", "checkout", "FETCH_HEAD"], cwd=dest, step="git checkout")


# ---------------------------------------------------------------------------
# pick_free_port
# ---------------------------------------------------------------------------


def pick_free_port() -> int:
    """A currently-free TCP port on ``127.0.0.1``: bind port 0 (the OS
    assigns a free ephemeral port), read it back, close the socket.

    Race-tolerant, not race-free, by design for v1: another process could
    bind the same port in the gap between this returning and the caller's
    own bind. Acceptable here because the caller (``boot``) binds it within
    the same host, immediately, single-threaded per boot attempt; a v2
    hardening would hold the listening socket open across the handoff
    (e.g. via ``SO_REUSEPORT``) instead of closing and re-binding.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


# ---------------------------------------------------------------------------
# health_check
# ---------------------------------------------------------------------------


def _probe_once(port: int, ready_path: str) -> bool:
    """A single TCP-then-HTTP attempt. TCP connect first (cheap, tells us
    the child is at least listening) before ever issuing an HTTP request —
    if a request landed on a closed/unlistening port it would just raise
    the same broad connection error the TCP probe already distinguishes
    more cheaply. ``ready_path`` need only respond < 500: a 404 still means
    a real HTTP server answered on that port (many recipes' default
    ready_path of "/" resolves this way for e.g. a JSON API with no root
    route) — 5xx means the process is up but not yet actually healthy.
    """
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=_PROBE_CONNECT_TIMEOUT):
            pass
    except OSError:
        return False

    url = f"http://127.0.0.1:{port}{ready_path}"
    try:
        with urllib.request.urlopen(url, timeout=_PROBE_HTTP_TIMEOUT) as resp:
            return resp.status < 500
    except urllib.error.HTTPError as exc:
        # HTTPError IS urlopen's normal way of surfacing a non-2xx/3xx
        # response (it is not a transport failure) — its .code is the real
        # status.
        return exc.code < 500
    except (urllib.error.URLError, OSError, ValueError):
        return False


def health_check(port: int, ready_path: str, *, timeout: float, interval: float = 0.5) -> bool:
    """Poll ``127.0.0.1:<port>`` + ``ready_path`` until healthy or
    ``timeout`` elapses. Mirrors ``agentrail.context.daemon._wait_for_socket``'s
    monotonic-deadline + sleep(interval) shape, over TCP+HTTP instead of a
    unix socket file. Always attempts at least once, even for a ``timeout``
    of 0 — there is never a reason to report "unhealthy" without having
    actually tried.
    """
    deadline = time.monotonic() + timeout
    while True:
        if _probe_once(port, ready_path):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(interval)


# ---------------------------------------------------------------------------
# Process-group spawn/kill idiom (mirrors agentrail/run/proc.py)
# ---------------------------------------------------------------------------


def _process_group_id(proc: subprocess.Popen) -> int:
    """The pgid of a child spawned with ``start_new_session=True``.

    POSIX guarantees this equals ``proc.pid`` (``setsid()`` runs in the
    child before exec, making it its own session+group leader), so reading
    it via ``os.getpgid`` immediately after ``Popen`` returns is non-racy —
    the process is guaranteed to exist at that instant. Captured once, at
    spawn time, and carried on :class:`BootHandle` so :func:`teardown`
    never has to call ``getpgid`` again later — a LATER call could raise
    ``ProcessLookupError`` if the leader has already exited on its own,
    which would abort a group-kill before it reaches any still-alive
    grandchildren (the exact hazard ``agentrail/run/proc.py``'s
    ``_kill_tree`` comment documents). Falls back to ``proc.pid`` on
    platforms without process groups (``os.getpgid`` doesn't exist, e.g.
    Windows) — this codebase's fleet hosts are POSIX, matching the
    ``hasattr(os, "killpg")`` guard used at kill time everywhere else.
    """
    if hasattr(os, "getpgid"):
        with contextlib.suppress(ProcessLookupError, OSError):
            return os.getpgid(proc.pid)
    return proc.pid


def _kill_process_group(proc: subprocess.Popen, pgid: int) -> None:
    """SIGKILL the whole process group, then reap the leader so its pid is
    fully released (not left a zombie) by the time this returns. Mirrors
    ``agentrail/run/proc.py``'s ``_kill_tree`` idiom. Best-effort and
    idempotent: an already-dead group/leader is treated as success, never
    raises.
    """
    if hasattr(os, "killpg"):
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(pgid, signal.SIGKILL)
    else:  # pragma: no cover - fleet hosts are POSIX; kept for parity with proc.py's guard
        with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
            proc.kill()
    with contextlib.suppress(subprocess.TimeoutExpired):
        proc.wait(timeout=5)


def _tail_bytes(path: str, max_bytes: int = _LOG_TAIL_BYTES) -> str:
    """The trailing ``max_bytes`` of a file, decoded leniently. Empty
    string on any I/O problem (e.g. the file was never created) rather
    than raising — this only ever feeds a best-effort error message.
    """
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - max_bytes))
            data = fh.read()
    except OSError:
        return ""
    return data.decode("utf-8", errors="replace").strip()


def _tail_text(stdout: str, stderr: str, *, max_lines: int = _INSTALL_TAIL_LINES) -> str:
    """Trailing lines of whichever of stdout/stderr is non-empty, preferring
    stdout — mirrors ``native_runner.py``'s own ``_logs_tail`` convention."""
    body = stdout if (stdout or "").strip() else (stderr or "")
    lines = body.splitlines()
    return "\n".join(lines[-max_lines:]).strip()


# ---------------------------------------------------------------------------
# boot / teardown
# ---------------------------------------------------------------------------


def _run_install(argv: list, clone_dir: str, process_env: dict, timeout: float) -> None:
    """Run ``recipe.install`` in ``clone_dir``, capped at ``timeout``.

    Uses the SAME public-safe env boundary as the boot child itself
    (``build_native_child_env`` with no extra caller_env) — install steps
    (``npm ci``, etc.) are just as untrusted as the start command; there is
    no reason to hand them anything more.

    On any failure (couldn't start, timed out, non-zero exit) this removes
    ``clone_dir`` itself before raising :class:`BootError` — no process was
    spawned yet at this point (this always runs before the start command),
    so there is nothing else to clean up.
    """
    install_env = build_native_child_env(process_env, {})
    try:
        result = subprocess.run(
            argv, cwd=clone_dir, env=install_env, timeout=timeout,
            capture_output=True, text=True,
        )
    except subprocess.TimeoutExpired:
        shutil.rmtree(clone_dir, ignore_errors=True)
        raise BootError(f"install step timed out after {timeout}s: {argv!r}") from None
    except (subprocess.SubprocessError, OSError) as exc:
        shutil.rmtree(clone_dir, ignore_errors=True)
        raise BootError(f"install step failed to start: {exc}") from None
    if result.returncode != 0:
        tail = _tail_text(result.stdout, result.stderr)
        shutil.rmtree(clone_dir, ignore_errors=True)
        raise BootError(
            f"install step {argv!r} exited {result.returncode}: {tail or '(no output)'}"
        )


def boot(
    recipe: PreviewRecipe,
    clone_dir: str,
    *,
    advertise_host: str,
    process_env: dict,
    timeout: float,
) -> BootHandle:
    """Install (if configured), spawn, and health-check ``recipe`` inside
    ``clone_dir``. Returns a :class:`BootHandle` only once the port is
    confirmed serving.

    ``process_env`` is the CALLER's own process environment (e.g.
    ``os.environ`` on the fleet host) — see the module docstring for why it
    is never handed to the child directly. It is threaded through
    :func:`agentrail.sandbox.native_runner.build_native_child_env` for both
    the install step and the boot child; the boot child additionally gets
    ``PORT``/``HOST`` via that function's ``caller_env`` layer (which always
    wins over anything of the same name in ``process_env``).

    On any failure — install failure, the start command failing to spawn
    at all, or a health-check timeout — this cleans up everything it
    started for this attempt (killed process group, ``clone_dir`` removed)
    before raising :class:`BootError`, so a caller never needs to call
    :func:`teardown` on a failed :func:`boot`.
    """
    if recipe.install:
        _run_install(recipe.install, clone_dir, process_env, timeout)

    port = recipe.port or pick_free_port()
    child_env = build_native_child_env(process_env, {"PORT": str(port), "HOST": "0.0.0.0"})

    log_path = os.path.join(clone_dir, _LOG_FILENAME)
    try:
        with open(log_path, "wb") as log_fh:
            proc = subprocess.Popen(
                recipe.start,
                cwd=clone_dir,
                env=child_env,
                start_new_session=True,
                stdout=log_fh,
                stderr=subprocess.STDOUT,
            )
    except OSError as exc:
        shutil.rmtree(clone_dir, ignore_errors=True)
        raise BootError(f"failed to start boot child {recipe.start!r}: {exc}") from None

    pgid = _process_group_id(proc)

    if not health_check(port, recipe.ready_path, timeout=timeout):
        tail = _tail_bytes(log_path)
        _kill_process_group(proc, pgid)
        shutil.rmtree(clone_dir, ignore_errors=True)
        raise BootError(
            f"boot child {recipe.start!r} on port {port} never became healthy "
            f"(ready_path={recipe.ready_path!r}): {tail or '(no output)'}"
        )

    return BootHandle(
        proc=proc,
        pgid=pgid,
        port=port,
        url=f"http://{advertise_host}:{port}",
        clone_dir=clone_dir,
    )


def teardown(handle: BootHandle) -> None:
    """Kill the boot child's whole process group and remove its clone dir.

    Idempotent and best-effort: safe to call more than once (an
    already-dead group and an already-removed directory are both silent
    no-ops) and never raises.
    """
    _kill_process_group(handle.proc, handle.pgid)
    shutil.rmtree(handle.clone_dir, ignore_errors=True)
