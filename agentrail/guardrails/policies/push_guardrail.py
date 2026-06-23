"""Secret / prod-push guardrail — PURE policy (no network/git I/O).

Migrated verbatim (decision semantics unchanged) from
``agentrail/run/push_guardrail.py`` for issue #921.  Blocks two classes of
dangerous push/commit and builds the **Audit Event** that records every block:

- a commit/push whose staged/committed content contains a **detected secret**;
- a push to a **protected / production target**.

What lives here (pure)
----------------------
* :class:`SecretFinding` / :class:`PushDecision` — the original result types.
* :func:`detect_secrets`, :func:`find_protected_target`, :func:`evaluate_push`
  — the pure decision logic (secret-pattern matching + protected-target match).
* :func:`build_audit_event` — builds the Audit Event payload (pure data).
* :func:`guard_push` — pure decision plus an *injected* ``emit`` callback (the
  only I/O, and it lives in the caller-supplied callback, not in this module).
* :func:`_now_iso` — timestamp helper (kept here because the approval-gate policy
  re-uses it for one shared Audit Event envelope).
* :class:`PushGuardrail` — the seam adapter wrapping :func:`evaluate_push`.

What deliberately does NOT live here
------------------------------------
``make_server_emitter`` performs network I/O (a run-event POST) and so lives in
:mod:`agentrail.guardrails.adapters.push` (AC2).  Importing this module pulls in
no ``subprocess``/``gh``/``git``/``pytest`` and no networking.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Sequence

from agentrail.guardrails.base import Verdict
from agentrail.guardrails.registry import register


# Default protected / production targets. A push whose target matches any of
# these (branch or remote ref, case-insensitively) is blocked unless the
# caller overrides the list.
DEFAULT_PROTECTED_TARGETS = ("main", "master", "production", "prod", "release")


@dataclass(frozen=True)
class SecretFinding:
    """One detected secret: which pattern matched and a redacted preview."""
    kind: str
    redacted: str


@dataclass(frozen=True)
class PushDecision:
    """Pure result of evaluating a push/commit.

    ``blocked`` is the headline decision; ``reason`` is a stable machine token
    ("secret_detected" | "protected_target"); ``findings`` lists detected
    secrets (empty for a protected-target block).
    """
    blocked: bool
    reason: str = ""
    detail: str = ""
    findings: List[SecretFinding] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Secret detection (pure)
# ---------------------------------------------------------------------------

# Conservative, well-known patterns: caught secrets must be obvious, but an
# ordinary diff must not trip these. Each entry is (kind, compiled regex).
_SECRET_PATTERNS = [
    # AWS access key id — fixed AKIA/ASIA prefix + 16 uppercase/digits.
    ("aws_access_key_id", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    # Private key PEM block header.
    ("private_key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----")),
    # GitHub personal-access / app tokens (ghp_, gho_, ghu_, ghs_, ghr_).
    ("github_token", re.compile(r"\bgh[posur]_[0-9A-Za-z]{36,}\b")),
    # Slack tokens (xoxb-/xoxp-/xoxa-/xoxr-).
    ("slack_token", re.compile(r"\bxox[baprs]-[0-9A-Za-z-]{10,}\b")),
    # Google API key.
    ("google_api_key", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    # Stripe live secret key.
    ("stripe_secret_key", re.compile(r"\bsk_live_[0-9A-Za-z]{16,}\b")),
]


def _redact(match_text: str) -> str:
    """Keep a short prefix so a finding is identifiable without leaking the
    full secret into logs / audit events."""
    if len(match_text) <= 8:
        return match_text[:2] + "***"
    return match_text[:6] + "***"


def detect_secrets(content: str) -> List[SecretFinding]:
    """Return every detected secret in *content* (pure, unit-testable).

    Empty list = no obvious secret. Findings are de-duplicated by redacted
    preview so a secret repeated across hunks reports once.
    """
    findings: List[SecretFinding] = []
    seen: set[tuple[str, str]] = set()
    for kind, pattern in _SECRET_PATTERNS:
        for match in pattern.finditer(content):
            redacted = _redact(match.group(0))
            key = (kind, redacted)
            if key in seen:
                continue
            seen.add(key)
            findings.append(SecretFinding(kind=kind, redacted=redacted))
    return findings


def _normalize_target(target: str) -> str:
    """Reduce a ref to its branch-name segment for matching.

    ``origin/production`` -> ``production``; ``refs/heads/main`` -> ``main``.
    """
    name = target.strip().lower()
    if not name:
        return ""
    # Strip a leading refs/heads/ or refs/remotes/<remote>/ qualifier, then
    # take the final path segment (drops the remote name).
    for prefix in ("refs/heads/", "refs/remotes/", "refs/"):
        if name.startswith(prefix):
            name = name[len(prefix):]
            break
    return name.rsplit("/", 1)[-1]


def find_protected_target(
    targets: Sequence[str],
    protected: Sequence[str] = DEFAULT_PROTECTED_TARGETS,
) -> str:
    """Return the first *target* that matches a protected name, else "" (pure)."""
    protected_names = {p.strip().lower() for p in protected if p.strip()}
    for target in targets:
        if _normalize_target(target) in protected_names:
            return target
    return ""


def evaluate_push(
    targets: Sequence[str],
    content: str,
    protected: Sequence[str] = DEFAULT_PROTECTED_TARGETS,
) -> PushDecision:
    """Decide whether a commit/push is allowed (pure).

    Secret detection takes precedence over the protected-target check so the
    most sensitive reason is reported first. Returns a ``PushDecision``.
    """
    findings = detect_secrets(content)
    if findings:
        kinds = ", ".join(sorted({f.kind for f in findings}))
        return PushDecision(
            blocked=True,
            reason="secret_detected",
            detail=f"detected secret(s): {kinds}",
            findings=findings,
        )
    protected_target = find_protected_target(targets, protected)
    if protected_target:
        return PushDecision(
            blocked=True,
            reason="protected_target",
            detail=f"push to protected/production target: {protected_target}",
        )
    return PushDecision(blocked=False)


# ---------------------------------------------------------------------------
# Audit Event (pure data): every block records a sensitive-action / policy
# decision. The actual POST lives in adapters.push (I/O edge).
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def build_audit_event(
    decision: PushDecision,
    run_id: str,
    target: str = "",
) -> Dict[str, Any]:
    """Build the **Audit Event** for a guardrail block (pure).

    An Audit Event is a Run Event recording a sensitive action / policy
    decision (CONTEXT.md). The shape mirrors ``activity_push`` run events
    (``session_id``/``seq``/``ts``/``kind``/``action``) so the existing
    ``/api/v1/ingest/run-events`` path accepts it without a new endpoint. Only
    redacted secret previews are included — the raw secret never leaves here.
    """
    return {
        "session_id": run_id,
        "seq": int(time.time() * 1000),
        "ts": _now_iso(),
        "kind": "audit",
        "action": {
            "type": "security_block",
            "reason": decision.reason,
            "target": target,
            "detail": decision.detail,
            "findings": [
                {"kind": f.kind, "redacted": f.redacted} for f in decision.findings
            ],
        },
        "digest": f"security_block:{decision.reason}"[:64],
    }


def guard_push(
    targets: Sequence[str],
    content: str,
    emit: Optional[Callable[[Dict[str, Any]], Any]] = None,
    protected: Sequence[str] = DEFAULT_PROTECTED_TARGETS,
    run_id: str = "",
) -> PushDecision:
    """Evaluate a push/commit and, on a block, emit one **Audit Event** (AC3).

    Pure decision via ``evaluate_push``; the only side effect is the injected
    ``emit`` callback (I/O at the edge). An allowed push emits nothing. The
    audit event always fires before the caller acts on the block, so no block
    is silent.
    """
    decision = evaluate_push(targets, content, protected)
    if decision.blocked and emit is not None:
        blocked_target = find_protected_target(targets, protected) or (
            targets[0] if targets else ""
        )
        emit(build_audit_event(decision, run_id=run_id, target=blocked_target))
    return decision


# ---------------------------------------------------------------------------
# Guardrail seam adapter (pure) — registered so `list_guardrails()` sees it.
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class PushGuardrail:
    """Adapts :func:`evaluate_push` to the :class:`Guardrail` protocol.

    Blocking guardrail: a detected secret or a protected/production target is a
    ``FAIL``.  ``evaluate(targets=..., content=..., protected=...)`` runs
    :func:`evaluate_push` and maps the ``PushDecision`` 1:1 — blocked → ``FAIL``
    (with the decision's detail), allowed → ``PASS``.
    """

    name: str = "push_guardrail"
    description: str = (
        "Blocks a commit/push that contains a detected secret or targets a "
        "protected/production branch; records every block as an Audit Event."
    )
    blocking: bool = True

    def evaluate(self, **kwargs: object) -> Verdict:
        targets = kwargs.get("targets", ())
        content = str(kwargs.get("content", ""))
        protected = kwargs.get("protected", DEFAULT_PROTECTED_TARGETS)
        if not isinstance(targets, Sequence) or isinstance(targets, (str, bytes)):
            raise TypeError(
                "PushGuardrail.evaluate requires targets= as a sequence of strings"
            )
        decision = evaluate_push(
            tuple(targets), content, protected  # type: ignore[arg-type]
        )
        if decision.blocked:
            return Verdict.failing(decision.detail or decision.reason)
        return Verdict.passing()


# Register the singleton instance at import time so `list_guardrails()` sees it.
PUSH_GUARDRAIL = register(PushGuardrail())
