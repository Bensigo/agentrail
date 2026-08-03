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

# The install step (recipe.install) gets its OWN log file, distinct from the
# boot child's — the two phases run one after another in the same clone_dir,
# and keeping them separate avoids one phase's failure tail accidentally
# reading the other's leftover output.
_INSTALL_LOG_FILENAME = ".agentrail-preview-install.log"


@dataclass
class BootHandle:
    """A live, health-checked boot child. Returned only once the port is
    confirmed serving; ``teardown`` is the only valid way to end its life."""

    proc: subprocess.Popen
    pgid: int
    port: int
    url: str  # http://<advertise_host>:<port>
    clone_dir: str
    boot_log_path: str


class BootError(RuntimeError):
    """Raised when a boot step (install, spawn, or health-check) fails.

    By the time this is raised, :func:`boot` has already cleaned up
    anything it started for this attempt — no leaked process, no leftover
    ``clone_dir`` — so callers never need a compensating teardown of their
    own on this path.
    """

    def __init__(
        self,
        message: str,
        *,
        boot_log_tail: str = "",
        public_reason: str = "boot_failed",
    ) -> None:
        super().__init__(message)
        self.boot_log_tail = boot_log_tail
        self.public_reason = public_reason


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
    ref), this always does four steps:

      1. ``git clone --depth 1 <authed-url> dest`` — shallow clone of
         whatever the default branch happens to be; its content is
         irrelevant, this step exists only to create ``dest`` as a git
         checkout with ``origin`` configured (and — since ``clone_url``
         embeds the token — already authenticated for the next step).
      2. ``git -C dest fetch --depth 1 origin <ref>`` — fetches exactly
         ``ref`` (whatever form it takes) as ``FETCH_HEAD``, without ever
         needing it to be a resolvable branch/tag name.
      3. ``git -C dest checkout FETCH_HEAD`` — lands the working tree on it.
      4. ``git -C dest remote set-url origin <repo_url>`` — scrubs the
         credential step 1 just persisted to disk (see below).

    ``token`` (a workspace's connected GitHub OAuth token, or a locally
    configured PAT) is embedded as HTTP Basic auth in the clone URL via
    :func:`agentrail.sandbox.clone_auth.authenticated_clone_url` — the SAME
    mechanism ``onboard.py``'s own clone uses. Because step 1's URL carries
    it, ``origin`` is already authenticated for steps 2/3, which is why
    only the clone step's argv needs the credentialed URL.

    Step 4 closes a credential-on-disk leak (final review, S1): ``git
    clone`` persists whatever URL it was given VERBATIM into
    ``dest/.git/config``'s ``remote.origin.url`` as an entirely ordinary
    side effect of setting up ``origin`` — it has no idea step 1's URL
    happens to carry a token, and never scrubs it back out on its own.
    :func:`boot` then runs the PR's OWN untrusted ``recipe.install`` /
    ``recipe.start`` with ``cwd=dest``, so anything left in
    ``dest/.git/config`` at that point is directly readable by that
    untrusted code — an unscrubbed config would hand a live, unscoped,
    installation-wide GitHub token to whatever the PR author's own
    postinstall/start script chooses to do with it, for that token's
    lifetime. Step 4 resets ``origin`` to ``repo_url`` — the ORIGINAL
    parameter this function received, never touched by
    ``authenticated_clone_url`` — rather than to ``clone_url``: ``repo_url``
    never had a token embedded in it to begin with, so this is a plain
    credential-free reset, not a second redaction pass that could itself be
    incomplete. It only rewrites git's own remote metadata; the working
    tree :func:`boot` depends on is untouched.

    Every failure path is routed through
    :func:`agentrail.sandbox.clone_auth.redact_token` before it can leave
    this function — both a non-zero exit's captured stderr AND a raised
    subprocess-level exception's own message, since (per that function's
    docstring) ``subprocess.CalledProcessError``/``TimeoutExpired.__str__()``
    unconditionally embed the raw argv they were constructed with, which
    for the clone step includes the credential-embedded URL regardless of
    what git itself printed. This applies to step 4 too, via the SAME
    ``_run`` helper every other step uses — so a scrub failure raises
    exactly like a clone/fetch/checkout failure would, rather than ever
    silently leaving a tokened config on disk.

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
            # Redact the FULL stderr first, THEN truncate — never the other
            # way round. redact_token is an exact-substring `.replace`; if a
            # token straddles the truncation cutoff, truncating first can
            # split it so the surviving fragment no longer matches the full
            # token string and escapes redaction (review round 1, I1).
            stderr = redact_token((getattr(proc, "stderr", "") or "").strip(), token)[-500:]
            raise RuntimeError(f"{step} failed: {stderr or '(no output)'}")

    _run(["git", "clone", "--depth", "1", clone_url, dest], cwd=None, step="git clone")
    _run(["git", "fetch", "--depth", "1", "origin", ref], cwd=dest, step="git fetch")
    _run(["git", "checkout", "FETCH_HEAD"], cwd=dest, step="git checkout")
    # S1: scrub the credential step 1 persisted into dest/.git/config BEFORE
    # this function ever returns — boot() runs the repo's own untrusted
    # install/start commands with cwd=dest right after, and they can read
    # that file. Reset to repo_url (never tokened), not clone_url (always
    # tokened when a token was supplied). Routed through the same _run seam
    # as every other step so a failure here fails the whole clone rather
    # than silently returning with a live token still on disk.
    _run(["git", "remote", "set-url", "origin", repo_url], cwd=dest, step="git remote set-url")


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


