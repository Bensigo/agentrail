"""``agentrail evals`` — drive the eval harness spine (issue #938).

One CLI command runs:

    corpus -> arm runner (sandbox) -> hidden-test scorer ->
    N repetitions -> aggregated report (dated markdown + Postgres rows)

Defaults: ``baseline`` + ``full`` arms over the frozen corpus v0 with
``--reps 5``. Real agent execution uses ``SandboxAgentExecutor`` (the
production sandbox seam). Hidden-test execution uses the production
:class:`agentrail.evals.hidden_tests.ProductionHiddenTestRunner` — issue #952
shipped the engine, so ``solved`` is now a real measurement (apply diff at
pinned commit, run answer key, return bool). ``--smoke`` keeps the honest
no-op for CI plumbing checks.

The whole point of this command is the spine wiring; every contract it
touches (``RunRecord``, ``Verdict``, ``Arm``, ``CorpusTask``,
``RepetitionRecord``) is imported from its canonical home.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import List, Optional, Sequence

from agentrail.evals.arms import Arm, all_arms
from agentrail.evals.runner import SandboxAgentExecutor
from agentrail.evals.hidden_tests import ProductionHiddenTestRunner
from agentrail.evals.spine import (
    HiddenTestRunner,
    SpineConfig,
    UnimplementedHiddenTestRunner,
    resolve_arm,
    run_spine,
)


def _usage() -> str:
    return (
        "Usage:\n"
        "  agentrail evals run [--corpus DIR] [--task NAME[,NAME...]] "
        "[--arm NAME] [--reps N]\n"
        "\n"
        "Subcommands:\n"
        "  run     Run the eval spine (corpus -> runner -> hidden-test scorer\n"
        "          -> repetitions -> report).\n"
        "  probes  Run the intrinsic guardrail catch-rate probe against the\n"
        "          built-in injection corpus and print the catch-rate (#943).\n"
        "\n"
        "Options:\n"
        "  --corpus DIR     Override the corpus root (default: bundled v0).\n"
        "  --task NAME      Restrict to NAME (repeatable; or comma-separated).\n"
        "  --arm NAME       Add an arm (repeatable). Default: baseline + full.\n"
        "                   Accepts 'baseline', 'full', 'full-minus-<layer>',\n"
        "                   'new-flow' (full + critic + best-of-N + warm-cache),\n"
        "                   or 'new-flow-minus-<layer>' (critic|bestofn|warmcache).\n"
        "  --ablation       Run the full leave-one-out set: baseline, full, and\n"
        "                   one full-minus-<layer> arm per layer (per-layer deltas).\n"
        "  --reps N         Repetitions per (task, arm) (default: 5; min: 1).\n"
        "  --concurrency N  Run up to N (task, arm, rep) units in parallel\n"
        "                   (default: 4; min: 1). Units are independent, so this\n"
        "                   cuts a full corpus run from hours to ~the slowest\n"
        "                   single unit, bounded by the agent API rate limit.\n"
        "  --include-held-out\n"
        "                   Include the held-out task split (excluded by default\n"
        "                   so the harness is never developed against it).\n"
        "  --pack-index-root DIR\n"
        "                   Checkout with a built context index to score context\n"
        "                   packs against (precision/recall + rerank delta).\n"
        "                   Default: the git checkout root if it has an index.\n"
        "  --no-pack-scores Skip offline pack scoring (report shows n/a).\n"
        "  -h, --help       Show this help\n"
    )


def _parse_flag_value(args: List[str], i: int, flag: str) -> str:
    if i + 1 >= len(args):
        raise ValueError(f"flag {flag} requires a value")
    return args[i + 1]


def _default_pack_index_root() -> Optional[Path]:
    """The git checkout root, when it has a built context index; else ``None``.

    The corpus tasks are pinned to this repo (``Bensigo/agentrail``) and their
    ``required_context`` answer keys resolve against this checkout, so the git
    root is the honest place to run the offline retrieval that scores pack
    precision/recall (#1029 AC2/AC3). We only return it when an index is already
    built there — pack scoring is a READ of an existing index, never a rebuild —
    so an un-indexed checkout degrades to ``None`` and the report renders ``n/a``
    honestly rather than silently doing nothing (or worse, triggering a heavy
    build). Any failure to resolve the root also degrades to ``None``.
    """
    import subprocess

    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    root = Path(out.stdout.strip())
    if not root:
        return None
    if not (root / ".agentrail" / "context" / "index" / "index.json").is_file():
        return None
    return root


def _split_csv(value: str) -> List[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _parse_run_args(args: List[str]) -> tuple[SpineConfig, bool, Optional[Path]]:
    """Parse the ``run`` subcommand args.

    Returns the :class:`SpineConfig`, a ``smoke`` flag (uses the in-process
    smoke executor instead of the real sandbox), and the optional reports dir
    override.
    """
    import os

    arms: List[Arm] = []
    tasks: List[str] = []
    reps = 5
    # Default concurrency: units are independent, so parallelize by default. The
    # env var lets a constrained environment (or a stricter API rate limit) dial
    # it down without editing the command; an explicit --concurrency flag wins.
    concurrency = int(os.environ.get("AGENTRAIL_EVAL_CONCURRENCY") or 4)
    corpus_root: Optional[Path] = None
    reports_dir: Optional[Path] = None
    smoke = False
    ablation = False
    include_held_out = False
    # Offline pack scoring (#1029). Default: discover the git checkout root and
    # use it iff it has a built index (else None → n/a, never fabricated).
    # --pack-index-root overrides the root explicitly; --no-pack-scores opts out.
    pack_index_root: Optional[Path] = _default_pack_index_root()
    no_pack_scores = False

    i = 0
    while i < len(args):
        a = args[i]
        if a in ("-h", "--help"):
            print(_usage())
            sys.exit(0)
        elif a == "--corpus":
            corpus_root = Path(_parse_flag_value(args, i, a))
            i += 2
        elif a == "--task":
            for name in _split_csv(_parse_flag_value(args, i, a)):
                tasks.append(name)
            i += 2
        elif a == "--arm":
            arms.append(resolve_arm(_parse_flag_value(args, i, a)))
            i += 2
        elif a == "--reps":
            reps = int(_parse_flag_value(args, i, a))
            i += 2
        elif a == "--concurrency":
            concurrency = int(_parse_flag_value(args, i, a))
            i += 2
        elif a == "--reports-dir":
            reports_dir = Path(_parse_flag_value(args, i, a))
            i += 2
        elif a == "--ablation":
            # Convenience: run the whole leave-one-out set (baseline + full +
            # one full-minus-<layer> arm per layer) so per-layer deltas have
            # every arm they need. Uses the enumerable arms registry, so a new
            # layer is picked up automatically.
            ablation = True
            i += 1
        elif a == "--smoke":
            # Hidden flag: don't try to run a real agent. Wired so a CI smoke
            # run can prove the CLI plumbs through to the spine without
            # spawning a sandbox. Tests assert the spine output; users get a
            # report that honestly says "unsolved" until #942.
            smoke = True
            i += 1
        elif a == "--include-held-out":
            # Honesty rail (#941): the held-out split is excluded by default so
            # the harness is never developed against it. This flag is the only
            # way to pull it in (the deliberate "score the held-out set" pass).
            include_held_out = True
            i += 1
        elif a == "--pack-index-root":
            # Explicit root for offline pack scoring (#1029). Overrides the
            # git-root default; the report renders n/a if it has no built index.
            pack_index_root = Path(_parse_flag_value(args, i, a))
            i += 2
        elif a == "--no-pack-scores":
            # Opt out of offline pack scoring (report renders n/a for
            # precision/recall). Useful when the checkout has no index and the
            # git-root default would otherwise be a slow no-op miss.
            no_pack_scores = True
            i += 1
        else:
            raise ValueError(f"unknown option: {a}")

    if ablation:
        # The full leave-one-out registry takes precedence; any explicit --arm
        # is folded in (deduplicated by name, registry order preserved).
        registry = all_arms()
        seen = {a.name for a in registry}
        arms = registry + [a for a in arms if a.name not in seen]
    elif not arms:
        arms = [resolve_arm("baseline"), resolve_arm("full")]
    # --no-pack-scores is the single kill switch: it wins over both the git-root
    # default and an explicit --pack-index-root.
    if no_pack_scores:
        pack_index_root = None
    return (
        SpineConfig(
            arms=arms,
            reps=reps,
            task_filter=tasks or None,
            corpus_root=corpus_root,
            include_held_out=include_held_out,
            concurrency=concurrency,
            pack_index_root=pack_index_root,
        ),
        smoke,
        reports_dir,
    )


def _smoke_executor() -> "SmokeFakeExecutor":
    """A faithful fake used by ``--smoke``: mirrors the AgentExecution contract.

    Not in production paths — the CLI dispatch only constructs this when
    ``--smoke`` is set, so importing this module does not pull a fake into
    real runs.
    """
    return SmokeFakeExecutor()


class SmokeFakeExecutor:
    """Smoke-test executor: returns a faithful (empty) :class:`AgentExecution`.

    Mirrors the real :class:`SandboxAgentExecutor` output shape EXACTLY: a
    real ``Usage``, a real ``bool`` gate decision, the arm's model, empty diff
    and retries. No invented stdout/stderr (the unfaithful-fake gotcha).
    """

    def execute(self, *, task, arm, workdir):  # noqa: ANN001 - duck-typed Protocol
        from agentrail.evals.runner import AgentExecution
        from agentrail.run.usage_capture import Usage

        return AgentExecution(
            diff="",
            usage=Usage(
                model=arm.model,
                input_tokens=0,
                output_tokens=0,
                cache_tokens=0,
                cache_creation_tokens=0,
            ),
            model=arm.model,
            gate_passed=False,
            retries=[],
        )


def _run_run(args: List[str]) -> int:
    try:
        config, smoke, reports_dir = _parse_run_args(args)
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    executor = _smoke_executor() if smoke else SandboxAgentExecutor()
    # AC5 (#952): the CLI uses the production hidden-test runner by default —
    # the spine no longer reports "always unsolved". Under ``--smoke`` we
    # keep the honest no-op so a CI smoke run never tries to clone the repo
    # at a fake commit nor execute pytest in a subprocess.
    hidden_runner: HiddenTestRunner = (
        UnimplementedHiddenTestRunner() if smoke else ProductionHiddenTestRunner()
    )

    result = run_spine(
        config,
        executor=executor,
        hidden_test_runner=hidden_runner,
        reports_dir=reports_dir,
    )

    print(f"Eval run id: {result.run_id}")
    if result.report_path is not None:
        print(f"Wrote markdown report: {result.report_path}")
    for r in result.arm_reports:
        dps = "n/a" if r.dollars_per_solved is None else f"${r.dollars_per_solved:.4f}"
        print(
            f"- arm={r.arm} reps={r.repetitions} solved={r.solved_count} "
            f"failed={r.failed_count} solve-rate={r.solve_rate * 100:.1f}% "
            f"spread={r.spread:.4f} $/solved={dps}"
        )

    # Intrinsic probes (#943/#960): routing cost-regret + retry lift are now
    # computed from the real RunRecords this run produced. The probe MATH lives
    # in agentrail.evals.probes — never re-derived here. The dated report carries
    # the full section; the summary echoes the headline numbers.
    from agentrail.evals.probes import retry_lift, routing_cost_regret

    routing = routing_cost_regret(result.scored_runs)
    retry = retry_lift(result.scored_runs)

    def _pct(value):
        return "n/a" if value is None else f"{value * 100:.1f}%"

    print(f"Routing cost-regret: ${routing.total_regret_usd:.4f}")
    print(
        "Retry lift: "
        f"{_pct(retry.lift)} (with-retry {_pct(retry.with_retry_solve_rate)}, "
        f"first-attempt {_pct(retry.first_attempt_solve_rate)}); "
        f"wasted-retry cost ${retry.wasted_retry_cost_usd:.4f}"
    )

    print(
        "Postgres persist: "
        + ("ok" if result.persist_ok else "no (eval-metrics ingest pending #942)")
    )
    return 0


def _run_probes(args: List[str]) -> int:
    """Run the intrinsic guardrail catch-rate probe (#943).

    AC3 stands alone: the injection corpus drives the REAL guardrails directly,
    needing no agent run. The routing cost-regret (AC1) and retry lift (AC2)
    probes are computed from per-run RunRecord fields collected during a spine
    run, so they live in the dated report produced by ``agentrail evals run``
    (issue #960 threads the RunRecords through; before that they rendered "not
    available"). This standalone subcommand has no agent run, so it renders only
    the always-available guardrail catch-rate — the safety floor in one command.
    """
    if args and args[0] in ("-h", "--help"):
        print(_usage())
        return 0

    from agentrail.evals.probes import guardrail_catch_rate
    from agentrail.evals.reporter import render_probes_markdown

    report = guardrail_catch_rate()
    print(render_probes_markdown(guardrail=report))
    return 0


def run_evals(args: List[str]) -> int:
    """Dispatch ``agentrail evals <subcommand>``."""
    kind = args[0] if args else ""

    if kind in ("", "-h", "--help"):
        print(_usage())
        return 0

    if kind == "run":
        return _run_run(args[1:])

    if kind == "probes":
        return _run_probes(args[1:])

    print(f"Unknown evals command: {kind}", file=sys.stderr)
    return 2
