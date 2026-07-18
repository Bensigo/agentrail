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

import pytest

from agentrail.runner.client import (
    CLAIM_BLOCKED_WORKSPACE_BUDGET,
    Response,
    RunnerAuthError,
    RunnerClient,
    RunnerError,
    WorkItem,
)


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


# --- claim_next: blocked-claim visibility (#1269 PR2b item 4) ----------------
#
# The backend's claim route (console/db lane, #1269 PR2a) signals a
# workspace-budget-blocked claim with a plain 204 plus an
# X-Agentrail-Claim-Blocked response header — indistinguishable from an empty
# queue by status/body alone. claim_next() must keep returning None either way
# (the None-means-idle contract every existing caller relies on) while
# exposing the reason via the last_claim_blocked attribute.


def test_claim_next_returns_none_when_blocked_same_as_when_idle():
    """The None-means-idle contract is unbroken: a blocked claim and a truly
    empty queue are the SAME return value. Only the attribute differs."""
    transport = FakeTransport(
        [Response(status=204, body=b"", headers={"x-agentrail-claim-blocked": "workspace-budget"})]
    )
    assert _client(transport).claim_next() is None


def test_claim_next_sets_last_claim_blocked_when_header_present():
    transport = FakeTransport(
        [Response(status=204, body=b"", headers={"x-agentrail-claim-blocked": "workspace-budget"})]
    )
    client = _client(transport)
    client.claim_next()
    assert client.last_claim_blocked == "workspace-budget"


def test_claim_next_last_claim_blocked_defaults_to_none():
    client = _client(FakeTransport([]))
    assert client.last_claim_blocked is None


def test_claim_next_last_claim_blocked_none_on_plain_204():
    # Regression-pin: a 204 with no blocked header behaves exactly as before
    # this feature — nothing grabbable, no blocked signal.
    transport = FakeTransport([Response(status=204, body=b"")])
    client = _client(transport)
    client.claim_next()
    assert client.last_claim_blocked is None


def test_claim_next_last_claim_blocked_none_when_work_is_claimed():
    # Even if a header somehow rode along on a 200 (never expected from the
    # real backend), only a 204 sets last_claim_blocked.
    transport = FakeTransport(
        [
            Response(
                status=200,
                headers={"x-agentrail-claim-blocked": "workspace-budget"},
                body=(
                    b'{"id":"wi-1","workspace_id":"ws1","source":"github",'
                    b'"external_id":"42","repo_url":"https://github.com/o/r"}'
                ),
            )
        ]
    )
    client = _client(transport)
    item = client.claim_next()
    assert item is not None
    assert client.last_claim_blocked is None


def test_claim_next_last_claim_blocked_clears_on_next_unblocked_poll():
    """last_claim_blocked reflects only the MOST RECENT poll — an unblocked
    poll after a blocked one clears it, never sticky across calls."""
    transport = FakeTransport(
        [
            Response(status=204, body=b"", headers={"x-agentrail-claim-blocked": "workspace-budget"}),
            Response(status=204, body=b""),
        ]
    )
    client = _client(transport)
    client.claim_next()
    assert client.last_claim_blocked == "workspace-budget"
    client.claim_next()
    assert client.last_claim_blocked is None


def test_claim_next_last_claim_blocked_header_lookup_is_case_insensitive():
    # The real transport lower-cases header keys before building Response
    # (email.message.Message preserves wire casing, e.g.
    # "X-Agentrail-Claim-Blocked"); the client must not depend on a fake
    # transport doing the same lower-casing by accident.
    transport = FakeTransport(
        [Response(status=204, body=b"", headers={"x-agentrail-claim-blocked": "workspace-budget"})]
    )
    client = _client(transport)
    client.claim_next()
    assert client.last_claim_blocked == CLAIM_BLOCKED_WORKSPACE_BUDGET


def test_claim_next_parses_mcp_keys_from_payload():
    # The claim payload carries decrypted MCP keys; the runner exports them so
    # native_runner writes the agent's MCP config into the clone.
    transport = FakeTransport(
        [
            Response(
                status=200,
                body=(
                    b'{"id":"wi-1","workspace_id":"ws1","source":"github",'
                    b'"external_id":"42","repo_url":"https://github.com/o/r",'
                    b'"mcp_keys":{"linear":"lin_api_x","context7":"ctx7sk-y","bad":1}}'
                ),
            )
        ]
    )
    item = _client(transport).claim_next()
    # Valid string→string pairs kept; the malformed (non-string) value dropped.
    assert item.mcp_keys == {"linear": "lin_api_x", "context7": "ctx7sk-y"}


