"""Declarative eval *arms* — pure configuration, no execution.

An **arm** is one configuration of the harness run against the same frozen
corpus tasks (``agentrail.evals.corpus``). It names the arm, records the on/off
state of each AgentRail layer, and pins the model + temperature. It carries no
execution, sandbox, or network logic — the runner module (built separately)
consumes these records and does the work.

The layers AgentRail stacks (CONTEXT.md / PRD §"Isolation by leave-one-out
ablation"):

    context      — context retrieval / packing
    routing      — model routing / escalation
    verify_gate  — the Objective Gate
    retry        — the retry loop
    guardrails   — the safety/existence guardrails

Two anchor arms are defined now:

    baseline()  — the Raw-Agent Baseline: every AgentRail layer OFF.
    full()      — every AgentRail layer ON.

Leave-one-out ablation (PRD): a layer's worth is ``full`` minus
``full-minus-<layer>`` on the same scorer. Adding such an arm is one
declarative call — ``full_minus("<layer>")`` — which differs from ``full`` by
exactly one disabled layer and holds the model, temperature, and every other
layer fixed. Adding a *new* layer to the harness means adding one name to
``LAYER_NAMES`` and one ``full_minus`` arm; the structure does the rest.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field, replace
from types import MappingProxyType
from typing import Dict, List, Mapping, Tuple

# The five AgentRail layers, in a fixed, documented order. Adding a new layer
# to the harness is a one-line change here (plus a ``Layers`` field).
LAYER_NAMES: Tuple[str, ...] = (
    "context",
    "routing",
    "verify_gate",
    "retry",
    "guardrails",
)

# The three NEW-flow layers (issue #980), in a fixed, documented order. These
# are the layers added by the warm-cache + cheap-critic flow:
#
#   critic     — the cheap-model independent reviewer (#977)
#   bestofn    — critic-gated best-of-N execute with early stopping (#979)
#   warmcache  — the warm shared-context cache prefix (#978)
#
# Unlike :data:`LAYER_NAMES`, these are NOT part of ``full`` today. ``critic``
# and ``bestofn`` are OPT-IN (they only activate when a critic model is
# configured), and ``warmcache`` is default-ON. So they are ablated relative to
# the NEW-FLOW arm (``new-flow-minus-<layer>``), never minused from ``full``.
NEW_FLOW_LAYERS: Tuple[str, ...] = (
    "critic",
    "bestofn",
    "warmcache",
)

# Pinned execution model + temperature. Held fixed across every arm so that
# leave-one-out ablation isolates a single layer and nothing else (PRD:
# "Everything else is held fixed: same model, same temperature, same limits").
PINNED_MODEL: str = "claude-sonnet-4-5"
PINNED_TEMPERATURE: float = 0.0

# The cheap CRITIC model the new-flow arm pins. Held fixed (and DIFFERENT from
# ``PINNED_MODEL``) so a critic command is actually built during the eval run —
# the critic/best-of-N layers are opt-in and only activate when a critic model
# is configured. Mirrors ``critic.CRITIC_DEFAULT_MODEL`` (a fast, cheap tier).
PINNED_CRITIC_MODEL: str = "claude-haiku-4-5-20251001"

# An immutable empty mapping reused as the default for arms with no extra
# (new-flow) layers, so ``full`` / ``baseline`` carry exactly ``{}`` and stay
# byte-identical to today (issue #980: do NOT change their meaning).
_NO_EXTRA_LAYERS: Mapping[str, bool] = MappingProxyType({})


@dataclass(frozen=True)
class Layers:
    """On/off state of each AgentRail layer. Pure data, immutable."""

    context: bool
    routing: bool
    verify_gate: bool
    retry: bool
    guardrails: bool

    def as_dict(self) -> Dict[str, bool]:
        """Map each layer name to its on/off flag (stable ``LAYER_NAMES`` order)."""
        return {name: getattr(self, name) for name in LAYER_NAMES}

    @classmethod
    def all_off(cls) -> "Layers":
        return cls(**{name: False for name in LAYER_NAMES})

    @classmethod
    def all_on(cls) -> "Layers":
        return cls(**{name: True for name in LAYER_NAMES})


@dataclass(frozen=True)
class Arm:
    """One declarative harness configuration. Pure data, immutable.

    Attributes:
        name: human-readable arm id (e.g. ``"baseline"``, ``"full"``,
            ``"full-minus-context"``, ``"new-flow"``).
        layers: on/off state of each AgentRail layer.
        model: the pinned model id (a key in the pricing table).
        temperature: the pinned sampling temperature.
        extra_layers: on/off state of the NEW-flow layers (issue #980): a
            mapping over :data:`NEW_FLOW_LAYERS`. EMPTY (``{}``) for ``baseline``
            and ``full`` so their meaning is unchanged. The new-flow arm sets
            every one ON; a leave-one-out arm flips exactly one OFF.
        critic_model: the cheap critic model the arm pins, or ``""`` when the
            arm does not run the critic (``baseline``/``full``). When set, the
            eval runner forwards it so a critic command is built — the trigger
            the opt-in critic / best-of-N layers need to activate.
    """

    name: str
    layers: Layers
    model: str = PINNED_MODEL
    temperature: float = PINNED_TEMPERATURE
    extra_layers: Mapping[str, bool] = field(default_factory=lambda: _NO_EXTRA_LAYERS)
    critic_model: str = ""


def baseline() -> Arm:
    """The Raw-Agent Baseline: the same agent with every AgentRail layer OFF."""
    return Arm(name="baseline", layers=Layers.all_off())


def full() -> Arm:
    """The full harness: every AgentRail layer ON."""
    return Arm(name="full", layers=Layers.all_on())


def full_minus(layer: str) -> Arm:
    """A leave-one-out arm: ``full`` with exactly one layer disabled.

    Differs from :func:`full` by precisely the named layer; model, temperature,
    and every other layer are held fixed. This is the one declarative entry the
    PRD requires for measuring a single layer's contribution.

    Raises:
        ValueError: if *layer* is not one of :data:`LAYER_NAMES`.
    """
    if layer not in LAYER_NAMES:
        raise ValueError(
            f"unknown layer {layer!r}; expected one of {', '.join(LAYER_NAMES)}"
        )
    base = full()
    ablated_layers = replace(base.layers, **{layer: False})
    return Arm(
        name=f"full-minus-{layer}",
        layers=ablated_layers,
        model=base.model,
        temperature=base.temperature,
    )


def ablation_arms() -> List[Arm]:
    """The leave-one-out ablation arms — one ``full-minus-<layer>`` per layer.

    A named, enumerable registry so the CLI and reporter can iterate every
    layer's ablation arm without hard-coding the layer list. Order follows
    :data:`LAYER_NAMES`, so a new layer is picked up automatically once its name
    is added there (PRD §"a new layer is evaluable by adding one ablation arm").

    Each arm differs from :func:`full` by exactly its one disabled layer and
    holds the model, temperature, and every other layer fixed (guaranteed by
    :func:`full_minus`).
    """
    return [full_minus(layer) for layer in LAYER_NAMES]


def all_arms() -> List[Arm]:
    """Every arm a complete leave-one-out eval runs: baseline, full, ablations.

    Order is ``baseline``, ``full``, then the per-layer ablation arms in
    :data:`LAYER_NAMES` order — the natural reading order of a report and the
    arm set the CLI runs by default.
    """
    return [baseline(), full(), *ablation_arms()]


# ---------------------------------------------------------------------------
# The NEW-FLOW arm (issue #980): full + critic + best-of-N + warm-cache, plus
# its three leave-one-out ablations.
# ---------------------------------------------------------------------------


def new_flow() -> Arm:
    """The new-flow arm: ``full`` PLUS the critic, best-of-N, and warm-cache layers.

    All five base AgentRail layers stay ON (so the new flow is a strict superset
    of ``full``); every NEW-flow layer (:data:`NEW_FLOW_LAYERS`) is enabled; and a
    cheap :data:`PINNED_CRITIC_MODEL` is pinned so the eval runner builds a critic
    command — without it the opt-in critic / best-of-N layers never activate. The
    model and temperature are held fixed to ``full`` so a new-flow-vs-``full``
    comparison isolates exactly the three new layers.
    """
    return Arm(
        name="new-flow",
        layers=Layers.all_on(),
        extra_layers=MappingProxyType({name: True for name in NEW_FLOW_LAYERS}),
        critic_model=PINNED_CRITIC_MODEL,
    )


def new_flow_minus(layer: str) -> Arm:
    """A leave-one-out arm: the new flow with exactly one NEW-flow layer disabled.

    Differs from :func:`new_flow` by precisely the named new-flow layer; the base
    layers, model, temperature, and critic model are all held fixed. This is the
    only way to ablate the opt-in critic / best-of-N layers and the default-on
    warm-cache layer — they cannot be "minused" from ``full`` (they are not in it,
    issue #980 design nuance).

    Raises:
        ValueError: if *layer* is not one of :data:`NEW_FLOW_LAYERS`.
    """
    if layer not in NEW_FLOW_LAYERS:
        raise ValueError(
            f"unknown new-flow layer {layer!r}; expected one of "
            f"{', '.join(NEW_FLOW_LAYERS)}"
        )
    base = new_flow()
    ablated = {name: (name != layer) for name in NEW_FLOW_LAYERS}
    return Arm(
        name=f"new-flow-minus-{layer}",
        layers=base.layers,
        model=base.model,
        temperature=base.temperature,
        extra_layers=MappingProxyType(ablated),
        critic_model=base.critic_model,
    )


def new_flow_ablation_arms() -> List[Arm]:
    """The new-flow leave-one-out arms — one ``new-flow-minus-<layer>`` per new layer.

    A named, enumerable registry (mirrors :func:`ablation_arms`) so the CLI and
    reporter iterate every new layer's ablation arm without hard-coding the list.
    Order follows :data:`NEW_FLOW_LAYERS`.
    """
    return [new_flow_minus(layer) for layer in NEW_FLOW_LAYERS]


def new_flow_arms() -> List[Arm]:
    """The new flow plus its per-layer ablations: ``new-flow`` then each minus arm.

    Order is ``new-flow`` followed by the per-new-layer ablation arms in
    :data:`NEW_FLOW_LAYERS` order — the arm set that gives the new-flow per-layer
    deltas every arm they need (issue #980 AC1/AC2).
    """
    return [new_flow(), *new_flow_ablation_arms()]


__all__ = [
    "LAYER_NAMES",
    "NEW_FLOW_LAYERS",
    "PINNED_MODEL",
    "PINNED_TEMPERATURE",
    "PINNED_CRITIC_MODEL",
    "Layers",
    "Arm",
    "baseline",
    "full",
    "full_minus",
    "ablation_arms",
    "all_arms",
    "new_flow",
    "new_flow_minus",
    "new_flow_ablation_arms",
    "new_flow_arms",
]

# Re-export for callers that prefer ``dataclasses.FrozenInstanceError`` checks
# without importing the stdlib module themselves.
FrozenInstanceError = dataclasses.FrozenInstanceError
