"""The Critic — a cheap-model independent reviewer (issue #977).

The **Critic** is the independent reviewer that feeds the **Objective Gate**,
replacing the *expensive* model the ``verify`` phase used today with a CHEAP model
tier (default Haiku). It is INDEPENDENT of the executor — it never grades its own
homework — and it answers the same falsifiable question the Independent Verifier
answers: do the change and its tests genuinely satisfy the issue's acceptance
criteria and stay in scope, or were they gamed/skipped?

This is a **deep, pure module** (verification-contract-architecture.md):

- ``resolve_critic_model`` picks the CHEAP model tier (AC1): the configured
  critic model, or the default cheap model (Haiku) when none is configured.
- ``score_candidate`` turns the critic agent's output into a structured,
  testable ``CriticVerdict`` (accept/reject + score + reason). It is
  **fail-closed**: output with no parseable verdict is a REJECT (``score=0.0``),
  so an unscored run can never silently reach done.
- ``gate_evidence`` bridges a ``CriticVerdict`` to the SAME
  ``verification_evidence`` mapping the Objective Gate already consumes from the
  verifier (``{"required": ..., "valid": ..., "reason": ...}``). Producing the
  identical evidence shape is what keeps the gate's accept/reject contract and
  false-green handling UNCHANGED (AC2): a REJECT is ``valid=False`` and the gate
  refuses GREEN exactly as a verify reject does today.

The Critic reuses the verifier's verdict PARSER (the agent emits the same
``VERDICT: {...}`` JSON), so there is a single parse contract and no second
verdict grammar to drift. Running the critic agent (the model call) is thin
orchestration in the pipeline; that keeps this module deterministic and
unit-testable in isolation.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict

from agentrail.run.verifier import parse_verdict

# AC1: the default critic model is a fast, cheap tier (Haiku). The eval harness /
# runner config may override it via ``models.critic``; this is the fallback when
# none is configured.
CRITIC_DEFAULT_MODEL = "claude-haiku-4-5-20251001"


@dataclass(frozen=True)
class CriticVerdict:
    """The Critic's structured, falsifiable verdict (accept/reject + score + reason).

    ``accepted`` is the single bit the gate needs: ``True`` = the change and its
    tests genuinely satisfy the AC; ``False`` = rejected (gamed/skipped/out of
    scope/unverifiable). ``score`` is a [0, 1] confidence the reviewer assigns the
    candidate (``1.0`` accept, ``0.0`` reject) — the structured score AC1 asks for.
    ``reason`` is human-readable evidence for the run surface.
    """

    accepted: bool
    score: float
    reason: str = ""


def resolve_critic_model(configured: str | None) -> str:
    """Return the CHEAP critic model: the configured model, else the default (AC1).

    Pure. A non-empty configured model wins; a blank/``None`` value falls back to
    :data:`CRITIC_DEFAULT_MODEL` (a fast cheap tier), so the critic always runs on
    a cheap model rather than silently inheriting an expensive one.
    """
    model = (configured or "").strip()
    return model or CRITIC_DEFAULT_MODEL


def score_candidate(output: str) -> CriticVerdict:
    """Score a critic agent's output into a structured ``CriticVerdict`` (pure).

    Reuses the verifier's verdict parser (the critic emits the same
    ``VERDICT: {...}`` JSON), so there is ONE parse contract. Accept → ``score``
    ``1.0``; anything else — reject, no JSON, malformed JSON, unknown verdict, or
    empty output — is **fail-closed** to a REJECT (``score`` ``0.0``), so an
    unscored run can never silently reach done.
    """
    verdict = parse_verdict(output or "")
    return CriticVerdict(
        accepted=verdict.accepted,
        score=1.0 if verdict.accepted else 0.0,
        reason=verdict.reason,
    )


def gate_evidence(verdict: CriticVerdict) -> Dict[str, Any]:
    """Bridge a ``CriticVerdict`` to the ``verification_evidence`` the gate consumes.

    The independent review is always *required* once the critic ran (it is a
    blocking check), so this always sets ``required=True`` and reports ``valid``
    from the verdict's acceptance — the SAME shape ``verifier.gate_evidence``
    produces, so the Objective Gate is byte-identical (AC2). A REJECT
    (``valid=False``) makes the gate refuse GREEN exactly as a verify reject does.
    """
    return {
        "required": True,
        "valid": bool(verdict.accepted),
        "reason": verdict.reason,
    }