def _probe_once(port: int, ready_path: str, *, connect_timeout: float, http_timeout: float) -> bool:
    """A single TCP-then-HTTP attempt. TCP connect first (cheap, tells us
    the child is at least listening) before ever issuing an HTTP request —
    if a request landed on a closed/unlistening port it would just raise
    the same broad connection error the TCP probe already distinguishes
    more cheaply. ``ready_path`` need only respond < 500: a 404 still means
    a real HTTP server answered on that port (many recipes' default
    ready_path of "/" resolves this way for e.g. a JSON API with no root
    route) — 5xx means the process is up but not yet actually healthy.

    A probe's ONLY job is answering "healthy yes/no" — it must NEVER raise.
    The HTTP half's except is deliberately a broad ``except Exception``
    (review round 1, C1): the previous narrower
    ``(URLError, OSError, ValueError)`` list missed
    ``http.client.HTTPException`` (e.g. ``BadStatusLine``, raised when a
    port is bound but the peer sends bytes that aren't a valid HTTP status
    line — a realistic case for a still-starting or misconfigured process,
    and directly triggerable by the untrusted repo code this module boots),
    which is not an ``OSError`` subclass and so escaped uncaught. Any
    failure to get a clean sub-500 response — transport error, malformed
    response, anything else — means "not ready yet", full stop, rather than
    depending on this except list staying exhaustive forever.
    """
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=connect_timeout):
            pass
    except OSError:
        return False

    url = f"http://127.0.0.1:{port}{ready_path}"
    try:
        with urllib.request.urlopen(url, timeout=http_timeout) as resp:
            return resp.status < 500
    except urllib.error.HTTPError as exc:
        # HTTPError IS urlopen's normal way of surfacing a non-2xx/3xx
        # response (it is not a transport failure) — its .code is the real
        # status.
        return exc.code < 500
    except Exception:  # noqa: BLE001 - see docstring: a probe must never raise
        return False


# A single probe attempt is never given less than this, even when the
# overall deadline has already passed — health_check always attempts at
# least once (see its own docstring), and a near-zero timeout would make an
# attempt meaningless.
_MIN_PROBE_TIMEOUT = 0.1


