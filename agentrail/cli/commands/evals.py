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
        "  run    Run the eval spine (corpus -> runner -> hidden-test scorer\n"
        "         -> repetitions -> report).\n"
        "\n"
        "Options:\n"
        "  --corpus DIR     Override the corpus root (default: bundled v0).\n"
        "  --task NAME      Restrict to NAME (repeatable; or comma-separated).\n"
        "  --arm NAME       Add an arm (repeatable). Default: baseline + full.\n"
        "                   Accepts 'baseline', 'full', or 'full-minus-<layer>'.\n"
        "  --ablation       Run the full leave-one-out set: baseline, full, and\n"
        "                   one full-minus-<layer> arm per layer (per-layer deltas).\n"
        "  --reps N         Repetitions per (task, arm) (default: 5; min: 1).\n"
        "  -h, --help       Show this help\n"
    )


def _parse_flag_value(args: List[str], i: int, flag: str) -> str:
    if i + 1 >= len(args):
        raise ValueError(f"flag {flag} requires a value")
    return args[i + 1]


def _split_csv(value: str) -> List[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _parse_run_args(args: List[str]) -> tuple[SpineConfig, bool, Optional[Path]]:
    """Parse the ``run`` subcommand args.

    Returns the :class:`SpineConfig`, a ``smoke`` flag (uses the in-process
    smoke executor instead of the real sandbox), and the optional reports dir
    override.
    """
    arms: List[Arm] = []
    tasks: List[str] = []
    reps = 5
    corpus_root: Optional[Path] = None
    reports_dir: Optional[Path] = None
    smoke = False
    ablation = False

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
    return (
        SpineConfig(
            arms=arms,
            reps=reps,
            task_filter=tasks or None,
            corpus_root=corpus_root,
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
    print(
        "Postgres persist: "
        + ("ok" if result.persist_ok else "no (eval-metrics ingest pending #942)")
    )
    return 0


def run_evals(args: List[str]) -> int:
    """Dispatch ``agentrail evals <subcommand>``."""
    kind = args[0] if args else ""

    if kind in ("", "-h", "--help"):
        print(_usage())
        return 0

    if kind == "run":
        return _run_run(args[1:])

    print(f"Unknown evals command: {kind}", file=sys.stderr)
    return 2
