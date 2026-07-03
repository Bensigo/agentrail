"""Nightly **canary** — a bounded, fail-closed eval pass for the scheduled Action (issue #1041).

Position in the eval-loop-closure arc (PRD ``eval-loop-closure-canary-regression-gate``):

    schedule (nightly cron)
        │
        ▼
    run_canary()  ── fail-closed auth check ──► (missing secret ⇒ raise, job fails)
        │
        ▼
    run_spine(bounded corpus subset)  ──►  dated report  eval-report-YYYY-MM-DD.md
        │                                    (strata + per-component cost + net-artifact counts)
        ▼
    HttpMetricsWriter  ──►  POST /api/v1/ingest/eval-arm-metrics  (telemetry NOT dark)

This module owns ONE thing: the *canary policy* around the already-built
:func:`agentrail.evals.spine.run_spine`. It is deliberately thin — it does NOT
re-implement scoring, reporting, network-artifact hygiene (#1033), or the
telemetry push. Every one of those is REUSED from the spine/reporter. What the
canary adds on top of a plain ``agentrail evals run`` is exactly three things:

1. **Fail-closed auth** (PRD §5). A scheduled job that silently runs
   unauthenticated — or against a partial/empty corpus — would false-green the
   whole loop. So before any work, :func:`run_canary` resolves the server link
   (``server.json`` OR the ``AGENTRAIL_SERVER_*`` env secrets, via the shared
   :func:`agentrail.context.snapshot_push.load_link`) and RAISES
   :class:`CanaryAuthError` when it is absent. This is the opposite of the
   GitHub webhook's fail-OPEN skip (HMAC verify returns true when the secret is
   unset) — the PRD explicitly warns against copying that. Missing/invalid
   secret ⇒ the job fails loudly.

2. **A bounded, documented corpus subset** (PRD §3, AC4). The canary must be
   cheap enough that it is never turned off, yet still render every stratum so
   the report carries strata + per-component cost + network-artifact counts
   (AC2). It runs ONE task per difficulty stratum — see :data:`CANARY_TASKS` —
   so the difficulty-stratified section always has all three rows, at a small,
   documented per-run cost bound (:data:`CANARY_COST_BOUND_USD`).

3. **Telemetry that is NOT dark** (PRD §4, AC3). The plain spine defaults its
   ``MetricsWriter`` to an :class:`HttpMetricsWriter` that silently returns
   ``False`` when unlinked — so an unlinked canary would push nothing and the
   live-metrics lane the regression gate reads would be dark. The canary has
   ALREADY proven the link exists (step 1), so it constructs the
   ``HttpMetricsWriter`` explicitly against that link's target and asserts the
   push happened; a push that comes back ``False`` after a validated link is a
   real ingest failure, surfaced (not swallowed) via :attr:`CanaryResult.persist_ok`.

The dated report path this returns is exactly the one the apply CLI and the
warm-critic default-flip (#981) consume, produced by the SAME
:func:`write_markdown_report` as every other eval run (single-source report).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date as _date
from pathlib import Path
from typing import Callable, Dict, List, Optional, Protocol, Sequence

from agentrail.evals.arms import Arm, baseline, full
from agentrail.evals.reporter import HttpMetricsWriter, MetricsWriter
from agentrail.evals.runner import AgentExecutor, SandboxAgentExecutor
from agentrail.evals.spine import (
    HiddenTestRunner,
    SpineConfig,
    SpineResult,
    run_spine,
)

_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Bounded corpus subset + cost bound (documented so the canary is never a
# surprise expense — AC4). One task per difficulty stratum so the report's
# difficulty-stratified section always has all three rows (AC2 strata).
# ---------------------------------------------------------------------------

# One representative task per difficulty stratum. Chosen from the NON-held-out
# split (the held-out tasks — secret-push-guardrail / precision-at-budget — are
# reserved from every routine run, #941). Keeping this to exactly three tasks is
# what bounds the canary's cost; keeping ONE PER STRATUM is what keeps the
# difficulty-stratified breakdown populated. Changing this set changes the cost
# bound below — keep the two in sync.
CANARY_TASKS: tuple[str, ...] = (
    "afk-objective-gate",       # easy
    "cache-token-pricing",      # medium
    "objective-gate-unified",   # hard
)

# Default arms for the nightly canary: ``baseline`` + ``full`` — the same two
# arms a plain ``agentrail evals run`` defaults to, so the canary's report is
# directly comparable to a full run and the regression gate reads a familiar
# arm set. (The ablation set is deliberately NOT run nightly — it would multiply
# the cost bound by the number of layers.)
def _default_arms() -> List[Arm]:
    return [baseline(), full()]


# Documented per-run spend bound (AC4). This is the ceiling the scheduled
# workflow advertises so the job is cheap enough to never be turned off. It is
# 3 tasks × 2 arms × the default reps, at the priced models the arms pin, with
# generous headroom over an observed run. It is enforced as an ADVISORY log
# assertion after the run (the spine already reports real per-arm cost); a run
# that blows the bound is surfaced loudly rather than silently accepted.
CANARY_COST_BOUND_USD: float = 5.0

# Default repetitions per (task, arm) for the nightly canary. Lower than the
# ``agentrail evals run`` default (5) because the canary trades statistical
# power for a tight, predictable nightly cost — the regression gate's CIs
# (#1064) widen accordingly, which is the honest trade.
CANARY_DEFAULT_REPS: int = 3


class CanaryAuthError(RuntimeError):
    """Raised when the canary's server link (auth secret) is not configured.

    FAIL-CLOSED (PRD §5): a scheduled canary that ran unauthenticated would
    push nothing (dark telemetry) and/or score against a partial corpus and
    false-green the loop. So the job must FAIL when the secret is absent — this
    exception is what makes ``agentrail evals canary`` exit non-zero, turning
    the GitHub Action red instead of silently green. This is the deliberate
    opposite of the webhook's fail-OPEN skip.
    """


# ---------------------------------------------------------------------------
# Injectable seams (testability). Production defaults are the real link loader,
# the real sandbox executor, and the real spine — but each is a parameter so a
# unit test drives the whole canary policy with faithful fakes (no network, no
# sandbox), exactly like the spine's own tests.
# ---------------------------------------------------------------------------


class LinkLoader(Protocol):
    """Resolve the server link (auth). Mirrors ``snapshot_push.load_link``."""

    def __call__(self, target: Path) -> Optional[Dict[str, str]]:
        ...  # pragma: no cover - Protocol body


class SpineRunner(Protocol):
    """The spine entrypoint. Mirrors :func:`agentrail.evals.spine.run_spine`."""

    def __call__(
        self,
        config: SpineConfig,
        *,
        executor: AgentExecutor,
        hidden_test_runner: Optional[HiddenTestRunner],
        metrics_writer: Optional[MetricsWriter],
        reports_dir: Optional[Path],
        date: Optional[str],
        run_id: Optional[str],
    ) -> SpineResult:
        ...  # pragma: no cover - Protocol body


@dataclass(frozen=True)
class CanaryResult:
    """Observable output of one canary run (what the CLI prints / the job checks)."""

    report_path: Optional[Path]
    run_id: Optional[str]
    persist_ok: bool
    spine_result: SpineResult


def _resolve_link(link_loader: LinkLoader, target: Path) -> Dict[str, str]:
    """Fail-CLOSED auth resolution (AC3 telemetry seam + PRD §5).

    Returns the link when configured; RAISES :class:`CanaryAuthError` when it is
    absent. There is no fall-through to an unauthenticated run — that is the
    entire point of the canary being fail-closed.
    """
    link = link_loader(target)
    if link is None:
        raise CanaryAuthError(
            "canary aborted: no AgentRail server link configured. "
            "The nightly canary FAILS CLOSED — it must push its run/pack "
            "telemetry to the linked server (so the regression gate's live-metrics "
            "lane is not dark) and must never score against a partial or "
            "unauthenticated run. Set the AGENTRAIL_SERVER_BASE_URL, "
            "AGENTRAIL_SERVER_API_KEY, and AGENTRAIL_SERVER_REPOSITORY_ID secrets "
            "(all three are required), or provide .agentrail/server.json at the "
            "target. This is deliberately NOT the webhook's fail-open behaviour."
        )
    return link


def run_canary(
    *,
    target: Optional[Path] = None,
    arms: Optional[Sequence[Arm]] = None,
    reps: int = CANARY_DEFAULT_REPS,
    tasks: Sequence[str] = CANARY_TASKS,
    corpus_root: Optional[Path] = None,
    reports_dir: Optional[Path] = None,
    pack_index_root: Optional[Path] = None,
    date: Optional[str] = None,
    concurrency: int = 1,
    cost_bound_usd: float = CANARY_COST_BOUND_USD,
    # --- injectable seams (default to production) ------------------------
    link_loader: Optional[LinkLoader] = None,
    executor: Optional[AgentExecutor] = None,
    hidden_test_runner: Optional[HiddenTestRunner] = None,
    metrics_writer: Optional[MetricsWriter] = None,
    spine_runner: SpineRunner = run_spine,
) -> CanaryResult:
    """Run one nightly canary: fail-closed auth → bounded subset → dated report → telemetry.

    Order of operations (each step maps to an AC):

    1. **Fail-closed auth** (PRD §5). Resolve the server link FIRST; raise
       :class:`CanaryAuthError` if absent. Nothing runs unauthenticated.
    2. **Bounded corpus subset** (AC4 / AC2 strata). Restrict the spine to
       :data:`CANARY_TASKS` (one task per difficulty stratum) so the report
       renders all three strata at a small, documented cost bound.
    3. **Dated report** (AC1). ``run_spine`` writes ``eval-report-YYYY-MM-DD.md``
       carrying strata + per-component cost + network-artifact counts (AC2) —
       reused verbatim, not re-implemented.
    4. **Telemetry not dark** (AC3). Push per-arm rows via an
       ``HttpMetricsWriter`` bound to the ALREADY-VALIDATED link target, and
       surface the persist result (a ``False`` after a good link is a real
       ingest failure, not a silent skip).

    All heavy dependencies are injectable so the whole policy is unit-testable
    with faithful fakes (no network, no sandbox).
    """
    resolved_target = Path(target) if target is not None else Path.cwd()
    loader = link_loader if link_loader is not None else _default_link_loader

    # Step 1 — FAIL CLOSED before any work. Missing secret ⇒ raise ⇒ job red.
    _resolve_link(loader, resolved_target)

    # Step 2 — bounded, documented subset (one task per difficulty stratum).
    resolved_arms = list(arms) if arms is not None else _default_arms()
    config = SpineConfig(
        arms=resolved_arms,
        reps=reps,
        task_filter=list(tasks),
        corpus_root=corpus_root,
        include_held_out=False,
        concurrency=concurrency,
        pack_index_root=pack_index_root,
    )

    # Step 4 (writer) — telemetry NOT dark: bind the writer to the validated
    # link target so the push is authenticated. The link was just proven to
    # exist, so this is not the silent-skip path.
    if metrics_writer is None:
        metrics_writer = HttpMetricsWriter(target=resolved_target)

    executor = executor if executor is not None else SandboxAgentExecutor()

    date_str = date or _date.today().isoformat()
    run_id = f"canary-{date_str}"

    # Step 3 — reuse the spine: it writes the dated report (strata + per-component
    # cost + network-artifact counts) AND pushes via the injected writer.
    result = spine_runner(
        config,
        executor=executor,
        hidden_test_runner=hidden_test_runner,
        metrics_writer=metrics_writer,
        reports_dir=reports_dir,
        date=date_str,
        run_id=run_id,
    )

    _check_cost_bound(result, cost_bound_usd)

    return CanaryResult(
        report_path=result.report_path,
        run_id=result.run_id,
        persist_ok=result.persist_ok,
        spine_result=result,
    )


def _default_link_loader(target: Path) -> Optional[Dict[str, str]]:
    """Production link loader — the shared ``snapshot_push.load_link``.

    Imported lazily so importing this module (and its tests) does not pull the
    urllib/link stack into a fake-only path — matching the reporter's own
    lazy-import discipline for the HTTP seam.
    """
    from agentrail.context.snapshot_push import load_link

    return load_link(target)


def _check_cost_bound(result: SpineResult, cost_bound_usd: float) -> None:
    """Advisory bound check (AC4): warn loudly if this run blew the documented cost.

    The spine already computes REAL per-arm cost; the canary just sums it and
    compares to the advertised bound. It logs a warning (never raises) so a
    single over-budget nightly run is visible in the job log without failing the
    whole loop — the bound is documentation the workflow advertises, and this is
    the tripwire that keeps that documentation honest.
    """
    total = sum(getattr(r, "total_cost_usd", 0.0) or 0.0 for r in result.arm_reports)
    if total > cost_bound_usd:
        _log.warning(
            "canary run cost $%.4f exceeded the documented bound $%.2f — "
            "review the corpus subset / arms / reps before the next nightly run",
            total,
            cost_bound_usd,
        )


__all__ = [
    "CanaryAuthError",
    "CanaryResult",
    "CANARY_TASKS",
    "CANARY_COST_BOUND_USD",
    "CANARY_DEFAULT_REPS",
    "run_canary",
]
