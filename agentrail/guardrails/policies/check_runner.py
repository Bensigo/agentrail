"""Objective check-runner guardrail — PURE policy (no subprocess/file I/O).

Migrated (decision semantics unchanged) from ``agentrail/run/check_runner.py``
for issue #921.  The check-runner is the half of the Objective Gate that produces
*falsifiable* evidence: it reads the declared verification command(s) and runs
them, mapping exit code 0 → passed and anything else → failed.

This module holds only the **pure mapping** (the deterministic, unit-tested half
described in ``verify-contract-architecture.md``):

* :class:`VerifyCheck` — one declared verification command (name + command).
* :func:`parse_verify_config` — ``verify`` config → check specs.
* :func:`exit_code_to_check_result` — subprocess exit code → ``CheckResult``.
* :func:`ac_coverage_for` — declared checks → ``AcCoverage``.
* :class:`CheckRunnerGuardrail` — the seam adapter: given already-run
  ``CheckResult``s, ``PASS`` iff every check passed (and at least one was run).

What deliberately does NOT live here
------------------------------------
The thin I/O part — loading ``.agentrail/config.json`` and spawning each
subprocess (``run_objective_checks`` / ``load_verify_checks`` /
``red_green_proof_required``) — lives in
:mod:`agentrail.guardrails.adapters.check_runner` (AC2).  Importing this module
pulls in no ``subprocess``/``gh``/``git``/``pytest``.  ``AcCoverage`` /
``CheckResult`` come from the pure ``objective_gate`` types module.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, List, Mapping, Optional, Sequence

from agentrail.guardrails.base import Verdict
from agentrail.guardrails.registry import register
from agentrail.run.objective_gate import AcCoverage, CheckResult

# Wall-clock ceiling for a single verify command. A hung check must fail the
# gate (red), not stall the run forever; mirrors proc's 124 timeout convention.
# Kept here so both the pure parser and the I/O adapter share one default.
DEFAULT_CHECK_TIMEOUT = 600


@dataclass(frozen=True)
class VerifyCheck:
    """One declared verification command: a name and the shell command to run."""

    name: str
    command: str


def parse_verify_config(config: Optional[Mapping[str, Any]]) -> List[VerifyCheck]:
    """Parse the ``verify`` key of ``.agentrail/config.json`` into check specs.

    Pure. Accepts either a single command string (→ one check named ``verify``)
    or a list of ``{name, command}`` objects (→ N checks). A missing/empty
    ``verify`` (or ``None`` config) yields an empty list, which the gate reads as
    "no objective verification declared".
    """
    if not config:
        return []

    verify = config.get("verify")
    if not verify:
        return []

    if isinstance(verify, str):
        command = verify.strip()
        return [VerifyCheck(name="verify", command=command)] if command else []

    checks: List[VerifyCheck] = []
    if isinstance(verify, (list, tuple)):
        for index, entry in enumerate(verify):
            if not isinstance(entry, Mapping):
                continue
            command = str(entry.get("command", "")).strip()
            if not command:
                # A check with no command cannot be run objectively — skip it.
                continue
            name = str(entry.get("name") or f"verify[{index}]")
            checks.append(VerifyCheck(name=name, command=command))
    return checks


def exit_code_to_check_result(name: str, exit_code: int) -> CheckResult:
    """Map a subprocess exit code to a CheckResult (pure).

    Exit code 0 → passed. Non-zero → failed, with the code in the detail. The
    timeout sentinel (124, from ``run_with_timeout``) is reported explicitly so
    a hung check reads as "timed out" rather than an opaque non-zero exit.
    """
    if exit_code == 0:
        return CheckResult(name=name, passed=True, detail="exit 0")
    if exit_code == 124:
        return CheckResult(name=name, passed=False, detail="timed out")
    return CheckResult(name=name, passed=False, detail=f"exit {exit_code}")


def ac_coverage_for(checks: List[VerifyCheck]) -> AcCoverage:
    """Compute AcCoverage from the *declared* checks (pure).

    Coverage here means declared-verification is present — NOT per-AC mapping
    (deferred to the Verifier #782). >=1 declared check → fully covered so the
    gate can reach green; zero declared checks → ``AcCoverage(0, 0)`` which the
    gate treats as red ("no acceptance criteria declared" / can't verify).
    """
    total = len(checks)
    return AcCoverage(total=total, covered=total)


# ---------------------------------------------------------------------------
# Guardrail seam adapter (pure) — registered so `list_guardrails()` sees it.
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class CheckRunnerGuardrail:
    """Adapts the objective check results to the :class:`Guardrail` protocol.

    Blocking guardrail.  The subprocess execution is I/O (it lives in the adapter
    :mod:`agentrail.guardrails.adapters.check_runner`); this guardrail's pure
    decision is over the *already-run* ``CheckResult``s: ``PASS`` iff at least one
    check ran and every check passed, else ``FAIL`` (no checks → red, "no
    objective verification declared", matching the Objective Gate's honest
    default).  ``evaluate(results=[CheckResult, ...])``.
    """

    name: str = "check_runner"
    description: str = (
        "Runs the declared objective verification command(s) and requires every "
        "check to pass; a run with no declared verification is red ('no objective "
        "verification declared')."
    )
    blocking: bool = True

    def evaluate(self, **kwargs: object) -> Verdict:
        results = kwargs.get("results", ())
        if not isinstance(results, Sequence):
            raise TypeError(
                "CheckRunnerGuardrail.evaluate requires a results= sequence of "
                "CheckResult"
            )
        results = tuple(results)
        if not results:
            return Verdict.failing("no objective verification declared")
        failed = [r for r in results if not getattr(r, "passed", False)]
        if failed:
            return Verdict.failing(
                *[f"{r.name}: {getattr(r, 'detail', 'failed')}" for r in failed]
            )
        return Verdict.passing()


# Register the singleton instance at import time so `list_guardrails()` sees it.
CHECK_RUNNER_GUARDRAIL = register(CheckRunnerGuardrail())
