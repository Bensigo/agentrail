"""Tests for the OAuth Device Authorization Grant login flow (RFC 8628).

``agentrail login`` should feel like ``gh auth login``: the CLI asks the backend
to start a device flow, shows the user a short code + URL to approve in the
browser (where they're already signed into the deployed dashboard), then polls
until the backend hands back a runner token + workspace. No password is ever
typed into the terminal.

The flow is pure orchestration over an injectable transport + sleep, so these
tests drive the whole pending→authorized handshake with no network and no real
waiting.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from agentrail.runner.client import Response
from agentrail.runner.credentials import Credentials
from agentrail.runner.login import DeviceAuthError, run_device_login


class ScriptedTransport:
    """Replays a queue of responses; records the requests it received."""

    def __init__(self, responses: List[Response]) -> None:
        self.responses = list(responses)
        self.calls: List[Dict[str, Any]] = []

    def __call__(
        self, method: str, url: str, *, headers: Dict[str, str], body: Optional[bytes] = None
    ) -> Response:
        self.calls.append({"method": method, "url": url, "headers": headers, "body": body})
        return self.responses.pop(0)


def _start(body: bytes) -> Response:
    return Response(status=200, body=body)


_START_OK = _start(
    b'{"device_code":"dev-123","user_code":"WDJB-MJHT",'
    b'"verification_uri":"https://app.agentrail.dev/activate","interval":5}'
)


def test_login_shows_code_then_polls_until_authorized():
    transport = ScriptedTransport(
        [
            _START_OK,
            # first poll: still pending
            Response(status=202, body=b'{"error":"authorization_pending"}'),
            # second poll: authorized
            Response(
                status=200,
                body=b'{"token":"rt_live","workspace_id":"ws-9"}',
            ),
        ]
    )
    prompts: List[Dict[str, str]] = []
    sleeps: List[float] = []

    creds = run_device_login(
        base_url="https://app.agentrail.dev/",
        transport=transport,
        sleep=sleeps.append,
        on_prompt=lambda user_code, uri: prompts.append({"code": user_code, "uri": uri}),
    )

    assert creds == Credentials(
        base_url="https://app.agentrail.dev",
        token="rt_live",
        workspace_id="ws-9",
    )
    # The user was shown the code + activation URL.
    assert prompts == [{"code": "WDJB-MJHT", "uri": "https://app.agentrail.dev/activate"}]
    # It waited one poll interval between the pending and the authorized poll.
    assert sleeps == [5]

    # Endpoints + auth-free start, device_code-bearing polls.
    assert transport.calls[0]["url"] == "https://app.agentrail.dev/api/v1/auth/device/start"
    assert transport.calls[1]["url"] == "https://app.agentrail.dev/api/v1/auth/device/token"
    import json

    assert json.loads(transport.calls[1]["body"])["device_code"] == "dev-123"


def test_login_raises_on_denied():
    transport = ScriptedTransport(
        [_START_OK, Response(status=400, body=b'{"error":"access_denied"}')]
    )
    try:
        run_device_login(
            base_url="https://app.agentrail.dev",
            transport=transport,
            sleep=lambda _s: None,
            on_prompt=lambda *_a: None,
        )
        assert False, "expected DeviceAuthError"
    except DeviceAuthError as exc:
        assert "access_denied" in str(exc)


def test_login_raises_on_expired_after_max_polls():
    # Always pending → must give up rather than loop forever.
    responses = [_START_OK] + [
        Response(status=202, body=b'{"error":"authorization_pending"}') for _ in range(100)
    ]
    transport = ScriptedTransport(responses)
    try:
        run_device_login(
            base_url="https://app.agentrail.dev",
            transport=transport,
            sleep=lambda _s: None,
            on_prompt=lambda *_a: None,
            max_polls=3,
        )
        assert False, "expected DeviceAuthError"
    except DeviceAuthError as exc:
        assert "expired" in str(exc).lower() or "timed out" in str(exc).lower()
