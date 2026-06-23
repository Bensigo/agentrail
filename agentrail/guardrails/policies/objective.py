"""The unified **Objective Gate** — the single, falsifiable definition of "done".

CONTEXT.md: the Objective Gate is "the only signal that says a run is complete"
and the signal that triggers escalation. There must be **exactly one** definition
of done. This module is that one definition, shared by BOTH harnesses:

* the **sync** ``run`` harness (post-execute verification: tests/build/lint +
  acceptance-criteria coverage + the Red-Green / Independent-Verification seams);
* the **async** ``afk`` harness (post-PR merge gate: CI checks, with a *pending*
  hold while CI is still running, + deterministic security: committed-secret scan
  and deleted-file-still-referenced).

Before #920 these two harnesses each owned a *separate*, drifted ``objective_gate``
module. This policy is the reconciled **superset**: every check either gate
performed is carried here (see the PR body for the full reconciliation table).
``agentrail/run/objective_gate.py`` and ``agentrail/afk/objective_gate.py`` are now
thin re-export shims that delegate their decision logic here — no decision logic is
duplicated anywhere else (AC4).

Purity
------
This module is **pure**: it takes already-computed check *results*, CI-check data,
and diff data as plain inputs and returns a verdict. It runs no tools and touches
no I/O, the network, the DB, or the pipeline. Running pytest/build/lint, polling
CI, scanning a diff, and grepping for references are all thin orchestration in the
two harnesses; that keeps this module deterministic and unit-testable in isolation.

Tri-state verdict (the reconciliation that matters)
---------------------------------------------------
The sync gate was binary (green/red); the async gate had a third **pending** state
(CI still running — neither merge nor fail yet). The superset preserves *pending*:
:class:`ObjectiveVerdict` has a ``state`` of ``"pass" | "fail" | "pending"``.
``pass`` is the single done/merge signal. The sync harness, which never produces
CI checks, can only ever reach ``pass``/``fail`` — behaviour is unchanged for it.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence

from agentrail.guardrails.base import Verdict
from agentrail.guardrails.registry import register

# The objective checks that gate "done" for the sync harness. Canonical order.
REQUIRED_CHECKS = ("tests", "build", "lint")


# ---------------------------------------------------------------------------
# Pure input/result types — the superset both harnesses' shims map onto.
# ---------------------------------------------------------------------------


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
    when there is at least one criterion and every one is covered — an issue with
    no declared criteria has nothing objective to satisfy and cannot reach green.
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
class ObjectiveVerdict:
    """The unified Objective Gate verdict plus the evidence trail behind it.

    ``state`` is the tri-state superset: ``"pass"`` is the single done/merge
    signal, ``"fail"`` is a hard block, ``"pending"`` is the async hold while CI
    is still running (the sync harness never produces this). ``failed_reasons``
    names every reason the gate is not green (empty iff ``state == "pass"``).
    ``evidence`` is the full trail so a run surface can show *why*.
    """

    state: str
    evidence: List[Evidence] = field(default_factory=list)
    failed_reasons: List[str] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        """``True`` only for a clean ``pass`` — the single done/merge signal."""
        return self.state == "pass"

    @property
    def is_green(self) -> bool:
        """Alias of :attr:`passed` for the sync harness's binary vocabulary."""
        return self.state == "pass"

    @property
    def reasons(self) -> List[str]:
        """Alias of :attr:`failed_reasons` for the async harness's vocabulary."""
        return self.failed_reasons

    @property
    def verdict(self) -> str:
        """Sync harness's two-word vocabulary: ``"green"`` iff pass, else ``"red"``."""
        return "green" if self.state == "pass" else "red"

    def to_dict(self) -> Dict[str, Any]:
        """Plain, JSON-serializable dict for persisting to the run surface."""
        return {
            "verdict": self.verdict,
            "state": self.state,
            "isGreen": self.is_green,
            "failedReasons": list(self.failed_reasons),
            "evidence": [
                {"name": e.name, "passed": e.passed, "detail": e.detail}
                for e in self.evidence
            ],
        }


# ---------------------------------------------------------------------------
# CI evaluation (carried from afk/objective_gate.evaluate_ci) — pure.
# ---------------------------------------------------------------------------


def evaluate_ci(checks: Sequence[Mapping[str, Any]]) -> Optional[ObjectiveVerdict]:
    """Evaluate CI checks. Returns a fail/pending verdict, or ``None`` when all pass.

    Carried verbatim (semantics) from the async gate:

    * **Zero checks is a FAIL** — merging with no objective signal violates the
      "exactly one definition of done" rule (no false-green).
    * Any check in state ``"fail"`` → FAIL (short-circuits before pending: a
      failing check wins over a still-pending one, so we do not wait on CI we
      already know will not merge).
    * Otherwise any check in state ``"pending"`` → PENDING (the async hold).
    * All pass → ``None`` (CI is clean; the caller proceeds to security checks).
    """
    if not checks:
        return ObjectiveVerdict(
            "fail",
            evidence=[Evidence("ci", False, "no CI checks configured on the PR")],
            failed_reasons=["no CI checks configured on the PR"],
        )
    failed = [c["name"] for c in checks if c.get("state") == "fail"]
    if failed:
        reasons = [f"CI check '{n}' failed" for n in failed]
        return ObjectiveVerdict(
            "fail",
            evidence=[Evidence(f"ci:{n}", False, "failed") for n in failed],
            failed_reasons=reasons,
        )
    pending = [c["name"] for c in checks if c.get("state") == "pending"]
    if pending:
        reasons = [f"CI check '{n}' still running" for n in pending]
        return ObjectiveVerdict(
            "pending",
            evidence=[Evidence(f"ci:{n}", False, "still running") for n in pending],
            failed_reasons=reasons,
        )
    return None


