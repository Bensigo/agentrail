"""
Review policy.

Old behavior: every review finding became a new GitHub issue, which re-entered
the AFK queue and produced an unbounded review -> fix -> review cascade.

New behavior (single source of truth, no issue spawning):
  - P0 / P1 findings  -> auto-fix in place on the PR branch, then re-review once.
  - P2 / P3 findings  -> post one PR comment listing them; the engineer decides.
  - no findings       -> merge.

Round depth is bounded by ``max_review_rounds``; when exhausted the PR is
labeled ``human-review-needed`` instead of looping forever.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

_BEGIN = "BEGIN_REVIEW_FIX_ISSUES_JSON"
_END = "END_REVIEW_FIX_ISSUES_JSON"

AUTO_FIX_SEVERITIES = frozenset({"P0", "P1"})


@dataclass(frozen=True)
class Finding:
    title: str
    severity: str
    file: Optional[str]
    body: str


@dataclass(frozen=True)
class ReviewOutcome:
    blocking: List[Finding]      # P0/P1 — auto-fix these
    advisory: List[Finding]      # P2/P3 — comment, engineer decides
    memory_suggestions: List[dict]

    @property
    def has_blocking(self) -> bool:
        return bool(self.blocking)

    @property
    def has_advisory(self) -> bool:
        return bool(self.advisory)

    @property
    def is_clean(self) -> bool:
        return not self.blocking and not self.advisory


def extract_json_block(review_text: str) -> Optional[dict]:
    """Pull the machine-readable JSON object from between the markers."""
    start = review_text.find(_BEGIN)
    end = review_text.find(_END)
    if start == -1 or end == -1 or end < start:
        return None
    body = review_text[start + len(_BEGIN):end].strip()
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        # tolerate stray prose around the object: grab the outermost {...}
        match = re.search(r"\{.*\}", body, re.DOTALL)
        if not match:
            return None
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            return None


def _normalize_severity(raw: Optional[str]) -> str:
    if not raw:
        return "P2"
    s = raw.strip().upper()
    return s if s in {"P0", "P1", "P2", "P3"} else "P2"


def classify(review_file: Path) -> Optional[ReviewOutcome]:
    """Parse a review output file into a ReviewOutcome, or None if unparseable."""
    if not review_file.exists():
        return None
    data = extract_json_block(review_file.read_text())
    if data is None or not isinstance(data.get("fix_issues"), list):
        return None

    blocking: List[Finding] = []
    advisory: List[Finding] = []
    for item in data["fix_issues"]:
        sev = _normalize_severity(item.get("severity"))
        finding = Finding(
            title=item.get("title", "(untitled)"),
            severity=sev,
            file=item.get("file"),
            body=item.get("body", ""),
        )
        if sev in AUTO_FIX_SEVERITIES:
            blocking.append(finding)
        else:
            advisory.append(finding)

    mem = data.get("memory_suggestions")
    mem = mem if isinstance(mem, list) else []
    return ReviewOutcome(blocking=blocking, advisory=advisory, memory_suggestions=mem)


def advisory_comment(pr: int, outcome: ReviewOutcome) -> str:
    """Render the PR comment posted for P2/P3 findings (engineer decides)."""
    lines = [
        "## AFK automated review — advisory findings",
        "",
        "These are **P2/P3** findings. They do not block merge automatically; "
        "decide whether to address them.",
        "",
    ]
    for f in outcome.advisory:
        loc = f" (`{f.file}`)" if f.file else ""
        lines.append(f"- **[{f.severity}] {f.title}**{loc}")
        if f.body:
            lines.append(f"  - {f.body}")
    if outcome.memory_suggestions:
        lines.append("")
        lines.append("### Suggested memory updates")
        for m in outcome.memory_suggestions:
            lines.append(f"- {m.get('title', '(untitled)')} → `{m.get('target_file', '')}`")
    return "\n".join(lines)


def autofix_prompt(pr: int, outcome: ReviewOutcome) -> str:
    """Instruction handed to the agent to patch P0/P1 findings in place."""
    lines = [
        f"Fix the following blocking review findings on the current PR branch "
        f"(PR #{pr}). These are P0/P1 — they must be fixed before merge.",
        "",
        "Make the minimal, correct change for each. Do not refactor unrelated code. "
        "Commit your changes with a clear message. Do not open a new PR or issue.",
        "",
    ]
    for i, f in enumerate(outcome.blocking, 1):
        loc = f" (file: {f.file})" if f.file else ""
        lines.append(f"{i}. [{f.severity}] {f.title}{loc}")
        if f.body:
            lines.append(f"   {f.body}")
    return "\n".join(lines)