def test_claim_next_defaults_mcp_keys_to_empty_when_absent():
    transport = FakeTransport(
        [
            Response(
                status=200,
                body=(
                    b'{"id":"wi-1","workspace_id":"ws1","source":"github",'
                    b'"external_id":"42","repo_url":"https://github.com/o/r"}'
                ),
            )
        ]
    )
    assert _client(transport).claim_next().mcp_keys == {}


def test_workitem_issue_number_extracts_bare_number():
    # external_id is the GitHub identity (`repo#number`), but `agentrail run
    # issue` needs the bare number. issue_number bridges that.
    assert WorkItem(
        id="x", workspace_id="w", source="github",
        external_id="Bensigo/agentrail#826", repo_url="", ref="main",
        title="", body="",
    ).issue_number == "826"


def test_workitem_issue_number_passthrough_when_already_numeric():
    assert WorkItem(
        id="x", workspace_id="w", source="github",
        external_id="42", repo_url="", ref="main", title="", body="",
    ).issue_number == "42"


def test_claim_next_raises_auth_error_on_401():
    # A rejected/expired token must surface as a clear "re-login" error, not a
    # KeyError from trying to parse the error body as a work item.
    transport = FakeTransport([Response(status=401, body=b'{"error":"Unauthorized"}')])
    with pytest.raises(RunnerAuthError):
        _client(transport).claim_next()


def test_claim_next_raises_auth_error_on_403():
    transport = FakeTransport([Response(status=403, body=b'{"error":"wrong workspace"}')])
    with pytest.raises(RunnerAuthError):
        _client(transport).claim_next()


def test_claim_next_raises_runner_error_on_server_error():
    transport = FakeTransport([Response(status=500, body=b'{"error":"boom"}')])
    with pytest.raises(RunnerError):
        _client(transport).claim_next()


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


def test_report_result_carries_repository_id():
    # #1146 AC2 — the result route persists logs_tail as a failure_event, which
    # needs a repository_id; queue_entries has none, so the runner sources it
    # from the claim payload and forwards it in the result body.
    transport = FakeTransport([Response(status=202, body=b"")])
    _client(transport).report_result(
        _work_item_with_repo("repo-7"), status="red", logs_tail="boom"
    )
    sent = _json.loads(transport.calls[0]["body"].decode())
    assert sent["repository_id"] == "repo-7"


def test_report_result_never_forwards_the_github_token():
    # The claim-time token rides on the WorkItem so the runner can authenticate
    # git; report_result's payload lists explicit fields and must never widen to
    # include it (it would otherwise leave the host toward the backend + logs).
    item = WorkItem(
        id="wi-1", workspace_id="ws1", source="github", external_id="42",
        repo_url="https://github.com/o/r", ref="main", title="t", body="b",
        github_token="gho_super_secret",
    )
    transport = FakeTransport([Response(status=202, body=b"")])
    _client(transport).report_result(item, status="green")
    sent = _json.loads(transport.calls[0]["body"].decode())
    assert "gho_super_secret" not in _json.dumps(sent)
    assert "github_token" not in sent


def test_report_result_repository_id_defaults_empty():
    transport = FakeTransport([Response(status=202, body=b"")])
    _client(transport).report_result(_work_item(), status="green")  # repository_id=""
    sent = _json.loads(transport.calls[0]["body"].decode())
    assert sent["repository_id"] == ""


# --- report_telemetry: emit the signals Telemetry Health reads (issue #894) ---

import json as _json


def _work_item_with_repo(repository_id: str = "repo-1") -> WorkItem:
    return WorkItem(
        id="wi-1",
        workspace_id="ws1",
        source="github",
        external_id="42",
        repo_url="https://github.com/o/r",
        ref="main",
        title="t",
        body="b",
        repository_id=repository_id,
    )


def _posts_to(transport: FakeTransport, suffix: str):
    return [c for c in transport.calls if c["url"].endswith(suffix)]


