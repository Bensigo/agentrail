"""The OBJECTIVE check-runner for the Objective Gate (issue #769, ADR 0007).

This is the half of the gate that produces *falsifiable* evidence: it reads the
declared verification command(s) from the run's ``.agentrail/config.json`` (the
``verify`` key) and **runs them itself** via subprocess. Exit code 0 means the
check passed; anything else (including timeout) means it failed. The agent's own
"it works" self-report is never consulted — that signal is unfalsifiable.

Layering (verification-contract-architecture.md): the *pure* mapping —
``parse_verify_config`` (config → check specs), ``exit_code_to_check_result``
(exit code → CheckResult), and ``ac_coverage_for`` (declared checks → coverage)
— is deterministic and unit-tested in isolation. ``run_objective_checks`` is the
thin I/O part: it loads config and spawns each subprocess in the run's target
dir under a wall-clock timeout, then feeds the pure mapping.

The ``verify`` config shape:

    "verify": "pytest -q"                       # single command → one check
    "verify": [                                  # list → N named checks
        {"name": "tests", "command": "pytest -q"},
        {"name": "lint",  "command": "ruff check ."}
    ]

Acceptance-criteria coverage here is *declared-verification present*, not
per-AC mapping. >=1 declared ``verify`` check → ``AcCoverage(total, total)`` so
the gate can be green; no ``verify`` configured → ``AcCoverage(0, 0)`` → the gate
is RED ("no objective verification declared" — we cannot verify, so it is not
done). Real per-AC coverage is deferred to the Independent Verifier (#782); this
module is honest that it only proves "verification was declared and run".
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, List, Mapping, Optional

from agentrail.run.objective_gate import AcCoverage, CheckResult
from agentrail.run.proc import run_with_timeout

_log = logging.getLogger(__name__)

# Wall-clock ceiling for a single verify command. A hung check must fail the
# gate (red), not stall the run forever; mirrors proc's 124 timeout convention.
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


def _load_config(target_dir: Path) -> Optional[Mapping[str, Any]]:
    """Load ``<target_dir>/.agentrail/config.json`` or return None if absent."""
    config_path = Path(target_dir) / ".agentrail" / "config.json"
    if not config_path.is_file():
        return None
    try:
        import json

        data = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception as exc:  # pragma: no cover - defensive
        _log.warning("could not parse %s: %s", config_path, exc)
        return None
    return data if isinstance(data, Mapping) else None


def load_verify_checks(target_dir: Path) -> List[VerifyCheck]:
    """Load + parse the declared ``verify`` checks for ``target_dir`` (thin I/O).

    Reads ``<target_dir>/.agentrail/config.json`` and returns the parsed
    ``VerifyCheck`` list (empty when no config or no ``verify`` key). This is the
    single source the pipeline uses both to RUN the checks and to compute
    ``AcCoverage`` from the *declared* set, so the two never drift.
    """
    return parse_verify_config(_load_config(Path(target_dir)))


def run_objective_checks(
    target_dir: Path,
    *,
    timeout: int = DEFAULT_CHECK_TIMEOUT,
    log_dir: Optional[Path] = None,
) -> List[CheckResult]:
    """Run every declared ``verify`` check in ``target_dir`` (thin I/O).

    Loads ``.agentrail/config.json``, parses the ``verify`` key, then executes
    each command via ``bash -lc`` in ``target_dir`` under a wall-clock timeout,
    mapping each exit code to a CheckResult. Returns the results in declared
    order. No declared checks → empty list (the gate reads that as red).

    Args:
        target_dir: the run's working directory; commands run here.
        timeout: per-check wall-clock ceiling in seconds.
        log_dir: where to tee each check's combined output (defaults to
            ``<target_dir>/.agentrail/run/checks``).
    """
    target_dir = Path(target_dir)
    checks = load_verify_checks(target_dir)
    if not checks:
        return []

    out_dir = Path(log_dir) if log_dir else (target_dir / ".agentrail" / "run" / "checks")
    out_dir.mkdir(parents=True, exist_ok=True)

    results: List[CheckResult] = []
    for check in checks:
        output_file = out_dir / f"{_safe_name(check.name)}.log"
        exit_code = run_with_timeout(
            ["bash", "-lc", check.command],
            cwd=target_dir,
            timeout=timeout,
            output_file=output_file,
        )
        results.append(exit_code_to_check_result(check.name, exit_code))
    return results


def _safe_name(name: str) -> str:
    """A filesystem-safe slug for a check name (for the per-check log file)."""
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in name) or "check"
