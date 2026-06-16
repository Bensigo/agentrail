"""Cost-aware model routing: identify cheaper same-family models, and the
escalate-on-failure model cascade (ADR 0011, M036).

Two concerns live here, both about *which model runs*:

1. **Cost recommendation** (the original): given a Usage record and a phase name,
   compute whether a cheaper same-family model could have run the same token
   budget at lower cost, and by how much (overspend_usd). Ladders (expensive →
   cheap): claude fable-5 → opus → sonnet → haiku; gpt gpt-5/o3 → gpt-4o →
   gpt-4o-mini/o4-mini. Only same-family, next-tier-down recommendations; no
   cross-family (Claude ↔ GPT).

2. **Escalate-on-failure cascade** (M036, the ``escalate_on_failure`` section
   below): difficulty is *revealed, not predicted* — execute first on the CHEAP
   tier; on an **Objective Gate** failure WITH budget left, escalate to the
   STRONGER tier carrying a compacted failure handoff. The decision is the
   **Budget Leash** (``budget_leash.check``); the escalation itself is an **Issue
   Queue** transition (``queue_state.transition``); the handoff is built by the
   **Compaction / Failure-Handoff builder** (``compaction.build``). This module
   composes those three rather than rolling its own retry loop.
"""
from __future__ import annotations

import json
import warnings
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Optional, Tuple

from agentrail.afk.queue_state import (
    Event,
    MAX_TIER,
    QueueEntry,
    Terminal,
    Tier,
    is_terminal,
    transition,
)
from agentrail.run import budget_leash, compaction
from agentrail.run.budget_leash import Decision
from agentrail.run.compaction import FailureHandoff, GateError
from agentrail.run.pricing import PRICES

# ---------------------------------------------------------------------------
# Family ladders: list of (tier_keyword, canonical_model) ordered expensive → cheap.
# canonical_model is the representative for that tier; it MUST exist in PRICES.
# ---------------------------------------------------------------------------
_CLAUDE_LADDER: list[Tuple[str, str]] = [
    ("fable",  "claude-fable-5"),
    ("opus",   "claude-opus-4-8"),
    ("sonnet", "claude-sonnet-4-6"),
    ("haiku",  "claude-haiku-4-5"),
]

_GPT_LADDER: list[Tuple[str, str]] = [
    ("gpt-top",   "gpt-5"),
    ("gpt-mid",   "gpt-4o"),
    ("gpt-cheap", "gpt-4o-mini"),
]

_LADDERS: dict[str, list[Tuple[str, str]]] = {
    "claude": _CLAUDE_LADDER,
    "gpt":    _GPT_LADDER,
}


def _classify_claude(model: str) -> Optional[int]:
    """Return tier index (0=fable, 1=opus, 2=sonnet, 3=haiku) or None."""
    m = model.lower()
    if "fable" in m:
        return 0
    if "opus" in m:
        return 1
    if "sonnet" in m:
        return 2
    if "haiku" in m:
        return 3
    return None


def _classify_gpt(model: str) -> Optional[int]:
    """Return tier index (0=top, 1=mid, 2=cheap) or None.

    gpt-4o-mini must be checked before gpt-4o to avoid prefix collision.
    """
    m = model.lower()
    if "gpt-4o-mini" in m or "o4-mini" in m:
        return 2
    if "gpt-4o" in m:
        return 1
    if "gpt-5" in m or m == "o3" or m.startswith("o3-"):
        return 0
    return None


def classify(model: str) -> Optional[Tuple[str, int]]:
    """Return (family, tier_index) for *model*, or None if unclassifiable.

    family is ``'claude'`` or ``'gpt'``; tier_index 0 = most expensive.
    """
    if not model:
        return None
    m = model.lower()
    if any(kw in m for kw in ("fable", "claude", "opus", "sonnet", "haiku")):
        tier = _classify_claude(model)
        if tier is not None:
            return ("claude", tier)
    if any(kw in m for kw in ("gpt", "o3", "o4")):
        tier = _classify_gpt(model)
        if tier is not None:
            return ("gpt", tier)
    return None


def cheaper_model(model: str) -> Optional[str]:
    """Return the canonical model for the next-cheaper tier, or None.

    Returns None when *model* is already the cheapest in its family, when it
    cannot be classified, or when it is unknown.
    """
    result = classify(model)
    if result is None:
        return None
    family, tier = result
    ladder = _LADDERS[family]
    next_tier = tier + 1
    if next_tier >= len(ladder):
        return None
    return ladder[next_tier][1]


