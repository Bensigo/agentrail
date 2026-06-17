"""GitHub connector — the single, consolidated GitHub adapter (M038, AC2).

This module is the **only** place that talks to GitHub (consolidating the former
``agentrail/afk/github.py``; that path now re-exports from here, so existing AFK
callers keep working and there is no second GitHub client —
verification-contract-architecture.md).

Two layers live here:

1. **The ``gh`` CLI primitives** — small, synchronous side effects driven by
   state (listing issues by label, fetching a body, posting comments, label and
   PR management). These are the functions AFK already depends on.
2. **The :class:`GitHubConnector` adapter** — implements the shared
   :class:`~agentrail.connectors.base.Connector` interface. ``ingest`` lists the
   labeled issues and feeds each through the **input-contract gate**
   (``afk/input_contract.admit_to_queue``) so only issues with machine-checkable
   acceptance criteria enter the **Issue Queue**; ``post_result`` posts the run's
   terminal outcome back on the issue; ``notify`` is a safe no-op (GitHub's
   channel is the issue comment itself; Discord owns channel notifications).
"""
from __future__ import annotations

import json
import re
import subprocess
import urllib.request
from typing import Callable, Iterable, List, Optional, Set, Tuple

from agentrail.afk.input_contract import Rejected, admit_to_queue
from agentrail.connectors.base import (
    Connector,
    ConnectorEvent,
    IngestedIssue,
    IssueRef,
    OutcomeReport,
)

# The trigger label a human applies (or the CLI applies on create) to a GitHub
# issue so the OAuth polling intake brings it into the queue.
TRIGGER_LABEL = "ready-for-agent"
GITHUB_API = "https://api.github.com"


# --------------------------------------------------------------------------- #
# gh CLI primitives (consolidated from agentrail/afk/github.py)
# --------------------------------------------------------------------------- #
def _run(args: List[str], check: bool = False) -> Tuple[int, str, str]:
    proc = subprocess.run(
        ["gh", *args], capture_output=True, text=True, check=False
    )
    if check and proc.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc.returncode, proc.stdout, proc.stderr


_BLOCKED_BY_SECTION = re.compile(
    r"(?im)^\#{1,6}\s*blocked\s*by\s*\n(.*?)(?=^\#{1,6}\s|\Z)", re.S
)


def parse_blocked_by(body: Optional[str]) -> List[int]:
    """Extract blocker issue numbers from an issue body's ``## Blocked by`` section.

    Only ``#<n>`` references inside that section count — prose like "None — can
    start immediately." yields ``[]``. Order-preserving, de-duplicated. A body
    with no Blocked-by section (or no ``#n`` in it) is unblocked.
    """
    if not body:
        return []
    m = _BLOCKED_BY_SECTION.search(body)
    if not m:
        return []
    nums: List[int] = []
    seen: Set[int] = set()
    for tok in re.findall(r"#(\d+)", m.group(1)):
        n = int(tok)
        if n not in seen:
            seen.add(n)
            nums.append(n)
    return nums


def open_issue_numbers(candidates: Iterable[int]) -> Set[int]:
    """Return the subset of *candidates* that are still OPEN issues.

    One ``gh`` call lists all open issues; we intersect. Fails open (empty set)
    on error so a transient GitHub blip does not wedge the queue.
    """
    wanted = {int(n) for n in candidates}
    if not wanted:
        return set()
    rc, out, _ = _run([
        "issue", "list", "--state", "open", "--limit", "500", "--json", "number",
    ])
    if rc != 0 or not out.strip():
        return set()
    try:
        open_nums = {int(it["number"]) for it in json.loads(out)}
    except (ValueError, KeyError, TypeError):
        return set()
    return wanted & open_nums


def list_queue_issues(afk_label: str, queue_labels: List[str]) -> List[dict]:
    """
    Issues approved for AFK and ready, oldest first, that do NOT already have an
    open PR. Returns dicts with number/title/url/blocked_by. Original (non
    review-fix) issues are prioritized over review-fix follow-ups.
    """
    seen: dict = {}
    ordered: List[dict] = []
    for label in queue_labels:
        rc, out, _ = _run([
            "issue", "list", "--state", "open",
            "--label", afk_label, "--label", label,
            "--search", "sort:created-asc -label:afk-in-progress",
            "--limit", "100", "--json", "number,title,url,body",
        ])
        if rc != 0 or not out.strip():
            continue
        for item in json.loads(out):
            n = item["number"]
            if n in seen:
                continue
            seen[n] = True
            ordered.append({
                "number": n,
                "title": item.get("title", ""),
                "url": item.get("url", ""),
                "body": item.get("body", ""),
                "blocked_by": parse_blocked_by(item.get("body", "")),
            })
    return ordered


def issue_body(issue: int) -> Optional[str]:
    """Fetch a single issue's body (used by ingest to run the input-contract gate)."""
    rc, out, _ = _run(["issue", "view", str(issue), "--json", "body"])
    if rc != 0 or not out.strip():
        return None
    try:
        return json.loads(out).get("body")
    except (ValueError, KeyError, TypeError):
        return None


