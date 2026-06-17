"""
Review policy (ADR 0007).

LLM code review is advisory only. Every finding is a suggestion a human can
convert into an issue on the dashboard — nothing here gates the merge. Merge is
decided by the objective gate (agentrail/afk/objective_gate.py).
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

_BEGIN = "BEGIN_REVIEW_FIX_ISSUES_JSON"
_END = "END_REVIEW_FIX_ISSUES_JSON"


@dataclass(frozen=True)
class Finding:
    title: str
    severity: str
    file: Optional[str]
    body: str


@dataclass(frozen=True)
class ReviewOutcome:
    findings: List[Finding]      # all advisory — never blocking
    memory_suggestions: List[dict]

    @property
    def has_findings(self) -> bool:
        return bool(self.findings)

    @property
    def is_clean(self) -> bool:
        return not self.findings


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

    findings: List[Finding] = []
    for item in data["fix_issues"]:
        sev = _normalize_severity(item.get("severity"))
        findings.append(Finding(
            title=item.get("title", "(untitled)"),
            severity=sev,
            file=item.get("file"),
            body=item.get("body", ""),
        ))

    mem = data.get("memory_suggestions")
    mem = mem if isinstance(mem, list) else []
    return ReviewOutcome(findings=findings, memory_suggestions=mem)


def findings_comment(pr: int, outcome: ReviewOutcome) -> str:
    """Render the informational PR comment listing advisory findings.

    Advisory only — it never blocks merge. Findings are also surfaced on the
    dashboard Review Gates page, where a human can convert any of them into an
    issue.
    """
    lines = [
        "## AgentRail review — advisory findings",
        "",
        "These findings do not block merge. Review them and, if useful, convert "
        "any into an issue from the Review Gates page on the dashboard.",
        "",
    ]
    for f in outcome.findings:
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