def cost_for_model(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_tokens: int,
) -> float:
    """Reprice a token breakdown at *model*'s rates.

    Returns 0.0 and emits a UserWarning when the model is not in PRICES.
    """
    rates = PRICES.get(model)
    if rates is None:
        warnings.warn(
            f"routing: unknown model {model!r} — cannot reprice",
            UserWarning,
            stacklevel=2,
        )
        return 0.0
    return (
        input_tokens  * rates.input
        + output_tokens * rates.output
        + cache_tokens  * rates.cache
    ) / 1_000_000


def routing_record(usage: object, phase: str = "execute") -> Optional[dict]:
    """Build a model_routing dict for *usage* or return None.

    Returns None when:
    - the used model is not in PRICES (emits UserWarning naming the model)
    - no cheaper same-family model exists (model already cheapest)
    - overspend_usd <= 0

    Returned dict keys: phase, model_used, cheaper_model, tokens,
    cost_used_usd, cost_cheaper_usd, overspend_usd.
    """
    model: str = getattr(usage, "model", "")
    input_tokens: int = getattr(usage, "input_tokens", 0)
    output_tokens: int = getattr(usage, "output_tokens", 0)
    cache_tokens: int = getattr(usage, "cache_tokens", 0)

    if not model:
        warnings.warn(
            "routing: empty model name — no routing recommendation",
            UserWarning,
            stacklevel=2,
        )
        return None

    if model not in PRICES:
        warnings.warn(
            f"routing: unknown model {model!r} — no routing recommendation",
            UserWarning,
            stacklevel=2,
        )
        return None

    alt = cheaper_model(model)
    if alt is None:
        return None  # already cheapest in its family

    if alt not in PRICES:
        warnings.warn(
            f"routing: cheaper model {alt!r} not in PRICES — skipping recommendation",
            UserWarning,
            stacklevel=2,
        )
        return None

    cost_used = cost_for_model(model, input_tokens, output_tokens, cache_tokens)
    cost_alt  = cost_for_model(alt,   input_tokens, output_tokens, cache_tokens)
    overspend = cost_used - cost_alt

    if overspend <= 0:
        return None

    return {
        "phase":            phase,
        "model_used":       model,
        "cheaper_model":    alt,
        "tokens":           input_tokens + output_tokens + cache_tokens,
        "cost_used_usd":    round(cost_used, 8),
        "cost_cheaper_usd": round(cost_alt,  8),
        "overspend_usd":    round(overspend, 8),
    }


def _apply_routing(rec: dict, target: Path, agent: str) -> bool:
    """Write runners.<agent>.models.<phase> = cheaper_model to .agentrail/config.json.

    Idempotent: no-op when the configured model is already the cheaper model
    or a cheaper tier in the same family. Returns True if updated, False if
    already at that model or cheaper.
    """
    phase = rec["phase"]
    rec_model = rec["cheaper_model"]

    config_path = target / ".agentrail" / "config.json"
    cfg: dict = {}
    if config_path.exists():
        try:
            cfg = json.loads(config_path.read_text())
        except (ValueError, OSError):
            cfg = {}

    runners = cfg.setdefault("runners", {})
    runner_cfg = runners.setdefault(agent, {})
    models_map = runner_cfg.setdefault("models", {})
    current = models_map.get(phase, "")

    if current:
        rec_cls = classify(rec_model)
        cur_cls = classify(current)
        if rec_cls and cur_cls and cur_cls[0] == rec_cls[0]:
            # Same family: if current is at same tier or cheaper tier, no-op.
            if cur_cls[1] >= rec_cls[1]:
                return False
        elif current == rec_model:
            return False

    models_map[phase] = rec_model
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps(cfg, indent=2))
    return True


# ---------------------------------------------------------------------------
# Escalate-on-failure cascade (ADR 0011, M036).
#
# Cheap-first execution: the first attempt runs on the CHEAP tier (AC1). When the
# Objective Gate comes back red WITH budget remaining, escalate to the STRONGER
# tier (AC2) carrying a compacted failure handoff (AC2/AC3). The decision is the
# Budget Leash; the escalation is a queue transition; the handoff is built by the
# Compaction builder. Pure: no agent calls, no I/O — the caller supplies the
# already-computed spend/attempts and the gate's failure reasons.
# ---------------------------------------------------------------------------