def test_report_telemetry_green_emits_review_gate_passed_and_outbox_flush():
    transport = FakeTransport([Response(status=202, body=b'{"accepted":2}')])
    _client(transport).report_telemetry(
        _work_item(), status="green", now="2026-06-22T00:00:00+00:00"
    )

    run_event_posts = _posts_to(transport, "/api/v1/ingest/run-events")
    assert len(run_event_posts) == 1, "green run posts exactly one run-events batch"
    events = _json.loads(run_event_posts[0]["body"])
    types = {e["action"]["type"] for e in events}
    # event_type (= action.type) must match the checker's LIKE/exact predicates.
    assert "review_gate_passed" in types  # matches event_type LIKE 'review_gate%'
    assert "outbox_flushed" in types       # matches event_type = 'outbox_flushed'
    # A green run emits NO failure_event.
    assert _posts_to(transport, "/api/v1/ingest/failure-events") == []


def test_report_telemetry_red_emits_review_gate_failed_and_failure_event():
    transport = FakeTransport(
        [Response(status=202, body=b'{"accepted":2}'),
         Response(status=202, body=b'{"accepted":1}')]
    )
    _client(transport).report_telemetry(
        _work_item_with_repo("repo-1"),
        status="red",
        gate_reason="tests failed",
        now="2026-06-22T00:00:00+00:00",
    )

    run_events = _json.loads(_posts_to(transport, "/api/v1/ingest/run-events")[0]["body"])
    assert "review_gate_failed" in {e["action"]["type"] for e in run_events}

    failure_posts = _posts_to(transport, "/api/v1/ingest/failure-events")
    assert len(failure_posts) == 1, "a red run emits a failure_event"
    fe = _json.loads(failure_posts[0]["body"])[0]
    assert fe["repository_id"] == "repo-1"
    assert fe["run_id"] == "wi-1"
    assert fe["failure_type"] == "objective_gate"
    assert fe["message"] == "tests failed"
    assert fe["phase"] == "verify"
    assert fe["occurred_at"] == "2026-06-22T00:00:00+00:00"


def test_report_telemetry_error_uses_execution_error_failure_type():
    transport = FakeTransport(
        [Response(status=202, body=b"{}"), Response(status=202, body=b"{}")]
    )
    _client(transport).report_telemetry(
        _work_item_with_repo("repo-1"), status="error", gate_reason="clone failed"
    )
    fe = _json.loads(_posts_to(transport, "/api/v1/ingest/failure-events")[0]["body"])[0]
    assert fe["failure_type"] == "execution_error"
    assert fe["phase"] == "execute"


def test_report_telemetry_red_without_repository_id_skips_failure_event():
    transport = FakeTransport([Response(status=202, body=b"{}")])
    # _work_item() has repository_id="" — can't validate against a repo, so skip.
    _client(transport).report_telemetry(_work_item(), status="red")
    assert len(_posts_to(transport, "/api/v1/ingest/run-events")) == 1
    assert _posts_to(transport, "/api/v1/ingest/failure-events") == []


# --- report_telemetry: failure evidence (#1146 AC1/AC5) ----------------------


def test_report_telemetry_red_attaches_evidence_to_failure_event():
    transport = FakeTransport(
        [Response(status=202, body=b"{}"), Response(status=202, body=b"{}")]
    )
    _client(transport).report_telemetry(
        _work_item_with_repo("repo-1"),
        status="red",
        gate_reason="tests failed",
        evidence="E   AssertionError: expected 3 got 4\n",
        now="2026-06-22T00:00:00+00:00",
    )
    fe = _json.loads(_posts_to(transport, "/api/v1/ingest/failure-events")[0]["body"])[0]
    assert "AssertionError: expected 3 got 4" in fe["evidence"]


