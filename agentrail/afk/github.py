"""
Thin adapter over the ``gh`` CLI. This is the *only* place that talks to
GitHub. Everything here is a side effect driven by state — never a source of
truth for a decision. Functions are deliberately small and synchronous; the
runner calls them off the event loop via ``asyncio.to_thread`` where needed.
"""
from __future__ import annotations

import json
import subprocess
from typing import List, Optional, Tuple


def _run(args: List[str], check: bool = False) -> Tuple[int, str, str]:
    proc = subprocess.run(
        ["gh", *args], capture_output=True, text=True, check=False
    )
    if check and proc.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc.returncode, proc.stdout, proc.stderr


def list_queue_issues(afk_label: str, queue_labels: List[str]) -> List[dict]:
    """
    Issues approved for AFK and ready, oldest first, that do NOT already have an
    open PR. Returns dicts with number/title/url. Original (non review-fix)
    issues are prioritized over review-fix follow-ups.
    """
    seen: dict = {}
    ordered: List[dict] = []
    for label in queue_labels:
        rc, out, _ = _run([
            "issue", "list", "--state", "open",
            "--label", afk_label, "--label", label,
            "--search", "sort:created-asc -label:afk-in-progress",
            "--limit", "100", "--json", "number,title,url",
        ])
        if rc != 0 or not out.strip():
            continue
        for item in json.loads(out):
            n = item["number"]
            if n in seen:
                continue
            seen[n] = True
            ordered.append(item)
    return ordered


def detect_pr_for_issue(issue: int) -> Optional[int]:
    rc, out, _ = _run([
        "pr", "list", "--state", "open", "--limit", "100",
        "--json", "number,title,body,createdAt",
    ])
    if rc != 0 or not out.strip():
        return None
    matches = []
    needle = f"#{issue}"
    for pr in json.loads(out):
        body = pr.get("body") or ""
        title = pr.get("title") or ""
        if needle in body or needle in title:
            matches.append(pr)
    if not matches:
        return None
    matches.sort(key=lambda p: p.get("createdAt", ""))
    return matches[-1]["number"]


def ensure_label(name: str, color: str, description: str) -> None:
    rc, out, _ = _run(["label", "list", "--limit", "200", "--json", "name"])
    if rc == 0 and out.strip():
        existing = {x["name"] for x in json.loads(out)}
        if name in existing:
            return
    _run(["label", "create", name, "--color", color, "--description", description, "--force"])


def add_issue_label(issue: int, label: str) -> None:
    _run(["issue", "edit", str(issue), "--add-label", label])


def remove_issue_label(issue: int, label: str) -> None:
    _run(["issue", "edit", str(issue), "--remove-label", label])


def add_pr_label(pr: int, label: str) -> None:
    _run(["pr", "edit", str(pr), "--add-label", label])


def comment_on_pr(pr: int, body: str) -> None:
    _run(["pr", "comment", str(pr), "--body", body])


def pr_head_ref(pr: int) -> Optional[str]:
    rc, out, _ = _run(["pr", "view", str(pr), "--json", "headRefName"])
    if rc != 0 or not out.strip():
        return None
    return json.loads(out).get("headRefName")


def pr_state(pr: int) -> Optional[str]:
    rc, out, _ = _run(["pr", "view", str(pr), "--json", "state"])
    if rc != 0 or not out.strip():
        return None
    return json.loads(out).get("state")


def merge_pr_squash(pr: int, subject: str) -> Tuple[bool, str]:
    rc, _, err = _run([
        "pr", "merge", str(pr), "--squash", "--subject", subject,
        "--body", "Merged via AFK automated review.",
    ])
    if rc == 0:
        return True, ""
    # branch protection may require checks — fall back to auto-merge
    rc2, _, err2 = _run([
        "pr", "merge", str(pr), "--auto", "--squash", "--subject", subject,
        "--body", "Merged via AFK automated review (auto).",
    ])
    if rc2 == 0:
        return True, "auto"
    return False, (err2 or err).strip()
