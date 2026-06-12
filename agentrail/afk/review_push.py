"""Push per-review-round gate results to the AgentRail telemetry pipeline.

NON-FATAL: every failure is swallowed; the afk run is never affected.
"""
from __future__ import annotations

import json
import re
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List

from agentrail.afk.review import extract_json_block
from agentrail.context.snapshot_push import load_link

# Reviewer priorities → dashboard severities (anything else → minor).
_SEVERITY_MAP = {"P0": "critical", "P1": "critical", "P2": "major"}

# Prose that signals the reviewer found something blocking (fallback path).
_BLOCKING_RE = re.compile(
    r"\bP[01]\b|\bblocking\b|must[\s-]+fix|\bcritical\b|\bbug\b", re.IGNORECASE
)
# Prose that signals a clean pass — checked before the blocking heuristics so
# "no blocking issues found" does not become a finding.
_CLEAN_RE = re.compile(
    r"no\s+(blocking\s+)?(issues?|findings?|problems?)|lgtm|looks\s+good", re.IGNORECASE
)

_FALLBACK_SNIPPET_LIMIT = 1000


def parse_findings(review_text: str) -> List[dict]:
    """Parse reviewer findings out of raw review output text.

    Primary path: the machine-readable BEGIN/END_REVIEW_FIX_ISSUES_JSON block
    (``fix_issues``). Fallback: if there is no parseable block but the prose
    clearly describes blocking problems, emit a single finding carrying the
    raw text. An empty or clean review yields no findings.
    """
    text = (review_text or "").strip()
    if not text:
        return []

    data = extract_json_block(text)
    if data is not None and isinstance(data.get("fix_issues"), list):
        findings: List[dict] = []
        for item in data["fix_issues"]:
            if not isinstance(item, dict):
                continue
            sev_raw = str(item.get("severity") or "").strip().upper()
            severity = _SEVERITY_MAP.get(sev_raw, "minor")
            title = str(item.get("title") or "").strip()
            body = str(item.get("body") or "").strip()
            file_ = item.get("file")
            description = title or body or "(untitled finding)"
            if file_:
                description = f"{description} ({file_})"
            findings.append({
                "severity": severity,
                "description": description,
                "suggested_fix": body or title or "See full review output.",
            })
        return findings

    # Fallback: no machine-readable block — be liberal.
    if _CLEAN_RE.search(text) and not re.search(r"\bP[01]\b", text):
        return []
    if _BLOCKING_RE.search(text):
        snippet = text
        if len(snippet) > _FALLBACK_SNIPPET_LIMIT:
            snippet = snippet[:_FALLBACK_SNIPPET_LIMIT] + "…"
        return [{
            "severity": "critical",
            "description": snippet,
            "suggested_fix": "Address the blocking issues described in the review output.",
        }]
    return []


def extract_memory_suggestions(outcome) -> list:
    """Extract memory-worthy suggestions from a ReviewOutcome.

    Returns a list of dicts with 'content' and 'tags' keys, filtered to items
    where 'body' is non-empty. Returns [] when none are present.
    """
    suggestions = getattr(outcome, "memory_suggestions", None)
    if not isinstance(suggestions, list):
        return []
    items = []
    for m in suggestions:
        if not isinstance(m, dict):
            continue
        body = str(m.get("body") or "").strip()
        if not body:
            continue
        tags: list = []
        kind = str(m.get("kind") or "").strip()
        if kind:
            tags.append(f"kind:{kind}")
        target = str(m.get("target_file") or "").strip()
        if target:
            tags.append(f"file:{target}")
        items.append({"content": body, "tags": tags})
    return items


def push_memory_items(
    target,  # Path
    run_id: str,
    outcome,  # ReviewOutcome — avoid circular import at module level
) -> bool:
    """POST memory suggestions extracted from a review outcome.

    Returns True only on HTTP 202; returns False (never raises) otherwise.
    Skips silently when no memory suggestions are present.
    """
    try:
        items = extract_memory_suggestions(outcome)
        if not items:
            return True  # nothing to push — not a failure
        link = load_link(target)
        if link is None:
            return False
        payload = {
            "run_id": run_id,
            "repository_id": link["repository_id"],
            "items": items,
        }
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{link['base_url']}/api/v1/ingest/memory-items",
            data=body,
            headers={
                "Authorization": f"Bearer {link['api_key']}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return int(resp.status) == 202
    except Exception:  # noqa: BLE001 — non-fatal by design
        return False


def push_review_gate(
    target: Path,
    run_id: str,
    round_no: int,
    outcome,  # ReviewOutcome — avoid circular import at module level
    review_text: str = "",
) -> bool:
    """POST a review-gate record for one completed review round.

    Returns True only on HTTP 202; returns False (never raises) otherwise.
    ``round_no`` should be the post-increment value so it matches
    'review round N completed' semantics.
    """
    try:
        link = load_link(target)
        if link is None:
            return False
        gate_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"review-gate:{run_id}:{round_no}"))
        payload = {
            "id": gate_id,
            "repository_id": link["repository_id"],
            "run_id": run_id,
            "gate_name": f"review-round-{round_no}",
            "status": "failed" if outcome.has_blocking else "passed",
            "blocking_reasons": [
                {
                    "title": f.title,
                    "severity": f.severity,
                    "file": f.file,
                    "body": f.body,
                }
                for f in outcome.blocking
            ],
            "findings": parse_findings(review_text),
            "evaluated_at": datetime.now(timezone.utc).isoformat(),
        }
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{link['base_url']}/api/v1/ingest/review-gates",
            data=body,
            headers={
                "Authorization": f"Bearer {link['api_key']}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return int(resp.status) == 202
    except Exception:  # noqa: BLE001 — non-fatal by design
        return False
