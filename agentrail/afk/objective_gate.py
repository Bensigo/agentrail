"""Deterministic objective gate (ADR 0007): CI checks + security checks.

This module is pure — it takes already-fetched CI-check data and diff data and
returns a verdict. The runner performs the IO (gh.pr_checks, git diff) and the
CI polling. No LLM opinion participates; merge is gated only by these signals.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Dict, List, Optional


@dataclass(frozen=True)
class ObjectiveGateResult:
    state: str               # "pass" | "fail" | "pending"
    reasons: List[str]

    @property
    def passed(self) -> bool:
        return self.state == "pass"


# High-confidence secret patterns. Conservative on purpose — a false positive
# blocks a merge, so we only match shapes that are almost never legitimate in a
# diff's added lines.
_SECRET_PATTERNS = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),                       # AWS access key id
    re.compile(r"(?i)\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*['\"][^'\"]{12,}['\"]"),
]


def evaluate_ci(checks: List[dict]) -> Optional[ObjectiveGateResult]:
    """Evaluate CI checks. Returns a fail/pending result, or None when all pass.

    Zero checks is a FAIL — merging with no objective signal violates ADR 0007.
    """
    if not checks:
        return ObjectiveGateResult("fail", ["no CI checks configured on the PR"])
    failed = [c["name"] for c in checks if c.get("state") == "fail"]
    if failed:
        return ObjectiveGateResult("fail", [f"CI check '{n}' failed" for n in failed])
    pending = [c["name"] for c in checks if c.get("state") == "pending"]
    if pending:
        return ObjectiveGateResult("pending", [f"CI check '{n}' still running" for n in pending])
    return None


def scan_secrets(added_lines: List[str]) -> List[str]:
    """Return one reason per added line that looks like a committed secret."""
    reasons: List[str] = []
    for line in added_lines:
        for pat in _SECRET_PATTERNS:
            if pat.search(line):
                reasons.append(f"possible secret/key in added line: {line.strip()[:80]}")
                break
    return reasons


def deleted_files_in_use(deleted_files: List[str], references: Dict[str, List[str]]) -> List[str]:
    """Return one reason per deleted file still referenced elsewhere.

    ``references`` maps each deleted path to the list of files that still
    reference it (computed by the runner via grep).
    """
    reasons: List[str] = []
    for path in deleted_files:
        refs = references.get(path) or []
        if refs:
            reasons.append(
                f"deleted file '{path}' is still referenced by {', '.join(refs[:3])}"
            )
    return reasons


def evaluate(
    checks: List[dict],
    added_lines: List[str],
    deleted_files: List[str],
    references: Dict[str, List[str]],
) -> ObjectiveGateResult:
    """Top-level gate: CI first (may be pending), then deterministic security."""
    ci = evaluate_ci(checks)
    if ci is not None:
        return ci
    reasons = scan_secrets(added_lines) + deleted_files_in_use(deleted_files, references)
    if reasons:
        return ObjectiveGateResult("fail", reasons)
    return ObjectiveGateResult("pass", [])


def fix_prompt(pr: int, reasons: List[str]) -> str:
    """Instruction handed to the agent to fix OBJECTIVE failures (not findings)."""
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
