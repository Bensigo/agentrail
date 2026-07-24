"""Pure GitHub App JWT signing + installation-token minting for Python.

The Python twin of ``packages/github-app/src/index.ts`` (spec:
docs/superpowers/specs/2026-07-24-jace-github-app-identity-design.md §3/§6).
Deliberately has ZERO workspace/DB knowledge — ``agentrail.heartbeat.
token_provider`` composes these into a workspace-aware helper
(``get_github_token``), mirroring the one-directional dependency graph the
TS side keeps (``@agentrail/db-postgres`` depends on
``@agentrail/github-app``, never the reverse).

GitHub requires the App JWT to be RS256-signed, with ``iat`` backdated for
clock drift and ``exp`` no more than 10 minutes out. Tokens and private keys
never appear in any exception or log line — every failure in
``mint_installation_token`` collapses to ``None``, the same closed-failure
posture as the TS reference (``GithubAppFailure``'s reason codes, flattened
here to a single ``None`` since this module's only caller is
``token_provider.get_github_token``, which is itself ``Optional[str]``).
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Dict, Optional

import jwt

GITHUB_API_BASE = "https://api.github.com"

# GitHub's documented clock-drift allowance (backdate iat) and the App JWT's
# hard cap on lifetime (10 minutes) — mirrors signAppJwt in
# packages/github-app/src/index.ts exactly (iat = now-60, exp = now+540).
_IAT_BACKDATE_SECONDS = 60
_EXP_LIFETIME_SECONDS = 540


@dataclass(frozen=True)
class Response:
    """A minimal HTTP response: status code + raw body bytes."""

    status: int
    body: bytes
    headers: Dict[str, str] = field(default_factory=dict)


# A transport performs exactly one HTTP request and returns a Response. This
# is the injectable seam (default: urllib) — mirrors
# agentrail.runner.client's ``_urllib_transport`` idiom so tests can inject a
# fake and never touch the real network.
Transport = Callable[..., Response]


def _urllib_transport(
    method: str,
    url: str,
    *,
    headers: Dict[str, str],
    body: Optional[bytes] = None,
) -> Response:  # pragma: no cover - exercised against the real GitHub API
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return Response(
                status=int(resp.status),
                body=resp.read(),
                headers={k.lower(): v for k, v in resp.headers.items()},
            )
    except urllib.error.HTTPError as exc:  # treat HTTP errors as responses
        return Response(
            status=int(exc.code),
            body=exc.read(),
            headers={k.lower(): v for k, v in exc.headers.items()} if exc.headers else {},
        )


def _normalize_pem(private_key_pem: str) -> str:
    """Undo literal ``\\n`` flattening some env-var transports do to PEMs.

    Mirrors ``resolveGithubAppConfig`` on the TS side: Railway / compose
    ``env_file`` transports often flatten a PEM's real newlines to the
    two-character sequence ``\\n``, which breaks PEM parsing. A PEM that
    already has real newlines is unaffected — there is no literal ``\\n``
    substring in it to replace.
    """
    return private_key_pem.replace("\\n", "\n")


def sign_app_jwt(app_id: str, private_key_pem: str, now: Optional[int] = None) -> str:
    """Sign a GitHub App JWT (RS256) for authenticating as the App itself.

    ``now`` defaults to the current time (epoch seconds); callers/tests pin
    it for determinism. ``iat`` is backdated 60s (GitHub's documented
    clock-drift allowance); ``exp`` is 9 minutes out — under the 10-minute
    hard cap with margin. Mirrors ``signAppJwt`` in
    ``packages/github-app/src/index.ts`` field-for-field.
    """
    now_seconds = now if now is not None else int(time.time())
    payload = {
        "iss": app_id,
        "iat": now_seconds - _IAT_BACKDATE_SECONDS,
        "exp": now_seconds + _EXP_LIFETIME_SECONDS,
    }
    return jwt.encode(payload, _normalize_pem(private_key_pem), algorithm="RS256")


def mint_installation_token(
    installation_id: str,
    *,
    app_id: str,
    private_key_pem: str,
    transport: Optional[Transport] = None,
) -> Optional[str]:
    """Mint a short-lived installation access token, or ``None`` on ANY failure.

    POSTs ``/app/installations/{id}/access_tokens`` bearing a freshly-signed
    App JWT (mirrors ``mintInstallationToken`` in
    ``packages/github-app/src/index.ts``). Closed-failure posture: a
    malformed/truncated private key, an unreachable network, a non-2xx
    response (404 = the installation id no longer exists — the App was
    uninstalled; any other status = rejected), or an unparsable/missing
    ``token`` field in the body all collapse to ``None``. Never raises, and
    never includes the key or the minted token in any exception or log line.
    """
    try:
        signed_jwt = sign_app_jwt(app_id, private_key_pem)
    except Exception:
        return None

    url = f"{GITHUB_API_BASE}/app/installations/{installation_id}/access_tokens"
    headers = {
        "Authorization": f"Bearer {signed_jwt}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "agentrail-cli",
    }
    transport_fn = transport or _urllib_transport
    try:
        resp = transport_fn("POST", url, headers=headers, body=None)
    except Exception:
        return None

    if not (200 <= resp.status < 300):
        return None
    try:
        data = json.loads(resp.body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    token = data.get("token") if isinstance(data, dict) else None
    return token if isinstance(token, str) and token else None
