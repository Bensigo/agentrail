"""Objective check-runner adapter — the subprocess/file I/O (issue #921).

The check-runner policy (:mod:`agentrail.guardrails.policies.check_runner`) is
pure: it parses config and maps exit codes.  Something has to actually load
``.agentrail/config.json`` and spawn each verify command — that is this adapter's
job, and the only job done here.  This is where ``subprocess`` (via
``run_with_timeout``) and the config-file reads live (AC2); the policy never
imports them.

Public API (consumed by the run pipeline, via the back-compat shim):
  load_verify_checks(target_dir)        — parse declared verify checks (thin I/O)
  red_green_proof_required(target_dir)  — read the redGreenProof flag (thin I/O)
  run_objective_checks(target_dir, ...) — spawn each verify command (I/O)
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, List, Mapping, Optional

from agentrail.guardrails.policies.check_runner import (
    DEFAULT_CHECK_TIMEOUT,
    VerifyCheck,
    exit_code_to_check_result,
    parse_verify_config,
)
from agentrail.run.objective_gate import CheckResult
from agentrail.run.proc import run_with_timeout

_log = logging.getLogger(__name__)


def _load_config(target_dir: Path) -> Optional[Mapping[str, Any]]:
    """Load ``<target_dir>/.agentrail/config.json`` or return None if absent."""
    config_path = Path(target_dir) / ".agentrail" / "config.json"
    if not config_path.is_file():
        return None
    try:
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


def red_green_proof_required(target_dir: Path) -> bool:
    """Whether this run requires a Red-Green Proof trail (thin I/O).

    Reads the optional ``redGreenProof`` flag from ``.agentrail/config.json``.
    The Red-Green Proof (ADR 0008) is the **verification spine**, and the MVP
    turns it ON BY DEFAULT: the pipeline runs the Test-Author → execute → verify
    role split and the Objective Gate refuses done without a valid fail→pass
    trail (#772). It is the DEFAULT unless a caller explicitly opts out with
    ``"redGreenProof": false`` — that minimal flow is for callers who genuinely
    need the old single-execute behavior (AC3).

    Truth table (the value of ``redGreenProof``):
      - missing / ``null`` / ``true``  → ``True``  (spine ON, the default)
      - ``false``                      → ``False`` (explicit opt-out)
    """
    config = _load_config(Path(target_dir))
    if not config:
        # No config at all → spine is still ON by default (MVP). A run with no
        # declared verify will then be RED at the gate ("no verification
        # declared"), which is the intended honest default — not a silent pass.
        return True
    value = config.get("redGreenProof")
    if value is None:
        return True
    return bool(value)


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


__all__ = [
    "load_verify_checks",
    "red_green_proof_required",
    "run_objective_checks",
]
