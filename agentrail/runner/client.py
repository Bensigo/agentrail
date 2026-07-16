"""The self-hosted runner's HTTP client — the CLI's only link to the backend.

In the runner model the CLI is a thin worker. It does **not** own a database,
receive webhooks, or hold queue state. Instead it:

  1. ``claim_next()`` — asks the (local-now, hosted-later) backend for the next
     dispatched issue, over HTTP, authenticated by the login token.
  2. runs that issue locally (host-native, on the user's own agent subscription).
  3. ``report_result()`` — POSTs the outcome back to the backend.

This is the same shape the cost/activity push already use (urllib + Bearer), and
like ``QueueStore``'s ``Executor`` it takes an injectable ``transport`` so the
network is a seam — hermetic in tests, real ``urllib`` in production.

Because the backend owns the queue + DB + webhooks, *changing where the runner
points* (localhost today, a deployed domain tomorrow) is just a different
``base_url``. Nothing else about the runner changes.
"""
from __future__ import annotations

import json
import re
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Dict, Optional

from agentrail.run.evidence import bound_evidence


def _utc_now_iso() -> str:  # pragma: no cover - trivial clock read
    return datetime.now(timezone.utc).isoformat()


class RunnerError(Exception):
    """The backend returned an unexpected status the runner can't act on."""


class RunnerAuthError(RunnerError):
    """The runner token was rejected (401/403) — the user must log in again."""


@dataclass(frozen=True)
class Response:
    """A minimal HTTP response: the status code and the raw body bytes."""

    status: int
    body: bytes


# A transport performs exactly one HTTP request and returns a Response. This is
# the injectable seam (default: urllib); tests pass a fake.
Transport = Callable[..., Response]


@dataclass(frozen=True)
class WorkItem:
    """A dispatched issue the runner must execute locally.

    Everything the host-native runner needs to run the spine against a repo:
    the durable claim ``id`` (used to report back), the issue identity, and the
    repo/ref to check out.
    """

    id: str
    workspace_id: str
    source: str
    external_id: str
    repo_url: str
    ref: str
    title: str
    body: str
    # The backend repositories row id, used to link this run's ingested cost /
    # telemetry back to the dashboard. "" when the backend didn't resolve one.
    repository_id: str = ""
    # What kind of work this is: "issue" (default — run the SDLC spine) or
    # "onboard" (index a freshly connected repo and seed workspace memory). The
    # backend stamps it on the queue entry (queue_entries.kind); the runner
    # dispatches on it. Defaults to "issue" so a payload from an older server
    # that omits it always runs the normal issue path.
    kind: str = "issue"
    # The escalation tier the backend assigned this (re-)attempt. 0 = run at the
    # config-default model; 1+ = escalate to a stronger model (see
    # agentrail.runner.escalation.model_for_tier). Defaults to 0 so a payload
    # that omits it (or sends garbage) always runs at the safe config default.
    tier: int = 0
    # Decrypted MCP connector keys for this workspace, {provider: api_key}
    # (linear/figma/context7). The runner exports each as
    # AGENTRAIL_MCP_<PROVIDER>_KEY so native_runner writes the agent's MCP config
    # into the clone. Empty when no MCP connector is connected.
    mcp_keys: Dict[str, str] = field(default_factory=dict)
    # The workspace's connected GitHub OAuth access_token (the console's
    # getGithubToken, attached by the claim route), so the runner can
    # authenticate git clone/push + `gh pr create` for THIS workspace without a
    # separately-configured PAT. "" when the workspace owner hasn't linked
    # GitHub — the runner then falls back to whatever GIT_TOKEN it already has
    # in its own environment (back-compat). NOTE: this OAuth token can expire;
    # there is no refresh here, an expired token just surfaces as a normal
    # git/gh auth failure. Never logged — see native_runner's redaction of
    # captured process output before it is reported back as telemetry.
    github_token: str = ""

    @property
    def issue_number(self) -> str:
        """The bare issue number for ``agentrail run issue``.

        ``external_id`` is the GitHub identity (e.g. ``owner/name#826`` from the
        webhook intake), but the run command takes a numeric issue number. Pull
        the trailing number; fall back to the raw id if there is none.
        """
        match = re.search(r"(\d+)\s*$", self.external_id)
        return match.group(1) if match else self.external_id

    @classmethod
    def from_dict(cls, d: Dict[str, object]) -> "WorkItem":
        # MCP keys arrive as {provider: key}; keep only string→string pairs so a
        # malformed payload can never crash the runner loop.
        raw_keys = d.get("mcp_keys")
        mcp_keys: Dict[str, str] = {}
        if isinstance(raw_keys, dict):
            for prov, key in raw_keys.items():
                if isinstance(prov, str) and isinstance(key, str) and key:
                    mcp_keys[prov] = key
        # Parse the escalation tier defensively: default to 0 when absent or
        # non-int (e.g. null / a string) so a malformed payload never crashes the
        # loop and never accidentally escalates to a costly model.
        raw_tier = d.get("tier")
        try:
            tier = int(raw_tier)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            tier = 0
        return cls(
            id=str(d["id"]),
            workspace_id=str(d["workspace_id"]),
            source=str(d["source"]),
            external_id=str(d["external_id"]),
            repo_url=str(d["repo_url"]),
            ref=str(d.get("ref") or "main"),
            title=str(d.get("title") or ""),
            body=str(d.get("body") or ""),
            repository_id=str(d.get("repository_id") or ""),
            kind=str(d.get("kind") or "issue"),
            tier=tier,
            mcp_keys=mcp_keys,
            github_token=str(d.get("github_token") or ""),
        )