def comment_on_issue(issue: int, body: str) -> None:
    """Post a comment on an issue — the *back* channel for ``post_result``."""
    _run(["issue", "comment", str(issue), "--body", body])


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


def pr_checks(pr: int) -> List[dict]:
    """Return the PR's CI checks as ``[{"name": str, "state": str}]``.

    ``state`` is normalized to one of: "pass", "fail", "pending". An empty
    list means GitHub reports no checks for the PR.
    """
    rc, stdout, _ = _run(["pr", "checks", str(pr), "--json", "name,state,bucket"])
    # `gh pr checks` exits non-zero both when checks are failing and when
    # there are none; rely on the JSON output, treating empty output as "no
    # checks".
    if not stdout.strip():
        return []
    try:
        raw = json.loads(stdout)
    except json.JSONDecodeError:
        return []
    out: List[dict] = []
    for c in raw:
        out.append({"name": str(c.get("name", "")), "state": _norm_check(c)})
    return out


def _norm_check(c: dict) -> str:
    # gh's `bucket` is the most reliable rollup: pass|fail|pending|skipping|cancel
    bucket = str(c.get("bucket") or "").lower()
    if bucket in {"pass", "skipping"}:
        return "pass"
    if bucket in {"fail", "cancel"}:
        return "fail"
    if bucket == "pending":
        return "pending"
    state = str(c.get("state") or "").lower()
    if state in {"success", "neutral", "skipped"}:
        return "pass"
    if state in {"failure", "error", "timed_out", "cancelled", "action_required"}:
        return "fail"
    return "pending"


# --------------------------------------------------------------------------- #
# The GitHub adapter (implements the shared Connector interface)
# --------------------------------------------------------------------------- #
class GitHubConnector(Connector):
    """GitHub adapter for the two-way connector contract (AC2).

    Thin orchestration: it reuses the ``gh`` primitives above for I/O and the
    pure ``afk/input_contract`` gate for admission. It owns no decision logic of
    its own — listing and posting are side effects; admission is the gate's call.
    """

    def __init__(
        self,
        *,
        afk_label: str = "afk",
        queue_labels: Optional[List[str]] = None,
    ) -> None:
        self.afk_label = afk_label
        # Default to the same ready label the AFK CLI uses to fill the queue.
        self.queue_labels = queue_labels or ["ready-for-agent"]

    def ingest(self) -> List[IngestedIssue]:
        """List labeled issues and hand each through the input-contract gate.

        Reuses ``list_queue_issues`` (label/PR filtering, oldest-first) for the
        listing, then runs every issue body through
        ``input_contract.admit_to_queue`` — the single seam that mints a
        ``QueueEntry`` only when the issue carries machine-checkable acceptance
        criteria. Issues without AC come back ``admitted=False`` with the reason,
        so the caller can audit why they were kept out.
        """
        results: List[IngestedIssue] = []
        for item in list_queue_issues(self.afk_label, self.queue_labels):
            number = item["number"]
            # list_queue_issues already returns the body; fall back to a fetch
            # only if it was omitted, so ingest works against either shape.
            body = item.get("body")
            if body is None:
                body = issue_body(number) or ""
            blocked_by = frozenset(item.get("blocked_by") or [])
            admission = admit_to_queue(
                number=number, issue_body=body, blocked_by=blocked_by
            )
            if isinstance(admission, Rejected):
                results.append(
                    IngestedIssue(
                        number=number,
                        title=item.get("title", ""),
                        admitted=False,
                        reason=admission.missing_ac,
                        url=item.get("url", ""),
                    )
                )
            else:
                results.append(
                    IngestedIssue(
                        number=number,
                        title=item.get("title", ""),
                        admitted=True,
                        entry=admission,
                        url=item.get("url", ""),
                    )
                )
        return results

    def post_result(self, issue_ref: int, outcome: OutcomeReport) -> None:
        """Post the run's terminal outcome back as a comment on the issue."""
        comment_on_issue(issue_ref, outcome.to_comment())

    def notify(self, event: ConnectorEvent) -> None:
        """No-op for GitHub: the back channel is the issue comment itself.

        Channel notifications (Slack/Discord) are a separate adapter's job; GitHub
        surfaces the result via ``post_result``. Kept as an explicit no-op so the
        interface contract holds without a misleading second comment.
        """
        return None


# --------------------------------------------------------------------------- #
# OAuth REST client (MVP): poll labeled issues + post/create via the user's token
# --------------------------------------------------------------------------- #
# A REST transport runs one HTTP request and returns ``(status, parsed_json)``.
# ``body`` is the raw request body (already-serialized JSON) or ``None``.
RestTransport = Callable[..., Tuple[int, object]]


