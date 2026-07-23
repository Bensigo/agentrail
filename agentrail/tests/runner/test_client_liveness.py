"""Tests for RunnerClient.report_liveness (#1388).

The execution-liveness ping is the runner-side half of the stale-run reclaim: a
plain runner-authed POST to /api/v1/runner/liveness carrying just the claim id +
workspace. Same injectable-transport seam as the rest of the client, so these
are hermetic — no real network.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from agentrail.runner.client import Response, RunnerClient, WorkItem


class FakeTransport:
    def __init__(self, responses: Optional[List[Response]] = None) -> None:
        self.responses: List[Response] = list(responses or [])
        self.calls: List[Dict[str, Any]] = []

    def __call__(
        self,
        method: str,
        url: str,
        *,
        headers: Dict[str, str],
        body: Optional[bytes] = None,
    ) -> Response:
        self.calls.append({"method": method, "url": url, "headers": headers, "body": body})
        if not self.responses:  # pragma: no cover - defensive
            raise AssertionError("no scripted response left")
        return self.responses.pop(0)


def _client(transport: FakeTransport) -> RunnerClient:
    return RunnerClient(
        base_url="https://app.agentrail.dev/",
        token="rt_secret",
        workspace_id="ws1",
        transport=transport,
    )


def _item() -> WorkItem:
    return WorkItem(
        id="wi-1",
        workspace_id="ws1",
        source="github",
        external_id="42",
        repo_url="https://github.com/o/r",
        ref="main",
        title="t",
        body="b",
    )


def test_report_liveness_posts_authed_to_the_liveness_route():
    transport = FakeTransport([Response(status=202, body=b'{"ok":true}')])
    ok = _client(transport).report_liveness(_item())
    assert ok is True
    call = transport.calls[0]
    assert call["method"] == "POST"
    assert call["url"] == "https://app.agentrail.dev/api/v1/runner/liveness"
    # Same Bearer auth as claim/result.
    assert call["headers"]["Authorization"] == "Bearer rt_secret"
    # Minimal signal payload: just the claim id + workspace, nothing else.
    import json

    payload = json.loads(call["body"].decode("utf-8"))
    assert payload == {"id": "wi-1", "workspace_id": "ws1"}


def test_report_liveness_returns_false_on_non_2xx():
    transport = FakeTransport([Response(status=404, body=b'{"error":"gone"}')])
    assert _client(transport).report_liveness(_item()) is False
