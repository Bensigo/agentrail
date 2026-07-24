"""Tests for agentrail/github_app.py — pure GitHub App JWT signing + minting.

Python twin of packages/github-app/src/index.ts (spec:
docs/superpowers/specs/2026-07-24-jace-github-app-identity-design.md §3/§6).
No real network — like agentrail/tests/runner/test_client.py's FakeTransport,
``mint_installation_token``'s transport is injectable so a fake replays
scripted responses and records what was sent.
"""
from __future__ import annotations

import json
import time
from typing import Any, Dict, List, Optional, Tuple

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from agentrail.github_app import Response, mint_installation_token, sign_app_jwt


def _rsa_keypair() -> Tuple[str, str]:
    """Generate an RSA keypair in-test; returns (private_pem, public_pem)."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")
    public_pem = key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("utf-8")
    return private_pem, public_pem


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


# --- sign_app_jwt -------------------------------------------------------


def test_sign_app_jwt_payload_fields():
    private_pem, public_pem = _rsa_keypair()
    now = int(time.time())
    token = sign_app_jwt("app-123", private_pem, now=now)

    decoded = jwt.decode(
        token,
        public_pem,
        algorithms=["RS256"],
        options={"verify_signature": True},
        audience=None,
    )
    assert decoded["iss"] == "app-123"
    assert decoded["iat"] == now - 60
    assert decoded["exp"] == now + 540


def test_sign_app_jwt_defaults_now_to_current_time():
    private_pem, public_pem = _rsa_keypair()
    before = int(time.time())
    token = sign_app_jwt("app-456", private_pem)
    after = int(time.time())

    decoded = jwt.decode(token, public_pem, algorithms=["RS256"], audience=None)
    assert before - 60 <= decoded["iat"] <= after - 60
    assert before + 540 <= decoded["exp"] <= after + 540


def test_sign_app_jwt_normalizes_literal_backslash_n_in_pem():
    # Env-var transports (Railway, compose env_file) often flatten a PEM's
    # real newlines to the two-character sequence "\n" — mirrors
    # resolveGithubAppConfig's normalization on the TS side.
    private_pem, public_pem = _rsa_keypair()
    flattened = private_pem.replace("\n", "\\n")
    assert "\\n" in flattened and "\n" not in flattened

    now = int(time.time())
    token = sign_app_jwt("app-789", flattened, now=now)

    decoded = jwt.decode(token, public_pem, algorithms=["RS256"], audience=None)
    assert decoded["iss"] == "app-789"
    assert decoded["iat"] == now - 60


# --- mint_installation_token ---------------------------------------------


def _cfg() -> Dict[str, str]:
    private_pem, _ = _rsa_keypair()
    return {"app_id": "app-1", "private_key_pem": private_pem}


def test_mint_installation_token_posts_expected_shape_and_returns_token():
    cfg = _cfg()
    transport = FakeTransport(
        [
            Response(
                status=201,
                body=json.dumps(
                    {"token": "ghs_minted", "expires_at": "2026-07-24T12:00:00Z"}
                ).encode("utf-8"),
            )
        ]
    )

    token = mint_installation_token(
        "inst-42",
        app_id=cfg["app_id"],
        private_key_pem=cfg["private_key_pem"],
        transport=transport,
    )

    assert token == "ghs_minted"
    assert len(transport.calls) == 1
    call = transport.calls[0]
    assert call["method"] == "POST"
    assert call["url"] == "https://api.github.com/app/installations/inst-42/access_tokens"
    assert call["headers"]["Accept"] == "application/vnd.github+json"
    auth = call["headers"]["Authorization"]
    assert auth.startswith("Bearer ")
    jwt_token = auth.split(" ", 1)[1]
    assert jwt_token.count(".") == 2  # well-formed JWT shape


def test_mint_installation_token_returns_none_on_404_uninstalled():
    cfg = _cfg()
    transport = FakeTransport([Response(status=404, body=b'{"message":"Not Found"}')])

    token = mint_installation_token(
        "inst-gone",
        app_id=cfg["app_id"],
        private_key_pem=cfg["private_key_pem"],
        transport=transport,
    )

    assert token is None


def test_mint_installation_token_returns_none_on_non_2xx():
    cfg = _cfg()
    transport = FakeTransport([Response(status=500, body=b'{"message":"boom"}')])

    token = mint_installation_token(
        "inst-1",
        app_id=cfg["app_id"],
        private_key_pem=cfg["private_key_pem"],
        transport=transport,
    )

    assert token is None


def test_mint_installation_token_returns_none_when_transport_raises():
    cfg = _cfg()

    def _boom(method: str, url: str, *, headers: Dict[str, str], body: Optional[bytes] = None) -> Response:
        raise OSError("network unreachable")

    token = mint_installation_token(
        "inst-1",
        app_id=cfg["app_id"],
        private_key_pem=cfg["private_key_pem"],
        transport=_boom,
    )

    assert token is None


def test_mint_installation_token_returns_none_on_unparsable_body():
    cfg = _cfg()
    transport = FakeTransport([Response(status=201, body=b"not json")])

    token = mint_installation_token(
        "inst-1",
        app_id=cfg["app_id"],
        private_key_pem=cfg["private_key_pem"],
        transport=transport,
    )

    assert token is None


def test_mint_installation_token_returns_none_on_missing_token_field():
    cfg = _cfg()
    transport = FakeTransport(
        [Response(status=201, body=json.dumps({"expires_at": "x"}).encode("utf-8"))]
    )

    token = mint_installation_token(
        "inst-1",
        app_id=cfg["app_id"],
        private_key_pem=cfg["private_key_pem"],
        transport=transport,
    )

    assert token is None


def test_mint_installation_token_returns_none_on_malformed_private_key_never_raises():
    transport = FakeTransport([])  # never reached — signing fails first

    token = mint_installation_token(
        "inst-1",
        app_id="app-1",
        private_key_pem="not-a-real-pem",
        transport=transport,
    )

    assert token is None
    assert transport.calls == []