def next_tier(tier: Tier) -> Optional[Tier]:
    """Return the next stronger tier above ``tier``, or ``None`` at the max tier.

    Pure. Escalation steps strictly up the tier ladder (cheap → strong); the
    strongest tier has nowhere to escalate to, so this returns ``None`` and the
    cascade hard-stops to human (consistent with ``queue_state``'s max-tier stop).
    """
    if tier >= MAX_TIER:
        return None
    return Tier(int(tier) + 1)


@dataclass(frozen=True)
class EscalationOutcome:
    """The result of one escalate-on-failure routing step.

    - ``decision`` — the Budget Leash verdict (CONTINUE / ESCALATE / STOP_TO_HUMAN).
    - ``entry`` — the next **Issue Queue** entry: re-enqueued one tier up on an
      escalation, moved to the ``ESCALATED_TO_HUMAN`` terminal on a hard stop, or
      returned unchanged when continuing on the current tier.
    - ``handoff`` — the compacted failure handoff the stronger model receives on an
      escalation; ``None`` when no escalation happened (continue or stop-to-human),
      since there is no next attempt to hand off to.
    """

    decision: Decision
    entry: QueueEntry
    handoff: Optional[FailureHandoff]


def escalate_on_failure(
    *,
    entry: QueueEntry,
    spent: float,
    ceiling: float,
    attempt_limit: int,
    attempts: int,
    gate_red: bool,
    goal: str,
    attempt_diff: str,
    gate_error: GateError,
    exploration: str = "",
) -> EscalationOutcome:
    """Route one attempt's outcome: continue, escalate cheap→strong, or stop.

    Pure. Composes the three reused deep modules:

    1. ``budget_leash.check`` decides CONTINUE / ESCALATE / STOP_TO_HUMAN from the
       spend, attempts, ceiling, attempt limit, and whether the gate is red.
    2. On ESCALATE, ``queue_state.transition(entry, GATE_RED)`` performs the
       escalation as a queue transition — re-enqueue at the next tier with a
       decremented budget. If the entry is already on the max tier (no tier
       above), that same transition hard-stops to ``ESCALATED_TO_HUMAN`` instead
       of fabricating a tier.
    3. ``compaction.build`` builds the compacted failure handoff (goal + attempt
       diff + exact gate error, dropping redundant exploration) that the stronger
       model receives.

    On CONTINUE the entry is returned unchanged with no handoff. On STOP_TO_HUMAN
    the entry is moved to the ``ESCALATED_TO_HUMAN`` terminal (via the queue
    transition) with no handoff — there is no further attempt to hand off to.

    Args:
        entry: the current **Issue Queue** entry (carries tier + remaining budget).
        spent, ceiling, attempt_limit, attempts, gate_red: the Budget Leash inputs.
        goal, attempt_diff, gate_error, exploration: the Compaction builder inputs;
            only consulted when an escalation actually happens.

    Returns:
        An :class:`EscalationOutcome` carrying the decision, the next entry, and
        the handoff (only on a real escalation).
    """
    decision = budget_leash.check(
        spent=spent,
        attempts=attempts,
        ceiling=ceiling,
        attempt_limit=attempt_limit,
        gate_red=gate_red,
    )

    if decision is Decision.CONTINUE:
        return EscalationOutcome(decision=decision, entry=entry, handoff=None)

    if decision is Decision.STOP_TO_HUMAN:
        # Hard stop: route to the ESCALATED_TO_HUMAN terminal with state
        # preserved (AC5). The Budget Leash is the authority for this stop because
        # it consulted the real per-issue dollar ceiling and the escalation-attempt
        # limit; the queue entry's own integer budget is a coarser proxy, so we set
        # the terminal directly rather than re-deriving it from the transition.
        stopped = replace(entry, state=Terminal.ESCALATED_TO_HUMAN)
        return EscalationOutcome(decision=decision, entry=stopped, handoff=None)

    # decision is ESCALATE: re-enqueue one tier up via the queue transition. If
    # there is no tier above (already on max), the transition itself hard-stops to
    # ESCALATED_TO_HUMAN — we never fabricate a tier. The handoff is only built
    # when an escalation actually re-enqueues a stronger attempt.
    escalated = transition(entry, Event.GATE_RED)
    if is_terminal(escalated.state) or escalated.tier == entry.tier:
        # No real tier increase happened (max tier already): nothing to hand off.
        return EscalationOutcome(decision=decision, entry=escalated, handoff=None)

    handoff = compaction.build(
        goal=goal,
        attempt_diff=attempt_diff,
        gate_error=gate_error,
        exploration=exploration,
    )
    return EscalationOutcome(decision=decision, entry=escalated, handoff=handoff)