def test_report_telemetry_scrubs_credentials_in_evidence():
    # AC5 — a planted key in the logs must be redacted before it leaves the host.
    transport = FakeTransport(
        [Response(status=202, body=b"{}"), Response(status=202, body=b"{}")]
    )
    secret = "sk-ant-api03-PLANTEDplantedPLANTED0123456789abcdef"
    _client(transport).report_telemetry(
        _work_item_with_repo("repo-1"),
        status="error",
        gate_reason="clone failed",
        evidence=f"ANTHROPIC_API_KEY={secret}\nclone failed\n",
        now="2026-06-22T00:00:00+00:00",
    )
    fe = _json.loads(_posts_to(transport, "/api/v1/ingest/failure-events")[0]["body"])[0]
    assert secret not in fe["evidence"]
    assert "[REDACTED" in fe["evidence"]
    assert "clone failed" in fe["evidence"]


def test_report_telemetry_evidence_defaults_empty():
    transport = FakeTransport(
        [Response(status=202, body=b"{}"), Response(status=202, body=b"{}")]
    )
    _client(transport).report_telemetry(
        _work_item_with_repo("repo-1"), status="red", gate_reason="x"
    )
    fe = _json.loads(_posts_to(transport, "/api/v1/ingest/failure-events")[0]["body"])[0]
    assert fe["evidence"] == ""


# --- WorkItem.from_dict: escalation tier parsing (BUG 1) ----------------------


def _claim_payload(**overrides) -> dict:
    """A minimal valid claim payload; override individual fields per test."""
    base = {
        "id": "wi-9",
        "workspace_id": "ws1",
        "source": "github",
        "external_id": "owner/repo#9",
        "repo_url": "https://github.com/owner/repo",
        "ref": "main",
        "title": "t",
        "body": "b",
        "repository_id": "repo-1",
    }
    base.update(overrides)
    return base


def test_from_dict_parses_tier():
    item = WorkItem.from_dict(_claim_payload(tier=2))
    assert item.tier == 2


def test_from_dict_defaults_tier_to_zero_when_absent():
    item = WorkItem.from_dict(_claim_payload())  # no `tier` key at all
    assert item.tier == 0


def test_from_dict_defaults_tier_to_zero_when_non_int():
    # A null or string tier must never crash the loop nor accidentally escalate.
    assert WorkItem.from_dict(_claim_payload(tier=None)).tier == 0
    assert WorkItem.from_dict(_claim_payload(tier="garbage")).tier == 0


def test_from_dict_coerces_numeric_string_tier():
    # A JSON-stringified int is coerced rather than rejected.
    assert WorkItem.from_dict(_claim_payload(tier="1")).tier == 1


# --- WorkItem.from_dict: work kind (#1149) -----------------------------------


def test_from_dict_defaults_kind_to_issue_when_absent():
    # A payload from an older server that omits `kind` must run the normal issue
    # path, never the onboard path.
    item = WorkItem.from_dict(_claim_payload())  # no `kind` key at all
    assert item.kind == "issue"


def test_from_dict_honors_onboard_kind():
    item = WorkItem.from_dict(_claim_payload(kind="onboard"))
    assert item.kind == "onboard"


def test_from_dict_coerces_null_kind_to_issue():
    # A null kind falls back to "issue" via the `or "issue"` guard, so a
    # malformed payload never dispatches into an empty/None kind.
    assert WorkItem.from_dict(_claim_payload(kind=None)).kind == "issue"


# --- WorkItem.from_dict: connected GitHub OAuth token -------------------------


def test_from_dict_parses_github_token():
    item = WorkItem.from_dict(_claim_payload(github_token="gho_workspace_token"))
    assert item.github_token == "gho_workspace_token"


def test_from_dict_defaults_github_token_to_empty_when_absent():
    # An older backend that hasn't shipped the claim-time token attach yet must
    # still parse — the runner then falls back to its own env GIT_TOKEN.
    item = WorkItem.from_dict(_claim_payload())
    assert item.github_token == ""


def test_from_dict_coerces_null_github_token_to_empty():
    assert WorkItem.from_dict(_claim_payload(github_token=None)).github_token == ""


def test_workitem_defaults_github_token_to_empty():
    item = WorkItem(
        id="x", workspace_id="w", source="github",
        external_id="42", repo_url="", ref="main", title="", body="",
    )
    assert item.github_token == ""


def test_workitem_defaults_kind_to_issue():
    # Constructing a WorkItem without passing kind defaults to "issue".
    item = WorkItem(
        id="x", workspace_id="w", source="github",
        external_id="42", repo_url="", ref="main", title="", body="",
    )
    assert item.kind == "issue"