# ---------------------------------------------------------------------------
# Deterministic security checks (carried from afk/objective_gate) — pure.
# ---------------------------------------------------------------------------

# High-confidence secret patterns. Conservative on purpose — a false positive
# blocks a merge, so we only match shapes that are almost never legitimate in a
# diff's added lines. This is the SUPERSET of the async gate's three patterns and
# the migrated push_guardrail's six (kinds added so secret detection is strictly
# stronger here, never weaker — the stricter/safer reconciliation, no false-green).
_SECRET_PATTERNS = [
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?[A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),                  # AWS access key id
    re.compile(r"\bgh[posur]_[0-9A-Za-z]{36,}\b"),                 # GitHub tokens
    re.compile(r"\bxox[baprs]-[0-9A-Za-z-]{10,}\b"),               # Slack tokens
    re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b"),                     # Google API key
    re.compile(r"\bsk_live_[0-9A-Za-z]{16,}\b"),                   # Stripe live secret
    re.compile(r"(?i)\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*['\"][^'\"]{12,}['\"]"),
]


def scan_secrets(added_lines: Sequence[str]) -> List[str]:
    """Return one reason per added line that looks like a committed secret (pure)."""
    reasons: List[str] = []
    for line in added_lines:
        for pat in _SECRET_PATTERNS:
            if pat.search(line):
                reasons.append(f"possible secret/key in added line: {line.strip()[:80]}")
                break
    return reasons


def deleted_files_in_use(
    deleted_files: Sequence[str], references: Mapping[str, List[str]]
) -> List[str]:
    """Return one reason per deleted file still referenced elsewhere (pure).

    ``references`` maps each deleted path to the list of files that still
    reference it (computed by the harness via grep).
    """
    reasons: List[str] = []
    for path in deleted_files:
        refs = references.get(path) or []
        if refs:
            reasons.append(
                f"deleted file '{path}' is still referenced by {', '.join(refs[:3])}"
            )
    return reasons


# ---------------------------------------------------------------------------
# The unified pure decision — the SUPERSET of both old gates.
# ---------------------------------------------------------------------------


def evaluate_objective(
    *,
    checks: Optional[Sequence[CheckResult]] = None,
    ac_coverage: Optional[AcCoverage] = None,
    red_green_evidence: Optional[Mapping[str, Any]] = None,
    verification_evidence: Optional[Mapping[str, Any]] = None,
    ci_checks: Optional[Sequence[Mapping[str, Any]]] = None,
    added_lines: Optional[Sequence[str]] = None,
    deleted_files: Optional[Sequence[str]] = None,
    references: Optional[Mapping[str, List[str]]] = None,
) -> ObjectiveVerdict:
    """Evaluate the unified Objective Gate (the single definition of "done").

    This is the SUPERSET of the two legacy gates. The two harnesses pass
    *different* subsets of these inputs; an input left ``None`` contributes no
    check (so neither harness's behaviour changes), but a supplied input is
    evaluated with EXACTLY the legacy semantics.

    Evaluation order (CI may short-circuit to pending — the only non-pass that is
    not a hard fail):

    1. **CI checks** (async harness). When ``ci_checks`` is supplied, a fail or a
       *pending* verdict is returned immediately (pending means "hold", not a
       hard fail). Only when CI is fully clean do the remaining checks run.
    2. **Objective checks** (sync harness): every ``CheckResult`` must pass.
    3. **Acceptance-criteria coverage** (sync harness): satisfied, else fail.
    4. **Red-Green Proof seam** (#772): when required and invalid → fail.
    5. **Independent Verification seam** (#782): when required and rejected → fail.
    6. **Deterministic security** (async harness): committed-secret scan and
       deleted-file-still-referenced; any hit → fail.

    Returns an :class:`ObjectiveVerdict`. ``state == "pass"`` is the single
    done/merge signal; otherwise ``failed_reasons`` names every failure.
    """
    evidence: List[Evidence] = []
    failed_reasons: List[str] = []

    # 1. CI checks first (async harness). A fail/pending here short-circuits —
    #    a pending CI must not be allowed to fall through to a "pass" verdict, and
    #    a hard CI fail wins over everything (no false-green).
    if ci_checks is not None:
        ci = evaluate_ci(ci_checks)
        if ci is not None:
            # CI is failing or pending — return it directly (carries its own
            # evidence + reasons + the pending/fail state).
            return ci
        # CI fully clean: record one positive evidence line and continue.
        evidence.append(Evidence("ci", True, "all CI checks passed"))

    # 2. Objective checks (sync harness): tests / build / lint.
    if checks is not None:
        for check in checks:
            evidence.append(
                Evidence(name=check.name, passed=check.passed, detail=check.detail)
            )
            if not check.passed:
                failed_reasons.append(check.name)

    # 3. Acceptance-criteria coverage (sync harness). Only evaluated when the
    #    sync harness supplies coverage — the async harness does not declare AC
    #    here, so it is left None and contributes nothing (behaviour preserved).
    if ac_coverage is not None:
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
            evidence.append(
                Evidence(name="acceptance-criteria", passed=False, detail=detail)
            )
            failed_reasons.append("acceptance-criteria not satisfied")

    # 4. Red-Green Proof seam (#772): only gates when a proof is explicitly
    #    required. The recorder that produces this evidence is built separately.
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

    # 5. Independent Verification seam (#782): a blocking, narrow check by a
    #    DIFFERENT model than the Implementer. Only gates when the verifier ran
    #    (``required``). A rejection blocks done even on an all-pass run.
    if verification_evidence is not None and verification_evidence.get("required"):
        accepted = bool(verification_evidence.get("valid"))
        detail = (
            "verifier accepted"
            if accepted
            else str(verification_evidence.get("reason") or "verifier rejected")
        )
        evidence.append(
            Evidence(name="independent-verification", passed=accepted, detail=detail)
        )
        if not accepted:
            failed_reasons.append("independent verification rejected")

    # 6. Deterministic security (async harness): committed-secret scan and
    #    deleted-file-still-referenced. The async gate ran these only after CI was
    #    clean (step 1 already returned on a CI fail/pending), preserving order.
    security_reasons: List[str] = []
    if added_lines is not None:
        security_reasons.extend(scan_secrets(added_lines))
    if deleted_files is not None:
        security_reasons.extend(
            deleted_files_in_use(deleted_files, references or {})
        )
    for reason in security_reasons:
        evidence.append(Evidence(name="security", passed=False, detail=reason))
    failed_reasons.extend(security_reasons)

    state = "fail" if failed_reasons else "pass"
    return ObjectiveVerdict(
        state=state,
        evidence=evidence,
        failed_reasons=failed_reasons,
    )


