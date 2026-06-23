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
from dataclasses import dataclass, replace
from typing import Dict, List, Tuple

# The five AgentRail layers, in a fixed, documented order. Adding a new layer
# to the harness is a one-line change here (plus a ``Layers`` field).
LAYER_NAMES: Tuple[str, ...] = (
    "context",
    "routing",
    "verify_gate",
    "retry",
    "guardrails",
)

# Pinned execution model + temperature. Held fixed across every arm so that
# leave-one-out ablation isolates a single layer and nothing else (PRD:
# "Everything else is held fixed: same model, same temperature, same limits").
PINNED_MODEL: str = "claude-sonnet-4-5"
PINNED_TEMPERATURE: float = 0.0


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
            ``"full-minus-context"``).
        layers: on/off state of each AgentRail layer.
        model: the pinned model id (a key in the pricing table).
        temperature: the pinned sampling temperature.
    """

    name: str
    layers: Layers
    model: str = PINNED_MODEL
    temperature: float = PINNED_TEMPERATURE


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


__all__ = [
    "LAYER_NAMES",
    "PINNED_MODEL",
    "PINNED_TEMPERATURE",
    "Layers",
    "Arm",
    "baseline",
    "full",
    "full_minus",
    "ablation_arms",
    "all_arms",
]

# Re-export for callers that prefer ``dataclasses.FrozenInstanceError`` checks
# without importing the stdlib module themselves.
FrozenInstanceError = dataclasses.FrozenInstanceError