def health_check(port: int, ready_path: str, *, timeout: float, interval: float = 0.5) -> bool:
    """Poll ``127.0.0.1:<port>`` + ``ready_path`` until healthy or
    ``timeout`` elapses. Mirrors ``agentrail.context.daemon._wait_for_socket``'s
    monotonic-deadline + sleep(interval) shape, over TCP+HTTP instead of a
    unix socket file. Always attempts at least once, even for a ``timeout``
    of 0 — there is never a reason to report "unhealthy" without having
    actually tried.

    Each attempt's own connect/HTTP timeouts are capped to whatever budget
    actually remains before the deadline (floored at
    :data:`_MIN_PROBE_TIMEOUT`), not left at their fixed
    :data:`_PROBE_CONNECT_TIMEOUT` / :data:`_PROBE_HTTP_TIMEOUT` maximums
    unconditionally. Without this, a single attempt starting just before the
    deadline could itself run for the full ~2s combined probe budget,
    overshooting a caller's requested ``timeout`` by nearly that much
    (review round 1, M1) — capping bounds the overshoot to roughly
    :data:`_MIN_PROBE_TIMEOUT`.
    """
    deadline = time.monotonic() + timeout
    first_attempt = True
    while True:
        remaining = deadline - time.monotonic()
        if not first_attempt and remaining <= 0:
            return False
        budget = max(remaining, _MIN_PROBE_TIMEOUT)
        connect_timeout = min(_PROBE_CONNECT_TIMEOUT, budget)
        http_timeout = min(_PROBE_HTTP_TIMEOUT, budget)
        if _probe_once(port, ready_path, connect_timeout=connect_timeout, http_timeout=http_timeout):
            return True
        first_attempt = False
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        time.sleep(min(interval, remaining))


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


def _redact_secret_values(text: str, process_env: dict | None = None) -> str:
    """Best-effort redaction for values that should never leave the host.

    The preview child is given only the public-safe native child env, but a
    hostile or buggy process can still print values it knows. Redact exact
    values from sensitive process-env keys before a tail becomes evidence.
    """
    if not text or not process_env:
        return text

    redacted = text
    sensitive_markers = (
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "DATABASE_URL",
        "API_KEY",
        "AUTH",
        "PRIVATE_KEY",
    )
    for key, value in process_env.items():
        if not isinstance(key, str) or not any(marker in key.upper() for marker in sensitive_markers):
            continue
        if not isinstance(value, str) or len(value) < 8:
            continue
        redacted = redacted.replace(value, "[REDACTED]")
    return redacted


def _tail_bytes(
    path: str,
    max_bytes: int = _LOG_TAIL_BYTES,
    *,
    process_env: dict | None = None,
) -> str:
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
    return _redact_secret_values(data.decode("utf-8", errors="replace").strip(), process_env)


def boot_log_tail(handle: BootHandle, *, process_env: dict | None = None) -> str:
    """Best-effort bounded tail of a live boot child's stdout/stderr log.

    Returns ``""`` if the file cannot be read. This helper is intentionally
    safe for reporting paths: log evidence must never be able to fail the
    preview lifecycle.
    """
    return _tail_bytes(handle.boot_log_path, process_env=process_env)


# ---------------------------------------------------------------------------
# boot / teardown
# ---------------------------------------------------------------------------


def _run_install(argv: list, clone_dir: str, process_env: dict, timeout: float) -> None:
    """Run ``recipe.install`` in ``clone_dir``, capped at ``timeout``.

    Gets the EXACT SAME process-group discipline as the boot child itself
    (review round 1, C2) — ``start_new_session=True`` + stdout/stderr teed
    to a file, never a pipe — because the install step is just as untrusted
    as the start command (e.g. an attacker-controlled npm ``postinstall``
    script is a well-known supply-chain technique) and can just as easily
    background a detached grandchild:

      - A pipe (the previous ``subprocess.run(capture_output=True)``)
        reintroduces the exact deadlock this module otherwise avoids for
        the boot child: a grandchild inheriting the pipe's write end keeps
        it open after the install command itself exits, so
        ``communicate()`` can't see EOF and blocks for the FULL ``timeout``
        regardless of how fast the install command actually finished. A
        file has no such failure mode.
      - Without a captured pgid, a grandchild is structurally unreachable
        by ANY cleanup here — not just on timeout. Capturing it (exactly
        like the boot child) and ``killpg``-ing the whole group on every
        exit path — success included, in case a grandchild outlived a
        successful install — closes that.

    Uses the SAME public-safe env boundary as the boot child
    (``build_native_child_env`` with no extra caller_env). On any failure
    (couldn't start, timed out, non-zero exit) this kills the whole process
    group and removes ``clone_dir`` before raising :class:`BootError` — no
    other process has been spawned yet at this point (this always runs
    before the start command), so there is nothing else to clean up.
    """
    install_env = build_native_child_env(process_env, {})
    log_path = os.path.join(clone_dir, _INSTALL_LOG_FILENAME)

    try:
        with open(log_path, "wb") as log_fh:
            proc = subprocess.Popen(
                argv,
                cwd=clone_dir,
                env=install_env,
                start_new_session=True,
                stdout=log_fh,
                stderr=subprocess.STDOUT,
            )
    except OSError as exc:
        shutil.rmtree(clone_dir, ignore_errors=True)
        raise BootError("install step failed to start", public_reason="install_failed") from None

    pgid = _process_group_id(proc)

    try:
        returncode = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        tail = _tail_bytes(log_path, process_env=process_env)
        _kill_process_group(proc, pgid)  # reaches a grandchild too, not just argv[0]
        shutil.rmtree(clone_dir, ignore_errors=True)
        raise BootError(
            f"install step {argv!r} timed out after {timeout}s: {tail or '(no output)'}",
            boot_log_tail=tail,
            public_reason="install_timeout",
        ) from None

    if returncode != 0:
        tail = _tail_bytes(log_path, process_env=process_env)
        _kill_process_group(proc, pgid)  # in case a grandchild is still around
        shutil.rmtree(clone_dir, ignore_errors=True)
        raise BootError(
            f"install step {argv!r} exited {returncode}: {tail or '(no output)'}",
            boot_log_tail=tail,
            public_reason="install_failed",
        )

    # Success: still reap the whole group, in case the install command left
    # a detached grandchild running in the background — there is no
    # legitimate reason for one to survive into the boot-child phase.
    _kill_process_group(proc, pgid)