def fix_prompt(pr: int, reasons: Sequence[str]) -> str:
    """Instruction handed to the agent to fix OBJECTIVE failures (carried from afk)."""
    lines = [
        f"The objective gate is blocking merge of PR #{pr}. Fix the following "
        f"objective failures on the current PR branch. These are CI/security "
        f"failures, not style opinions — they must pass before merge.",
        "",
        "Make the minimal, correct change for each. Do not refactor unrelated "
        "code. Commit your changes. Do not open a new PR or issue.",
        "",
    ]
    for i, r in enumerate(reasons, 1):
        lines.append(f"{i}. {r}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Guardrail seam adapter (pure) — registered so `list_guardrails()` sees it (AC5).
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ObjectiveGate:
    """The unified Objective Gate as a registered :class:`Guardrail` (AC1/AC5).

    Blocking guardrail.  ``evaluate(**inputs)`` forwards the superset of inputs to
    :func:`evaluate_objective` and maps the :class:`ObjectiveVerdict` onto a
    :class:`~agentrail.guardrails.base.Verdict`:

    * ``pass``    → ``PASS``      (the single done/merge signal);
    * ``pending`` → ``ADVISORY``  (a hold, not a hard block — surfaced, never a
      false ``FAIL`` that would look like a real failure);
    * ``fail``    → ``FAIL``      (a hard block).
    """

    name: str = "objective_gate"
    description: str = (
        "The single objective definition of done/merge: objective checks "
        "(tests/build/lint) + acceptance-criteria coverage + Red-Green and "
        "Independent-Verification seams (sync harness), and CI checks (with a "
        "pending hold) + committed-secret scan + deleted-file-still-referenced "
        "(async harness). No LLM opinion participates."
    )
    blocking: bool = True

    def evaluate(self, **kwargs: object) -> Verdict:
        verdict = evaluate_objective(
            checks=kwargs.get("checks"),  # type: ignore[arg-type]
            ac_coverage=kwargs.get("ac_coverage"),  # type: ignore[arg-type]
            red_green_evidence=kwargs.get("red_green_evidence"),  # type: ignore[arg-type]
            verification_evidence=kwargs.get("verification_evidence"),  # type: ignore[arg-type]
            ci_checks=kwargs.get("ci_checks"),  # type: ignore[arg-type]
            added_lines=kwargs.get("added_lines"),  # type: ignore[arg-type]
            deleted_files=kwargs.get("deleted_files"),  # type: ignore[arg-type]
            references=kwargs.get("references"),  # type: ignore[arg-type]
        )
        if verdict.state == "pass":
            return Verdict.passing()
        if verdict.state == "pending":
            return Verdict.advise(*verdict.failed_reasons)
        return Verdict.failing(*verdict.failed_reasons)


# Register the singleton instance at import time so `list_guardrails()` sees it.
OBJECTIVE_GATE = register(ObjectiveGate())
