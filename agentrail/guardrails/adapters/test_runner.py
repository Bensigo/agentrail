"""Test-runner adapter — produces the ``test_results`` slice of
:class:`~agentrail.guardrails.signals.Signals` (issue #919).

Running a test suite is environment I/O and framework-specific (pytest, jest, go
test, …), so it lives HERE, never in a policy (AC4).  Policies read the resulting
:class:`~agentrail.guardrails.signals.TestResult` tuple — a name + passed/failed —
and never know which runner produced it.

The runner *command* is a parameter, not a literal, so this adapter is itself
framework-neutral: a Python repo passes a pytest command, a TS repo passes a jest
command.  ``verify_gate``'s default Python config (#907 parity) supplies the
pytest command at the call site, keeping that literal OUT of both the policy and
this adapter's defaults.
"""
from __future__ import annotations

import subprocess
from typing import List, Sequence, Tuple

from agentrail.guardrails.signals import TestResult


def run_tests(
    command: Sequence[str], *, names: Sequence[str] = (), cwd: str = "."
) -> Tuple[Tuple[TestResult, ...], int]:
    """Run *command* and return ``(test_results, exit_code)``.

    ``command`` is the full runner invocation (e.g.
    ``[sys.executable, "-m", "pytest", "-q", *files]``) — supplied by the caller
    so no framework literal lives here.  ``names`` labels the resulting
    :class:`TestResult`s (typically the changed test files); a single aggregate
    result is recorded per name with ``passed`` derived from the exit code.

    Best-effort: a launch failure returns a single failed result and exit code 1,
    never raises.
    """
    try:
        proc = subprocess.run(command, cwd=cwd, capture_output=True, text=True)
        exit_code = proc.returncode
        message = (proc.stdout or "") + (proc.stderr or "")
    except Exception as exc:  # pragma: no cover - launch failure path
        exit_code = 1
        message = f"failed to launch test runner: {exc!r}"

    passed = exit_code == 0
    labels = list(names) or ["tests"]
    results: List[TestResult] = [
        TestResult(name=label, passed=passed, message=message if not passed else None)
        for label in labels
    ]
    return tuple(results), exit_code


__all__ = ["run_tests"]