def _fail_boot(
    proc: subprocess.Popen,
    pgid: int,
    clone_dir: str,
    log_path: str,
    reason: str,
    *,
    process_env: dict | None = None,
) -> None:
    """Tear down a just-spawned boot child and raise :class:`BootError`.

    The single funnel every :func:`boot` failure AFTER ``Popen`` succeeds
    goes through — kill the process group, remove ``clone_dir``, THEN
    raise — so the "no leaked process, no leftover dir" guarantee lives in
    ONE place rather than being re-implemented (and potentially
    forgotten/gotten-wrong) at every call site. Always raises; never
    returns normally.
    """
    reason = _redact_secret_values(reason, process_env)
    tail = _tail_bytes(log_path, process_env=process_env)
    _kill_process_group(proc, pgid)
    shutil.rmtree(clone_dir, ignore_errors=True)
    raise BootError(
        f"{reason}: {tail or '(no output)'}",
        boot_log_tail=tail,
        public_reason="boot_failed",
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
    at all, health_check returning False, OR health_check RAISING (review
    round 1, C1: ``_probe_once``'s own except is broadened, but this is a
    second, independent safety net — the cleanup guarantee must not rest
    entirely on that except list staying exhaustive forever) — this cleans
    up everything it started for this attempt (killed process group,
    ``clone_dir`` removed) before raising :class:`BootError`, so a caller
    never needs to call :func:`teardown` on a failed :func:`boot`.
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
        raise BootError("failed to start boot child", public_reason="boot_failed") from None

    pgid = _process_group_id(proc)

    try:
        healthy = health_check(port, recipe.ready_path, timeout=timeout)
    except Exception as exc:  # noqa: BLE001 - belt-and-suspenders (C1): even an
        # exception type _probe_once's own broadened catch doesn't happen to
        # cover must still trigger full cleanup, never escape with a live
        # process/leftover clone_dir.
        _fail_boot(
            proc, pgid, clone_dir, log_path,
            f"boot child {recipe.start!r} on port {port} raised during health-check "
            f"(ready_path={recipe.ready_path!r}): {exc!r}",
            process_env=process_env,
        )

    if not healthy:
        _fail_boot(
            proc, pgid, clone_dir, log_path,
            f"boot child {recipe.start!r} on port {port} never became healthy "
            f"(ready_path={recipe.ready_path!r})",
            process_env=process_env,
        )

    return BootHandle(
        proc=proc,
        pgid=pgid,
        port=port,
        url=f"http://{advertise_host}:{port}",
        clone_dir=clone_dir,
        boot_log_path=log_path,
    )


def teardown(handle: BootHandle) -> None:
    """Kill the boot child's whole process group and remove its clone dir.

    Idempotent and best-effort: safe to call more than once (an
    already-dead group and an already-removed directory are both silent
    no-ops) and never raises.
    """
    _kill_process_group(handle.proc, handle.pgid)
    shutil.rmtree(handle.clone_dir, ignore_errors=True)
