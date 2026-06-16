"""OAuth Device Authorization Grant (RFC 8628) — the ``agentrail login`` flow.

The deployed dashboard is where the user signs up and is already authenticated
in their browser. The CLI never asks for a password; it runs the device flow:

  1. POST ``/api/v1/auth/device/start`` → a short ``user_code`` + a
     ``verification_uri`` the user opens in that already-signed-in browser.
  2. The CLI polls ``/api/v1/auth/device/token`` with the opaque ``device_code``
     every ``interval`` seconds while the user approves.
  3. On approval the backend returns a runner ``token`` + the ``workspace_id``,
     which we hand back as :class:`Credentials` for the caller to persist.

Pure orchestration over an injectable ``transport`` + ``sleep`` so the whole
pending→authorized handshake is testable with no network and no real waiting.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Callable, Optional

from agentrail.runner.client import Response, Transport, _urllib_transport
from agentrail.runner.credentials import Credentials


class DeviceAuthError(Exception):
    """The device flow could not complete (denied, expired, or backend error)."""


@dataclass(frozen=True)
class DeviceAuth:
    device_code: str
    user_code: str
    verification_uri: str
    interval: int


# How the flow tells the caller what code/URL to show the user.
OnPrompt = Callable[[str, str], None]


def _post_json(transport: Transport, url: str, payload: dict) -> Response:
    return transport(
        "POST",
        url,
        headers={"Content-Type": "application/json"},
        body=json.dumps(payload).encode("utf-8"),
    )


def _error_label(resp: Response) -> str:
    try:
        return str(json.loads(resp.body.decode("utf-8")).get("error", ""))
    except (ValueError, AttributeError):
        return ""


def run_device_login(
    *,
    base_url: str,
    transport: Optional[Transport] = None,
    sleep: Callable[[float], None],
    on_prompt: OnPrompt,
    max_polls: int = 180,
) -> Credentials:
    """Run the device flow end-to-end and return :class:`Credentials`.

    Raises :class:`DeviceAuthError` on denial, backend error, or if the user
    never approves within ``max_polls`` polling cycles.
    """
    transport = transport or _urllib_transport
    base = base_url.rstrip("/")

    start = _post_json(transport, f"{base}/api/v1/auth/device/start", {})
    if not (200 <= start.status < 300):
        raise DeviceAuthError(f"could not start login (HTTP {start.status})")
    d = json.loads(start.body.decode("utf-8"))
    auth = DeviceAuth(
        device_code=str(d["device_code"]),
        user_code=str(d["user_code"]),
        verification_uri=str(d["verification_uri"]),
        interval=int(d.get("interval") or 5),
    )

    on_prompt(auth.user_code, auth.verification_uri)

    token_url = f"{base}/api/v1/auth/device/token"
    for attempt in range(max_polls):
        resp = _post_json(transport, token_url, {"device_code": auth.device_code})
        if 200 <= resp.status < 300 and resp.body:
            t = json.loads(resp.body.decode("utf-8"))
            # 202 + authorization_pending is "keep waiting"; a real token is "done".
            if t.get("token"):
                return Credentials(
                    base_url=base,
                    token=str(t["token"]),
                    workspace_id=str(t["workspace_id"]),
                )
            # 2xx without a token → still pending.
            if attempt < max_polls - 1:
                sleep(auth.interval)
            continue
        # Non-2xx: distinguish "still pending" from a terminal failure.
        label = _error_label(resp)
        if label == "authorization_pending" or resp.status == 202:
            if attempt < max_polls - 1:
                sleep(auth.interval)
            continue
        raise DeviceAuthError(f"login failed: {label or f'HTTP {resp.status}'}")

    raise DeviceAuthError("login timed out — the code expired before approval")
