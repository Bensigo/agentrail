"""The Independent Verifier — a different-model, blocking quality check (ADR 0008).

**Independent Verification** (CONTEXT.md) is a blocking, narrow quality check
performed by a *different* model than the one that produced the change. It
verifies one falsifiable question — do the tests and the change genuinely satisfy
the issue's acceptance criteria and stay in scope, or were they gamed/skipped?
It prevents self-preferential bias (the maker grading its own homework) and is a
meta-check on the **Objective Gate**, not a taste review.

This is a **deep, pure module** (verification-contract-architecture.md):

- ``select_verifier_model`` picks a verifier model that is DIFFERENT from the
  Implementer's model (AC1). It is pure: given the implementer model and the
  candidate models, it returns the chosen distinct model (or ``""`` when none
  differs, so the pipeline never runs a same-model verifier).
- ``parse_verdict`` turns the verifier agent's output into a structured,
  testable ``Verdict`` (accept / reject + reason). It is **fail-closed**: output
  with no parseable verdict is a REJECT, so an unverifiable run cannot silently
  reach done.
- ``decide`` is the pure block/allow decision given a ``Verdict``.
- ``gate_evidence`` bridges a ``Verdict`` to the ``verification_evidence`` mapping
  the Objective Gate consumes (``{"required": ..., "valid": ...}``) — a REJECT is
  ``valid=False`` and so the gate refuses GREEN (AC3).

Running the verifier agent (the actual model call) is thin orchestration in the
pipeline; that keeps this module deterministic and unit-testable in isolation.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Dict, Sequence

# Marker the verifier prompt asks the agent to emit. Parsing also falls back to
# the first JSON object found, so the marker is a convenience, not a hard
# requirement.
VERDICT_MARKER = "VERDICT:"


@dataclass(frozen=True)
class Verdict:
    """The Verifier's structured, falsifiable verdict.

    ``accepted`` is the single bit the gate needs: ``True`` = the change and its
    tests genuinely satisfy the AC; ``False`` = rejected (gamed/skipped/out of
    scope/unverifiable). ``reason`` is human-readable evidence for the run
    surface.
    """

    accepted: bool
    reason: str = ""


@dataclass(frozen=True)
class VerificationResult:
    """The block/allow decision derived from a ``Verdict``.

    ``allowed`` means the verifier confirmed the change (the run may proceed to
    done); ``blocked`` means the verifier rejected it (done is blocked, AC3).
    """

    allowed: bool
    reason: str = ""

    @property
    def blocked(self) -> bool:
        return not self.allowed


def select_verifier_model(implementer_model: str, candidates: Sequence[str]) -> str:
    """Pick a verifier model DIFFERENT from the Implementer's model (AC1).

    Pure. Returns the first non-empty candidate that does not equal
    ``implementer_model``. When every candidate is empty or equals the
    implementer's model, returns ``""`` — the pipeline must then NOT run the
    verifier on the same model, because Independent Verification requires a
    different model (CONTEXT.md). When ``implementer_model`` is ``""`` (unknown),
    any non-empty candidate qualifies.
    """
    impl = (implementer_model or "").strip()
    for candidate in candidates:
        model = (candidate or "").strip()
        if not model:
            continue
        if model != impl:
            return model
    return ""


def parse_verdict(output: str) -> Verdict:
    """Parse a verifier agent's output into a structured ``Verdict`` (pure).

    Looks for a JSON object with a ``verdict`` of ``"accept"`` or ``"reject"``
    (optionally after the ``VERDICT:`` marker, otherwise the first JSON object in
    the text). Anything else — no JSON, malformed JSON, an unknown verdict value,
    or empty output — is **fail-closed** to a REJECT, so an unverifiable run can
    never silently reach done.
    """
    text = output or ""
    obj = _extract_verdict_object(text)
    if obj is None:
        return Verdict(accepted=False, reason="verifier produced no verdict")

    raw = str(obj.get("verdict", "")).strip().lower()
    reason = str(obj.get("reason", "")).strip()
    if raw == "accept":
        return Verdict(accepted=True, reason=reason or "accepted")
    if raw == "reject":
        return Verdict(accepted=False, reason=reason or "rejected")
    return Verdict(
        accepted=False,
        reason=reason or f"verifier returned unknown verdict {raw!r}",
    )


def _extract_verdict_object(text: str) -> Dict[str, Any] | None:
    """Find the verdict JSON object in ``text``; None when none parses.

    Prefers the JSON after the ``VERDICT:`` marker; otherwise scans for the first
    balanced ``{...}`` block that parses as an object with a ``verdict`` key.
    """
    candidates = []
    marker_idx = text.find(VERDICT_MARKER)
    if marker_idx != -1:
        candidates.append(text[marker_idx + len(VERDICT_MARKER):])
    candidates.append(text)

    for segment in candidates:
        for match in re.finditer(r"\{[^{}]*\}", segment):
            try:
                obj = json.loads(match.group(0))
            except (ValueError, TypeError):
                continue
            if isinstance(obj, dict) and "verdict" in obj:
                return obj
    return None


def decide(verdict: Verdict) -> VerificationResult:
    """Decide block/allow from a structured ``Verdict`` (pure).

    Accept → allowed; reject → blocked, carrying the verdict reason so the run
    surface can show *why* the verifier blocked done.
    """
    if verdict.accepted:
        return VerificationResult(allowed=True, reason=verdict.reason)
    return VerificationResult(allowed=False, reason=verdict.reason)


def gate_evidence(verdict: Verdict) -> Dict[str, Any]:
    """Bridge a ``Verdict`` to the ``verification_evidence`` the gate consumes.

    Independent Verification is always *required* once the verifier ran (it is a
    blocking check, unlike advisory review), so this always sets
    ``required=True`` and reports ``valid`` from the verdict's acceptance. A
    REJECT (``valid=False``) makes the Objective Gate refuse GREEN (AC3).
    """
    return {
        "required": True,
        "valid": bool(verdict.accepted),
        "reason": verdict.reason,
    }
