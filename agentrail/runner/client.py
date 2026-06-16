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
import urllib.request
from dataclasses import dataclass
from typing import Callable, Dict, Optional


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

    @classmethod
    def from_dict(cls, d: Dict[str, object]) -> "WorkItem":
        return cls(
            id=str(d["id"]),
            workspace_id=str(d["workspace_id"]),
            source=str(d["source"]),
            external_id=str(d["external_id"]),
            repo_url=str(d["repo_url"]),
            ref=str(d.get("ref") or "main"),
            title=str(d.get("title") or ""),
            body=str(d.get("body") or ""),
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
        if resp.status == 204 or not resp.body:
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
                "status": status,
                "cost_usd": cost_usd,
                "branch": branch,
                "gate_reason": gate_reason,
                "logs_tail": logs_tail,
            }
        ).encode("utf-8")
        resp = self._transport("POST", url, headers=self._headers(), body=payload)
        return 200 <= resp.status < 300
