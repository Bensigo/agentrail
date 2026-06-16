"""The Objective Gate — the falsifiable definition of "done" (ADR 0007).

A run is "done" only when the **Objective Gate** is green: tests, build, and
lint pass AND the issue's acceptance-criteria coverage is satisfied. An LLM
reviewer's opinion ("looks good") never decides done — that signal is
unfalsifiable, so it is demoted to advisory **Code Review** (ADR 0007). The
gate is the only signal that says a run is complete and the signal that
triggers model escalation when it comes back red.

This is a **deep, pure module** (verification-contract-architecture.md): it
takes already-computed check *results* and acceptance-criteria coverage as plain
inputs and returns a verdict. It runs no tools, touches no I/O, and imports
neither the pipeline, the DB, nor the network. The actual command-running
(pytest/build/lint) is thin orchestration in the pipeline; that keeps this
module deterministic and unit-testable in isolation.

It is distinct from the server-side ``agentrail/server/gates.py`` (the Review
Gate policy read model) and must not be merged with it.

Red-Green Proof seam (ADR 0008 / issue #772): the gate accepts an optional
``red_green_evidence`` input describing whether a Red-Green Proof trail is
required and whether it is valid. This PR does not build the recorder (#772);
it leaves a clean seam so that, once the recorder exists, requiring a valid
fail→pass trail is a matter of passing real evidence here. Until then the
default (``None``, not required) keeps behavior unchanged.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence

# The objective checks that gate "done". Order is the canonical evidence order.
REQUIRED_CHECKS = ("tests", "build", "lint")


@dataclass(frozen=True)
class CheckResult:
    """The outcome of one objective check (tests, build, or lint).

    ``passed`` is the falsifiable bit; ``detail`` is human-readable evidence
    (e.g. "42 passed", "compile error in foo.py").
    """

    name: str
    passed: bool
    detail: str = ""


@dataclass(frozen=True)
class AcCoverage:
    """Acceptance-criteria coverage for the issue.

    ``total`` is the number of declared, machine-checkable acceptance criteria;
    ``covered`` is how many are satisfied/exercised. Coverage is satisfied only
    when there is at least one criterion and every one is covered — an issue
    with no declared criteria has nothing objective to satisfy and cannot reach
    green (ADR 0007's input-contract spirit).
    """

    total: int
    covered: int

    @property
    def is_satisfied(self) -> bool:
        return self.total > 0 and self.covered >= self.total


@dataclass(frozen=True)
class Evidence:
    """One line of evidence behind the verdict."""

    name: str
    passed: bool
    detail: str = ""


@dataclass(frozen=True)
class GateResult:
    """The Objective Gate verdict plus the evidence trail behind it.

    ``is_green`` is the single done signal. ``failed_reasons`` names every
    reason the gate is red (an empty list iff green). ``evidence`` is the full
    trail (every check + AC coverage) so the run surface can show *why*.
    """

    is_green: bool
    evidence: List[Evidence]
    failed_reasons: List[str] = field(default_factory=list)

    @property
    def verdict(self) -> str:
        return "green" if self.is_green else "red"

    def to_dict(self) -> Dict[str, Any]:
        """Plain, JSON-serializable dict for persisting to the run surface."""
        return {
            "verdict": self.verdict,
            "isGreen": self.is_green,
            "failedReasons": list(self.failed_reasons),
            "evidence": [
                {"name": e.name, "passed": e.passed, "detail": e.detail}
                for e in self.evidence
            ],
        }


def evaluate(
    *,
    checks: Sequence[CheckResult],
    ac_coverage: AcCoverage,
    red_green_evidence: Optional[Mapping[str, Any]] = None,
) -> GateResult:
    """Evaluate the Objective Gate.

    Green ONLY when every objective check (tests/build/lint) passed AND the
    acceptance-criteria coverage is satisfied AND — when a Red-Green Proof trail
    is required — that trail is valid. Otherwise red, with ``failed_reasons``
    naming each failure.

    Args:
        checks: the already-computed results of the objective checks. Any check
            with ``passed=False`` makes the gate red.
        ac_coverage: declared-vs-covered acceptance criteria for the issue.
        red_green_evidence: optional Red-Green Proof seam (#772). A mapping with
            ``required`` and ``valid`` flags. When ``required`` is true and
            ``valid`` is false the gate is red even on an all-pass run. ``None``
            means no proof is required (this PR's default).
    """
    evidence: List[Evidence] = []
    failed_reasons: List[str] = []

    for check in checks:
        evidence.append(Evidence(name=check.name, passed=check.passed, detail=check.detail))
        if not check.passed:
            failed_reasons.append(check.name)

    if ac_coverage.is_satisfied:
        evidence.append(
            Evidence(
                name="acceptance-criteria",
                passed=True,
                detail=f"{ac_coverage.covered}/{ac_coverage.total} covered",
            )
        )
    else:
        if ac_coverage.total == 0:
            detail = "no acceptance criteria declared"
        else:
            detail = f"{ac_coverage.covered}/{ac_coverage.total} covered"
        evidence.append(Evidence(name="acceptance-criteria", passed=False, detail=detail))
        failed_reasons.append("acceptance-criteria not satisfied")

    # Red-Green Proof seam (#772): only gates when a proof is explicitly
    # required. The recorder that produces this evidence is built separately.
    if red_green_evidence is not None and red_green_evidence.get("required"):
        valid = bool(red_green_evidence.get("valid"))
        evidence.append(
            Evidence(
                name="red-green-proof",
                passed=valid,
                detail="valid fail→pass trail" if valid else "no valid fail→pass trail",
            )
        )
        if not valid:
            failed_reasons.append("red-green proof trail invalid")

    return GateResult(
        is_green=not failed_reasons,
        evidence=evidence,
        failed_reasons=failed_reasons,
    )
