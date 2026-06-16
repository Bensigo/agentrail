"""The Red-Green Proof seam for the Test-Author/Implementer role split.

The role split (M032, ADR 0008, issue #775) defeats false-green: a **Test-Author**
authors a *failing* acceptance test from the issue's acceptance criteria BEFORE
any implementation, and a DISTINCT **Implementer** turns that test green. The
falsifiable evidence the **Objective Gate** then requires is the **Red-Green
Proof** — the acceptance test observed failing (red) before implementation and
passing (green) after.

This module owns the opt-in seam and the red→green observation:

- ``red_green_proof_required(target_dir)`` reads the ``redGreenProof`` flag from
  ``.agentrail/config.json`` (top-level, or nested under ``objectiveGate``). It
  is the single place the pipeline consults to decide whether to run the
  Test-Author role and require a genuine fail→pass trail. Default is ``False``
  so the role split is opt-in and existing single-execute-phase runs are
  unchanged.
- ``red_green_evidence(red_results, green_results)`` turns the two observation
  passes into the mapping the Objective Gate's ``red_green_evidence`` seam reads
  (``{"required": True, "valid": <bool>}``). The trail is valid only when the
  acceptance checks were observed RED before implementation and GREEN after —
  proving the test is real and that the change caused the pass.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Sequence

from agentrail.run.check_runner import _load_config
from agentrail.run.objective_gate import CheckResult


def red_green_proof_required(target_dir: Path) -> bool:
    """Whether the run requires a Red-Green Proof (opt-in via config).

    Reads ``<target_dir>/.agentrail/config.json`` and returns ``True`` only when
    the ``redGreenProof`` flag is truthy — either at the top level or nested
    under an ``objectiveGate`` block. Missing config / missing flag → ``False``
    (the role split is off by default; existing runs are unchanged).
    """
    config = _load_config(Path(target_dir))
    if not config:
        return False
    if bool(config.get("redGreenProof")):
        return True
    gate = config.get("objectiveGate")
    if isinstance(gate, Mapping) and bool(gate.get("redGreenProof")):
        return True
    return False


def _all_present_and(results: Sequence[CheckResult], *, passed: bool) -> bool:
    """True iff there is >=1 result and every result has ``passed == passed``."""
    results = list(results)
    return bool(results) and all(r.passed is passed for r in results)


def red_green_evidence(
    red_results: Optional[Sequence[CheckResult]],
    green_results: Optional[Sequence[CheckResult]],
) -> Dict[str, Any]:
    """Build the Objective Gate ``red_green_evidence`` mapping from two passes.

    The trail is VALID only when the declared acceptance checks were observed
    failing (red) BEFORE implementation and passing (green) AFTER — proving the
    Test-Author's test is real (it failed without the change) and that the
    Implementer's change caused the pass. A trail where the "red" pass already
    passed is INVALID: the test never exercised the missing behaviour (a
    tautological / pre-passing test), which is exactly the false-green we defeat.

    Args:
        red_results: check results from the RED baseline (after the Test-Author
            authored the test, before the Implementer ran). Expected all-failing.
        green_results: check results from the GREEN pass (after the Implementer).
            Expected all-passing.
    """
    observed_red = _all_present_and(red_results or [], passed=False)
    observed_green = _all_present_and(green_results or [], passed=True)
    return {"required": True, "valid": observed_red and observed_green}
