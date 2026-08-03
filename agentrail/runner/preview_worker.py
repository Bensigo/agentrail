"""The out-of-process preview-boot worker (B2b "boot plane", Task 7).

Ties Task 5 (:mod:`agentrail.sandbox.preview_recipe`) and Task 6
(:mod:`agentrail.sandbox.preview_boot`) together into a standalone claim
loop: ask the console for the next ``preview_boots`` row, clone the PR head,
detect a run recipe, boot + health-check a supervised child, report
``ready{url}``, supervise the child until its TTL, then unconditionally tear
it down. This is a DEDICATED, ISOLATED plane -- it never touches
``agentrail.runner.worker``/``client.py``/``WorkItem``/the generic
``/api/v1/runner/claim``+``/result`` path (see the plan doc's own topology
ruling, docs/superpowers/plans/2026-08-02-b2b-sandbox-boot.md). Its own HTTP
seam (``Response``/``Transport``/``_urllib_transport`` below) is therefore a
deliberate, self-contained duplicate of ``agentrail.runner.client``'s
identical-shaped idiom -- not an import -- for the same "mirror the
mechanism, stay independent of the source module" reason
``preview_boots.ts`` gives for duplicating ``review_jobs.ts``'s
``uuid5Url`` rather than importing it.

**Wire contract** (the console routes this worker calls; verified against
the already-implemented ``apps/console/app/api/v1/runner/preview-boots/{claim,report}/route.ts``):

- ``POST {base}/api/v1/runner/preview-boots/claim {workerId}`` ->
  ``204`` (nothing pending) or ``200 {id, workspaceId, repo, repoUrl,
  prNumber, headSha, ref, githubToken, ttlSeconds}``.
- ``POST {base}/api/v1/runner/preview-boots/report {id, workerId, status,
  url?, port?, reason?, bootLog?}`` -> ``200 {ok, status}`` or ``409`` (not
  found / not owned by this worker / illegal transition from the row's current
  state). ``bootLog`` is an optional bounded tail of the boot child's log,
  included only when available. This worker treats a non-2xx report response as inert (see
  ``_report``'s own docstring) -- v1 is TTL-only, with no early-release or
  claim-check against the console's own view of the row (the follow-up
  plan adds that); the worker's supervise loop runs entirely on ITS OWN
  clock.

**Report state machine** (every arrow below is a ``_report`` call):

    booting -> ready -> [ready ...]* -> torn_down     (happy path)
    booting -> failed                                  (clone/recipe/boot failure)

``ready`` repeats every ``LIVENESS_INTERVAL_SECONDS`` while supervising --
each repeat is an idempotent liveness bump (the console's own
``reportPreviewBoot`` allows ``ready -> ready`` specifically so the
staleness sweep never fails a healthy, still-supervised boot).

**Crash-safety** (the property under heaviest test): the whole per-claim
body, from the first ``report(booting)`` onward, runs inside a single
``try/finally``. ``finally`` unconditionally tears down any
:class:`~agentrail.sandbox.preview_boot.BootHandle` this claim produced --
so an exception raised ANYWHERE after a successful boot (a bug, a hard
transport failure, anything) can never leak the local child process or its
clone directory. This is a second, independent safety net on top of the
normal-path teardown (which already runs before the final ``torn_down``
report) -- ``preview_boot.teardown`` is documented idempotent, so the two
can never conflict. Even if the WHOLE process is killed (container death),
the boot child dies with it (``start_new_session=True`` ties its lifetime
to nothing durable); the console's own ``expireStalePreviewBoots`` sweep
reclaims the abandoned row after ``last_liveness_at`` goes stale. v1: one
boot at a time.

**Config / gating** -- read once, at process start, from the environment:

======================== =====================================================
``PREVIEW_WORKER_ENABLED``  must be exactly ``"1"`` or :func:`main` no-ops.
``AGENTRAIL_SERVER_BASE_URL``  the console's base URL.
``JACE_CONSOLE_TOKEN``      bearer token -- same trust class as the Jace
                             review worker (``requireJaceConsoleSecret``).
``PREVIEW_ADVERTISE_HOST``  default ``127.0.0.1``; the host embedded in the
                             ``ready`` URL (never a public interface literal
                             -- see ``preview_boot``'s own module docstring).
======================== =====================================================

**Testability seams** (injected on :func:`run_preview_worker`, all default
to the real thing): ``transport`` (the console HTTP call), ``sleep``,
``now``, and the four boot operations ``clone`` / ``detect_recipe`` /
``boot`` / ``teardown``. Tests supply fakes for all of them -- no real
server, no real waits, no real processes.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import socket
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional

from agentrail.sandbox import preview_boot, preview_recipe
from agentrail.sandbox.preview_boot import BootError, BootHandle
from agentrail.sandbox.preview_recipe import PreviewRecipe

_log = logging.getLogger("agentrail.runner.preview_worker")

# --- config -------------------------------------------------------------

ENABLED_ENV = "PREVIEW_WORKER_ENABLED"
BASE_URL_ENV = "AGENTRAIL_SERVER_BASE_URL"
TOKEN_ENV = "JACE_CONSOLE_TOKEN"
ADVERTISE_HOST_ENV = "PREVIEW_ADVERTISE_HOST"
DEFAULT_ADVERTISE_HOST = "127.0.0.1"

# How long an idle (204) claim poll waits before trying again.
IDLE_SECONDS = 10.0
# How often the supervise loop re-reports "ready" as a liveness bump.
LIVENESS_INTERVAL_SECONDS = 30.0
# The budget handed to preview_boot.boot() for install+spawn+health-check.
# Generous enough for a real `npm ci` + dev-server start on a small app,
# comfortably inside a typical TTL (console default 720s, #PREVIEW_BOOT_TTL_SECONDS)
# so a slow-but-legitimate boot is not starved. Independent of the TTL
# clock itself (v1 keeps the two budgets separate; see _handle_claim).
BOOT_TIMEOUT_SECONDS = 180.0
# Fallback only -- used when a claim payload is missing/malformed ttlSeconds
# (should not happen against the real console, which always echoes its own
# resolved previewTtlSeconds()). Mirrors that route's own default.
_FALLBACK_TTL_SECONDS = 720.0

CLAIM_PATH = "/api/v1/runner/preview-boots/claim"
REPORT_PATH = "/api/v1/runner/preview-boots/report"

# Boot logs are the only raw child output sent to the console, and are kept
# bounded independently from the stable lifecycle `reason` field.
_BOOT_LOG_MAX_CHARS = 4000


@dataclass(frozen=True)
class WorkerConfig:
    """Resolved worker identity + console connection info."""

    base_url: str
    token: str
    advertise_host: str
    worker_id: str


# --- wire types -----------------------------------------------------------
#
# Deliberately self-contained (not imported from agentrail.runner.client) --
# see the module docstring's "isolated plane" note.


@dataclass(frozen=True)
class Response:
    """A minimal HTTP response: status code + raw body bytes."""

    status: int
    body: bytes


# (method, url, *, headers, body=None) -> Response. The injectable seam:
# real urllib in production (_urllib_transport), a scripted fake in tests.
Transport = Callable[..., Response]


class PreviewWorkerError(RuntimeError):
    """A claim/report HTTP call the worker cannot make sense of (an
    unexpected status). Raised only for the CLAIM call -- see ``_claim``'s
    docstring; ``_report`` never raises for a mere non-2xx status."""


def _urllib_transport(
    method: str,
    url: str,
    *,
    headers: Dict[str, str],
    body: Optional[bytes] = None,
) -> Response:  # pragma: no cover - exercised against a real server
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return Response(status=int(resp.status), body=resp.read())
    except urllib.error.HTTPError as exc:  # treat HTTP errors as responses
        return Response(status=int(exc.code), body=exc.read())


def _headers(config: WorkerConfig) -> Dict[str, str]:
    return {"Authorization": f"Bearer {config.token}", "Content-Type": "application/json"}


# --- claimed item -----------------------------------------------------------


def _safe_int(value: object, default: int = 0) -> int:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _safe_float(value: object, default: float) -> float:
    try:
        result = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    return result if result >= 0 else default


@dataclass(frozen=True)
class PreviewBootItem:
    """One claimed ``preview_boots`` row, exactly as the claim route's
    response shape (``apps/console/.../preview-boots/claim/route.ts``):
    ``{id, workspaceId, repo, repoUrl, prNumber, headSha, ref, githubToken,
    ttlSeconds}``.

    Parsing is defensive (mirrors ``agentrail.runner.client.WorkItem.from_dict``):
    every field but ``id`` degrades to a safe default on a missing/malformed
    value rather than raising, so a payload from a future/older console
    build can never crash the claim loop. ``id`` alone is allowed to raise
    naturally (a claim response with no id is not something this worker can
    do anything useful with -- same posture ``WorkItem.from_dict`` takes).
    """

    id: str
    repo: str
    repo_url: str
    pr_number: int
    head_sha: str
    ref: str
    github_token: str
    ttl_seconds: float
    workspace_id: str = ""
    base_ref: str = ""
    expected_head_sha: str = ""
    expected_environment_rung: str = ""

    @classmethod
    def from_dict(cls, d: Dict[str, object]) -> "PreviewBootItem":
        head_sha = str(d.get("headSha") or "")
        expected_head_sha = str(d.get("expectedHeadSha") or head_sha)
        return cls(
            id=str(d["id"]),
            repo=str(d.get("repo") or ""),
            repo_url=str(d.get("repoUrl") or ""),
            pr_number=_safe_int(d.get("prNumber")),
            head_sha=head_sha,
            ref=str(d.get("ref") or ""),
            github_token=str(d.get("githubToken") or ""),
            ttl_seconds=_safe_float(d.get("ttlSeconds"), _FALLBACK_TTL_SECONDS),
            workspace_id=str(d.get("workspaceId") or ""),
            base_ref=str(d.get("baseRef") or d.get("baseSha") or ""),
            expected_head_sha=expected_head_sha,
            expected_environment_rung=str(
                d.get("expectedEnvironmentRung") or d.get("environmentRung") or ""
            ),
        )


def _boot_process_env(item: PreviewBootItem) -> Dict[str, str]:
    """Carry the claim's identity and reviewability hints into the boot child.

    The boot child already receives the worker's public-safe environment
    through ``preview_boot.boot``. The preview worker makes the identity
    hints explicit here so a future nested runner can recover the same
    base/head evidence the console and reviewer-context seams expect.
    """
    boot_env = dict(os.environ)
    if item.workspace_id:
        boot_env["AGENTRAIL_WORKSPACE_ID"] = item.workspace_id
    if item.base_ref:
        boot_env["AGENTRAIL_BASE_REF"] = item.base_ref
    boot_env["AGENTRAIL_EXPECTED_HEAD_SHA"] = item.expected_head_sha or item.head_sha
    if item.expected_environment_rung:
        boot_env["AGENTRAIL_EXPECTED_ENVIRONMENT_RUNG"] = item.expected_environment_rung
    return boot_env


# --- console calls ---------------------------------------------------------


def _claim(transport: Transport, config: WorkerConfig) -> Optional[PreviewBootItem]:
    """``POST .../preview-boots/claim {workerId}``.

    ``204`` -> ``None`` (nothing pending right now). ``200`` -> the claimed
    item. Any OTHER status raises :class:`PreviewWorkerError` -- the caller
    (``run_preview_worker``'s outer loop) treats that exactly like a
    transport-level exception: log, idle-sleep, retry. A console hiccup
    (500, a rejected token, ...) must never kill the worker process.
    """
    url = f"{config.base_url}{CLAIM_PATH}"
    body = json.dumps({"workerId": config.worker_id}).encode("utf-8")
    resp = transport("POST", url, headers=_headers(config), body=body)
    if resp.status == 204:
        return None
    if resp.status != 200 or not resp.body:
        raise PreviewWorkerError(f"claim failed: HTTP {resp.status}")
    return PreviewBootItem.from_dict(json.loads(resp.body.decode("utf-8")))


def _report(
    transport: Transport,
    config: WorkerConfig,
    *,
    boot_id: str,
    status: str,
    url: Optional[str] = None,
    port: Optional[int] = None,
    reason: Optional[str] = None,
    boot_log: Optional[str] = None,
) -> bool:
    """``POST .../preview-boots/report``.

    A non-2xx RESPONSE (e.g. ``409`` -- the row was superseded, claimed by
    someone else, or the transition is no longer legal from its current
    state) is deliberately NOT an error to this worker: v1 is TTL-only,
    with no early-release/claim-check against the console's own view of the
    row (see the module docstring) -- the supervise loop keeps running on
    its OWN clock regardless of what the console says. Returns ``True``
    only on a 2xx; callers that don't care (every call site in
    ``_handle_claim`` except none -- it is uniformly fire-and-forget) simply
    discard it.

    A genuine TRANSPORT failure (the injected ``transport`` callable itself
    raising -- network error, DNS failure, whatever) is NOT caught here and
    propagates to the caller. That is deliberate, not an oversight: it is
    exactly the "unexpected exception mid-supervise" case
    ``_handle_claim``'s own ``try/finally`` exists to stay safe against.
    """
    payload: Dict[str, object] = {"id": boot_id, "workerId": config.worker_id, "status": status}
    if url is not None:
        payload["url"] = url
    if port is not None:
        payload["port"] = port
    if reason is not None:
        payload["reason"] = reason
    if boot_log is not None:
        payload["bootLog"] = boot_log
    resp = transport(
        "POST",
        f"{config.base_url}{REPORT_PATH}",
        headers=_headers(config),
        body=json.dumps(payload).encode("utf-8"),
    )
    return 200 <= resp.status < 300


def _public_failure_reason(exc: BaseException) -> str:
    """Return a stable lifecycle reason without relaying repo output."""
    if isinstance(exc, BootError):
        return exc.public_reason
    return "clone_failed"


def _safe_boot_log_from_handle(handle: BootHandle) -> Optional[str]:
    """Best-effort boot log evidence for a live handle.

    Reading this file is explicitly non-critical: if it fails, report
    without ``bootLog`` and keep the preview lifecycle moving.
    """
    try:
        tail = preview_boot.boot_log_tail(handle, process_env=os.environ)
    except Exception as exc:  # noqa: BLE001 - evidence read must not fail lifecycle
        _log.warning("preview boot log tail read failed: %s", exc)
        return None
    if not tail:
        return None
    return tail[-_BOOT_LOG_MAX_CHARS:]


def _safe_boot_log_from_error(exc: BootError) -> Optional[str]:
    try:
        tail = getattr(exc, "boot_log_tail", "")
    except Exception as attr_exc:  # noqa: BLE001 - defensive around injected exceptions
        _log.warning("preview boot error log tail read failed: %s", attr_exc)
        return None
    if not tail:
        return None
    return str(tail)[-_BOOT_LOG_MAX_CHARS:]


def _claim_identity_failure(item: PreviewBootItem) -> Optional[str]:
    """Fail closed when the worker cannot trust the claimed boot identity."""
    if not item.workspace_id:
        return "claim missing workspaceId"
    if not item.head_sha:
        return "claim missing headSha"
    if item.expected_head_sha and item.expected_head_sha != item.head_sha:
        return "claim expectedHeadSha does not match headSha"
    return None


# --- per-claim handling -----------------------------------------------------


def _handle_claim(
    item: PreviewBootItem,
    config: WorkerConfig,
    *,
    transport: Transport,
    sleep: Callable[[float], None],
    now: Callable[[], float],
    clone: Callable[..., None],
    detect_recipe: Callable[[str], Optional[PreviewRecipe]],
    boot: Callable[..., BootHandle],
    teardown: Callable[[BootHandle], None],
    liveness_interval: float,
    boot_timeout: float,
) -> None:
    """Run ONE claimed boot item end-to-end. Every early exit is a plain
    ``return`` -- the outer ``run_preview_worker`` loop naturally moves on
    to the next claim.

    The deadline is anchored to CLAIM time -- ``now()`` is read as the very
    first thing below, before even the first report -- not to "boot became
    ready" time. This matches the console's own ``claimPreviewBoot``, which
    stamps ``expires_at = now() + ttlSeconds`` at the moment it hands out
    the claim: install+health-check time is part of the TTL budget, not
    additional to it.

    Crash-safety: ``handle`` starts ``None`` and is only ever assigned the
    return value of a SUCCESSFUL ``boot()`` call. ``finally`` tears it down
    if (and only if) it is still non-``None`` when this function exits for
    ANY reason -- including an exception raised by ``sleep``, ``now``, or a
    ``report`` call anywhere after a successful boot. On the NORMAL
    completion path, ``handle`` is explicitly reset to ``None`` right after
    its own explicit ``teardown()`` call -- not because a second call would
    be unsafe (``preview_boot.teardown`` is documented idempotent), but so
    the ``finally``'s job stays legible: "clean up only if the normal path
    didn't already."

    On a ``BootError``, no local cleanup call is made here beyond letting
    ``handle`` stay ``None`` -- ``preview_boot.boot``'s own docstring
    guarantees it has ALREADY killed anything it started and removed the
    clone dir before raising ("callers never need a compensating teardown
    of their own on this path"). Duplicating that cleanup here would be
    dead weight, not extra safety.
    """
    deadline = now() + item.ttl_seconds
    handle: Optional[BootHandle] = None
    dest = tempfile.mkdtemp(prefix="agentrail-preview-")
    short_sha = item.head_sha[:12] if item.head_sha else item.ref
    try:
        identity_failure = _claim_identity_failure(item)
        if identity_failure is not None:
            _report(transport, config, boot_id=item.id, status="failed", reason=identity_failure)
            _log.warning("preview boot %s: %s", item.id, identity_failure)
            shutil.rmtree(dest, ignore_errors=True)
            return

        _report(transport, config, boot_id=item.id, status="booting")
        _log.info("preview boot %s: booting %s@%s", item.id, item.repo, short_sha)

        try:
            clone(item.repo_url, item.ref, dest, token=item.github_token)
        except Exception as exc:  # noqa: BLE001 - an untrusted clone target;
            # a failure here (bad/expired token, unreachable repo, a ref
            # that no longer exists after a force-push) is just as terminal
            # to this attempt as a bad recipe or a failed boot.
            _report(
                transport,
                config,
                boot_id=item.id,
                status="failed",
                reason="clone_failed",
            )
            _log.warning("preview boot %s: clone failed: %s", item.id, exc)
            shutil.rmtree(dest, ignore_errors=True)
            return

        recipe = detect_recipe(dest)
        if recipe is None:
            _report(transport, config, boot_id=item.id, status="failed", reason="no recipe")
            _log.warning("preview boot %s: no recipe detected", item.id)
            shutil.rmtree(dest, ignore_errors=True)
            return

        try:
            boot_process_env = _boot_process_env(item)
            handle = boot(
                recipe,
                dest,
                advertise_host=config.advertise_host,
                process_env=boot_process_env,
                timeout=boot_timeout,
            )
        except BootError as exc:
            _report(
                transport,
                config,
                boot_id=item.id,
                status="failed",
                reason=_public_failure_reason(exc),
                boot_log=_safe_boot_log_from_error(exc),
            )
            _log.warning("preview boot %s: boot failed: %s", item.id, exc)
            return

        boot_log = _safe_boot_log_from_handle(handle)
        _report(
            transport, config, boot_id=item.id, status="ready",
            url=handle.url, port=handle.port, boot_log=boot_log,
        )
        _log.info("preview boot %s: ready at %s", item.id, handle.url)

        while True:
            sleep(liveness_interval)
            if now() >= deadline:
                break
            # Idempotent liveness bump -- the console's ready->ready
            # transition just bumps last_liveness_at. See _report's own
            # docstring for why the return value is discarded (v1, no
            # early-release).
            _report(
                transport, config, boot_id=item.id, status="ready",
                url=handle.url, port=handle.port, boot_log=boot_log,
            )

        boot_log = _safe_boot_log_from_handle(handle) or boot_log
        teardown(handle)
        handle = None
        _report(transport, config, boot_id=item.id, status="torn_down", boot_log=boot_log)
        _log.info("preview boot %s: torn down (ttl elapsed)", item.id)
    finally:
        if handle is not None:
            teardown(handle)


# --- the claim loop ---------------------------------------------------------


def run_preview_worker(
    config: WorkerConfig,
    *,
    transport: Transport,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
    clone: Callable[..., None] = preview_boot.clone_pr_head,
    detect_recipe: Callable[[str], Optional[PreviewRecipe]] = preview_recipe.detect_recipe,
    boot: Callable[..., BootHandle] = preview_boot.boot,
    teardown: Callable[[BootHandle], None] = preview_boot.teardown,
    idle_seconds: float = IDLE_SECONDS,
    liveness_interval: float = LIVENESS_INTERVAL_SECONDS,
    boot_timeout: float = BOOT_TIMEOUT_SECONDS,
    should_continue: Callable[[], bool] = lambda: True,
) -> None:
    """The claim loop: ``claim -> (idle sleep | handle one boot) -> repeat``
    until ``should_continue()`` is false. v1: one boot at a time -- a claim
    that hands out a boot item runs it fully (through supervise + teardown)
    before the loop polls again.

    Every seam that touches the outside world is injected: ``transport``
    (the console HTTP call), ``sleep``/``now`` (the clock), and the four
    boot operations. Production callers (``main``, below) supply the real
    ones; tests supply fakes -- no real server, no real waits, no real
    processes.
    """
    while should_continue():
        try:
            item = _claim(transport, config)
        except Exception as exc:  # noqa: BLE001 - a claim hiccup must not kill the worker
            _log.warning("preview-boot claim failed (will retry): %s", exc)
            sleep(idle_seconds)
            continue

        if item is None:
            sleep(idle_seconds)
            continue

        try:
            _handle_claim(
                item,
                config,
                transport=transport,
                sleep=sleep,
                now=now,
                clone=clone,
                detect_recipe=detect_recipe,
                boot=boot,
                teardown=teardown,
                liveness_interval=liveness_interval,
                boot_timeout=boot_timeout,
            )
        except Exception as exc:  # noqa: BLE001 - _handle_claim's own finally
            # already guaranteed local teardown (see its docstring); this is
            # the OUTER safety net so a bug or a hard transport failure ends
            # only THIS claim's supervision, never the worker process --
            # mirrors agentrail.runner.worker._run_slot's identical posture
            # around `execute(item)`.
            _log.warning("preview boot %s failed unexpectedly: %s", item.id, exc)


# --- entrypoint --------------------------------------------------------------


def _generate_worker_id() -> str:
    """Mirrors ``agentrail.runner.fleet_lease``'s own worker-id idiom:
    hostname + a short random suffix, so two workers on the same host never
    collide and a log line's worker id stays human-recognizable."""
    host = socket.gethostname() or "preview"
    return f"{host}-{uuid.uuid4().hex[:12]}"


def _config_from_env() -> WorkerConfig:
    return WorkerConfig(
        base_url=(os.environ.get(BASE_URL_ENV) or "").rstrip("/"),
        token=os.environ.get(TOKEN_ENV) or "",
        advertise_host=os.environ.get(ADVERTISE_HOST_ENV) or DEFAULT_ADVERTISE_HOST,
        worker_id=_generate_worker_id(),
    )


def main(argv: Optional[List[str]] = None) -> None:
    """``python -m agentrail.runner.preview_worker`` -- the standalone,
    out-of-process entrypoint (mirrors the Jace review worker precedent:
    a dedicated process, not folded into the generic runner CLI).

    Gated on ``PREVIEW_WORKER_ENABLED == "1"`` -- anything else is a clean
    no-op (log + return), never an error exit, so an operator who forgot to
    flip the flag gets an obvious log line instead of a confusing crash.
    """
    parser = argparse.ArgumentParser(
        prog="python -m agentrail.runner.preview_worker",
        description=(
            "Out-of-process preview-boot worker (B2b) -- claims a "
            "preview_boots row, clones the PR head, detects a run recipe, "
            "boots + health-checks a supervised child, reports ready{url}, "
            "supervises to TTL, then always tears down."
        ),
    )
    parser.add_argument("--log-level", default="WARNING", help="logging level (default WARNING)")
    args = parser.parse_args(argv)
    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.WARNING))

    if os.environ.get(ENABLED_ENV) != "1":
        _log.info('%s != "1" -- preview worker disabled, exiting', ENABLED_ENV)
        return

    config = _config_from_env()
    if not config.base_url or not config.token:
        _log.error("%s and %s must both be set", BASE_URL_ENV, TOKEN_ENV)
        return

    _log.info("preview worker %s starting against %s", config.worker_id, config.base_url)
    run_preview_worker(config, transport=_urllib_transport)


if __name__ == "__main__":
    main()
