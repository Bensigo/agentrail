"""Minimal Langfuse public-API client (stdlib only).

Pinned against the Langfuse API reference (see PR): ingestion is
POST /api/public/ingestion with a {"batch": [...]} envelope of
{id, type, timestamp, body} events; auth is HTTP Basic (public:secret).
House pattern mirrors agentrail/run/cost_push.py: urllib, non-fatal callers.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import urllib.error
import urllib.request
from typing import Optional

_TIMEOUT = 10


def enabled() -> bool:
    return os.environ.get("AGENTRAIL_LANGFUSE_ENABLED", "").strip().lower() in (
        "1", "true", "yes",
    )


def deterministic_trace_id(run_id: str) -> str:
    return hashlib.sha256(f"agentrail:{run_id}".encode("utf-8")).hexdigest()[:32]


def _request(method, url, headers, data, timeout):
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # nosec B310 — https/local
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        # urlopen raises HTTPError for non-2xx/redirect responses instead of
        # returning them; normalize back to the tuple[int, bytes] contract so
        # callers' `if status >= 400` checks are real, reachable code.
        return e.code, e.read()


class LangfuseHTTP:
    def __init__(self, base_url: str, public_key: str, secret_key: str):
        self.base_url = base_url.rstrip("/")
        token = base64.b64encode(f"{public_key}:{secret_key}".encode()).decode()
        self._headers = {
            "Authorization": f"Basic {token}",
            "Content-Type": "application/json",
        }

    @classmethod
    def from_env(cls) -> Optional["LangfuseHTTP"]:
        host = os.environ.get("LANGFUSE_HOST") or os.environ.get("LANGFUSE_BASE_URL")
        pk = os.environ.get("LANGFUSE_PUBLIC_KEY")
        sk = os.environ.get("LANGFUSE_SECRET_KEY")
        if not (host and pk and sk):
            return None
        return cls(host, pk, sk)

    def ingest(self, batch: list) -> None:
        data = json.dumps({"batch": batch}).encode("utf-8")
        status, _ = _request("POST", f"{self.base_url}/api/public/ingestion",
                             self._headers, data, _TIMEOUT)
        if status >= 400:
            raise RuntimeError(f"langfuse ingestion HTTP {status}")

    def get_json(self, path: str, params: dict) -> dict:
        from urllib.parse import urlencode
        url = f"{self.base_url}{path}"
        if params:
            url = f"{url}?{urlencode(params)}"
        status, body = _request("GET", url, self._headers, None, _TIMEOUT)
        if status >= 400:
            raise RuntimeError(f"langfuse GET {path} HTTP {status}")
        return json.loads(body)

    def post_json(self, path: str, body: dict) -> dict:
        data = json.dumps(body).encode("utf-8")
        status, resp = _request("POST", f"{self.base_url}{path}",
                                self._headers, data, _TIMEOUT)
        if status >= 400:
            raise RuntimeError(f"langfuse POST {path} HTTP {status}")
        return json.loads(resp) if resp else {}
