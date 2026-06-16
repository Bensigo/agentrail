"""Tests for the self-hosted runner's HTTP client (agentrail/runner/client.py).

In the runner model the CLI never touches a database. It is a thin worker that
*claims* the next dispatched issue from the hosted backend over HTTP, runs it
locally, and *reports* the result back. This client is that seam.

Like ``QueueStore``'s injectable ``Executor``, the client takes an injectable
``transport`` (a callable that performs one HTTP request) so these tests are
hermetic — no real network, no real server.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from agentrail.runner.client import Response, RunnerClient, WorkItem


class FakeTransport:
    """Records requests and replays a scripted queue of responses."""

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
        self.calls.append(
            {"method": method, "url": url, "headers": headers, "body": body}
        )
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


# --- claim_next: the tracer bullet -------------------------------------------


def test_claim_next_returns_workitem_from_authenticated_get():
    transport = FakeTransport(
        [
            Response(
                status=200,
                body=(
                    b'{"id":"wi-1","workspace_id":"ws1","source":"github",'
                    b'"external_id":"42","repo_url":"https://github.com/o/r",'
                    b'"ref":"main","title":"Fix it","body":"## AC\\n- [ ] works"}'
                ),
            )
        ]
    )
    item = _client(transport).claim_next()

    assert isinstance(item, WorkItem)
    assert item.id == "wi-1"
    assert item.external_id == "42"
    assert item.repo_url == "https://github.com/o/r"
    assert item.ref == "main"

    # One authenticated GET to the runner claim endpoint (no double slash).
    call = transport.calls[0]
    assert call["method"] == "GET"
    assert call["url"] == (
        "https://app.agentrail.dev/api/v1/runner/claim?workspace_id=ws1"
    )
    assert call["headers"]["Authorization"] == "Bearer rt_secret"


def test_claim_next_returns_none_when_nothing_grabbable():
    # 204 No Content with an empty body means "no work right now".
    transport = FakeTransport([Response(status=204, body=b"")])
    assert _client(transport).claim_next() is None


# --- report_result: the reporting half of the protocol -----------------------


def _work_item() -> WorkItem:
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


def test_report_result_posts_outcome_back_with_auth():
    transport = FakeTransport([Response(status=202, body=b"")])
    ok = _client(transport).report_result(
        _work_item(),
        status="green",
        cost_usd=1.25,
        branch="afk/github-42",
        gate_reason="all checks pass",
        logs_tail="...done",
    )
    assert ok is True

    call = transport.calls[0]
    assert call["method"] == "POST"
    assert call["url"] == "https://app.agentrail.dev/api/v1/runner/result"
    assert call["headers"]["Authorization"] == "Bearer rt_secret"
    sent = __import__("json").loads(call["body"].decode())
    assert sent["id"] == "wi-1"
    assert sent["workspace_id"] == "ws1"
    assert sent["status"] == "green"
    assert sent["cost_usd"] == 1.25
    assert sent["branch"] == "afk/github-42"
    assert sent["gate_reason"] == "all checks pass"


def test_report_result_false_on_non_2xx():
    transport = FakeTransport([Response(status=401, body=b'{"error":"bad token"}')])
    ok = _client(transport).report_result(_work_item(), status="green")
    assert ok is False