def _default_rest_transport(token: str) -> RestTransport:
    """Build the live transport: GitHub REST over stdlib urllib with the OAuth token.

    No ``gh`` CLI (which needs its own auth) and no third-party HTTP client —
    matches the no-new-deps constraint and mirrors the Linear adapter's reliance
    on stdlib :mod:`urllib`. Authorization is the user's stored GitHub OAuth
    ``access_token`` as a Bearer token.
    """

    def _transport(method, url, headers=None, body=None):
        data = body.encode("utf-8") if isinstance(body, str) else body
        req = urllib.request.Request(url, data=data, method=method)
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        with urllib.request.urlopen(req) as resp:  # noqa: S310 (fixed github.com host)
            raw = resp.read().decode("utf-8")
            parsed = json.loads(raw) if raw else None
            return resp.status, parsed

    return _transport


class GitHubOAuthClient:
    """Poll-and-post GitHub intake driven by the user's OAuth token (MVP).

    The connected-source path the MVP asks for: a labeled GitHub issue flows into
    the queue and run results post back — authenticated with the user's stored
    GitHub OAuth ``access_token`` (no PAT, no ``gh`` CLI). Three side effects, all
    over the injectable ``transport`` so tests run against a mocked REST API:

    - :meth:`poll` lists OPEN issues carrying the trigger label across the
      workspace's linked repos, as :class:`~agentrail.connectors.base.IssueRef`.
    - :meth:`post_result` posts the run outcome back as an issue comment.
    - :meth:`create_issue` opens an issue WITH the trigger label so the polling
      intake (or heartbeat) then picks it up.

    The pure ``afk/input_contract`` gate is *not* re-implemented here; the caller
    (heartbeat/orchestrator) feeds each polled ``IssueRef.body`` through
    ``admit_to_queue`` exactly as :class:`GitHubConnector.ingest` does, so an
    issue without machine-checkable AC still never enters the queue.
    """

    def __init__(
        self,
        *,
        token: str,
        repos: Optional[List[str]] = None,
        trigger_label: str = TRIGGER_LABEL,
        transport: Optional[RestTransport] = None,
    ) -> None:
        self.token = token
        # Linked repos as "owner/name"; the workspace's repositories table feeds
        # this in production (repositories.name), tests pass an explicit list.
        self.repos = list(repos or [])
        self.trigger_label = trigger_label
        self._transport: RestTransport = transport or _default_rest_transport(token)

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
        }

    def poll(self, workspace_id: str) -> List[IssueRef]:
        """List OPEN, trigger-labeled issues across the linked repos as IssueRefs.

        One REST call per linked repo to ``GET /repos/{repo}/issues`` filtered to
        ``state=open`` and the trigger label. GitHub's issues endpoint also returns
        pull requests (they carry a ``pull_request`` key); those are skipped so
        only genuine issues enter the queue. ``workspace_id`` scopes which token /
        repos the caller resolved; it is carried for symmetry with the other
        connectors' workspace-scoped surface.
        """
        refs: List[IssueRef] = []
        for repo in self.repos:
            url = (
                f"{GITHUB_API}/repos/{repo}/issues"
                f"?state=open&labels={self.trigger_label}&per_page=100"
            )
            status, payload = self._transport("GET", url, headers=self._headers())
            if status >= 300 or not isinstance(payload, list):
                continue
            for item in payload:
                if not isinstance(item, dict) or "pull_request" in item:
                    continue
                refs.append(
                    IssueRef(
                        repo=repo,
                        number=int(item.get("number", 0)),
                        title=item.get("title") or "",
                        body=item.get("body") or "",
                        url=item.get("html_url") or "",
                    )
                )
        return refs

    def post_result(self, issue_ref: IssueRef, result: OutcomeReport) -> None:
        """Post the run's terminal outcome back as a comment on the source issue.

        Addresses the issue by ``repo`` + ``number`` (the IssueRef ``poll``
        returned) — the *back* half of the two-way contract, over the OAuth token.
        """
        url = f"{GITHUB_API}/repos/{issue_ref.repo}/issues/{issue_ref.number}/comments"
        body = json.dumps({"body": result.to_comment()})
        self._transport("POST", url, headers=self._headers(), body=body)

    def create_issue(self, *, repo: str, title: str, body: str) -> IssueRef:
        """Create a GitHub issue WITH the trigger label and return its IssueRef.

        Opening the issue already labeled is what lets the polling intake (or the
        heartbeat) pick it up on the next cycle — closing the loop the CLI starts.
        """
        url = f"{GITHUB_API}/repos/{repo}/issues"
        payload = json.dumps(
            {"title": title, "body": body, "labels": [self.trigger_label]}
        )
        _status, created = self._transport(
            "POST", url, headers=self._headers(), body=payload
        )
        created = created if isinstance(created, dict) else {}
        return IssueRef(
            repo=repo,
            number=int(created.get("number", 0)),
            title=created.get("title") or title,
            body=body,
            url=created.get("html_url") or "",
        )