def _urllib_transport(
    method: str,
    url: str,
    *,
    headers: Dict[str, str],
    body: Optional[bytes] = None,
) -> Response:  # pragma: no cover - exercised against a real server
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return Response(status=int(resp.status), body=resp.read())
    except urllib.error.HTTPError as exc:  # treat HTTP errors as responses
        return Response(status=int(exc.code), body=exc.read())


class RunnerClient:
    """Claims dispatched work and reports results over the runner HTTP protocol."""

    def __init__(
        self,
        *,
        base_url: str,
        token: str,
        workspace_id: str,
        transport: Optional[Transport] = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._token = token
        self._workspace_id = workspace_id
        self._transport = transport or _urllib_transport

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
        }

    def claim_next(self) -> Optional[WorkItem]:
        """Claim the next dispatched issue for this workspace, or ``None``.

        ``200`` → a WorkItem to run. ``204`` (or any empty body) → nothing
        grabbable right now.
        """
        url = f"{self._base}/api/v1/runner/claim?workspace_id={self._workspace_id}"
        resp = self._transport("GET", url, headers=self._headers())
        if resp.status == 204:
            return None
        if resp.status in (401, 403):
            raise RunnerAuthError(
                "runner token was rejected — run `agentrail login` again"
            )
        if not (200 <= resp.status < 300):
            raise RunnerError(
                f"claim failed: HTTP {resp.status} "
                f"{resp.body[:200].decode('utf-8', 'replace')}"
            )
        if not resp.body:
            return None
        return WorkItem.from_dict(json.loads(resp.body.decode("utf-8")))

    def report_result(
        self,
        item: WorkItem,
        *,
        status: str,
        cost_usd: float = 0.0,
        branch: str = "",
        gate_reason: str = "",
        logs_tail: str = "",
        pr_url: str = "",
    ) -> bool:
        """POST a run outcome back to the backend. ``True`` only on a 2xx.

        ``status`` is the Run-Outcome vocabulary the dispatcher already speaks
        (green / red / error); the backend normalizes it to the durable enum.
        """
        url = f"{self._base}/api/v1/runner/result"
        payload = json.dumps(
            {
                "id": item.id,
                "workspace_id": item.workspace_id,
                # queue_entries has no repository_id, so the result route can't
                # resolve one to persist logs_tail as a failure_event. Forward
                # the claim-time repo id (may be "") so the route can (#1146 AC2).
                "repository_id": item.repository_id,
                "status": status,
                "cost_usd": cost_usd,
                "branch": branch,
                "gate_reason": gate_reason,
                "logs_tail": logs_tail,
                "pr_url": pr_url,
            }
        ).encode("utf-8")
        resp = self._transport("POST", url, headers=self._headers(), body=payload)
        return 200 <= resp.status < 300

    def _post_json(self, url: str, payload: object) -> None:
        """POST a JSON body, ignoring the response (best-effort emitters)."""
        body = json.dumps(payload).encode("utf-8")
        self._transport("POST", url, headers=self._headers(), body=body)

    def report_telemetry(
        self,
        item: WorkItem,
        *,
        status: str,
        gate_reason: str = "",
        evidence: str = "",
        now: Optional[str] = None,
    ) -> None:
        """Emit the runner-owned post-run telemetry the dashboard reads.

        Without this, Telemetry Health shows ``review_gate`` / ``failure_event`` /
        ``outbox_flush`` as Missing (red) for every runner-driven run. We emit to
        the SAME stores the completeness checker queries:

          - ``review_gate`` + ``outbox_flush`` → ``/ingest/run-events``. The
            checker matches on ``event_type`` (which the ingest derives from
            ``action.type``), so the action types are ``review_gate_passed`` /
            ``review_gate_failed`` and ``outbox_flushed``.
          - ``failure_event`` → ``/ingest/failure-events`` (a different table),
            on red/error runs only. It requires a ``repository_id``; when the
            backend resolved none ("") we skip it rather than send a 404. The
            failing run's ``evidence`` (logs tail) rides along here, bounded and
            secret-scrubbed by ``bound_evidence`` before it leaves the host
            (#1146 AC1/AC5).

        Best-effort: callers wrap this so a telemetry failure never affects the
        run outcome. ``now`` is injectable for hermetic tests.
        """
        ts = now or _utc_now_iso()
        verdict = "review_gate_passed" if status == "green" else "review_gate_failed"
        run_events = [
            {
                "session_id": item.id,
                "seq": 0,
                "ts": ts,
                "kind": "review_gate",
                "action": {"type": verdict, "phase": "review_gate", "verdict": status},
                "digest": f"{item.id}:review_gate",
            },
            {
                "session_id": item.id,
                "seq": 1,
                "ts": ts,
                "kind": "outbox_flush",
                "action": {"type": "outbox_flushed", "phase": "outbox"},
                "digest": f"{item.id}:outbox_flush",
            },
        ]
        self._post_json(f"{self._base}/api/v1/ingest/run-events", run_events)

        if status in ("red", "error") and item.repository_id:
            failure = [
                {
                    "repository_id": item.repository_id,
                    "run_id": item.id,
                    "failure_type": "objective_gate" if status == "red" else "execution_error",
                    "message": gate_reason or f"run {status}",
                    "evidence": bound_evidence(evidence),
                    "phase": "verify" if status == "red" else "execute",
                    "occurred_at": ts,
                }
            ]
            self._post_json(f"{self._base}/api/v1/ingest/failure-events", failure)
