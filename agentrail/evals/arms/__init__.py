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
    rerank       — the deterministic code-aware context rerank stage (#904/#1029)
    expansion    — the recall-layer query-expansion stage (#1043)
    memory_lane  — the factory-side shared-memory lane (#1039), default-ON

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

# The AgentRail layers, in a fixed, documented order. Adding a new layer to the
# harness is a one-line change here (plus a matching ``Layers`` field). Every
# leave-one-out derivation (``full_minus`` / ``ablation_arms`` / ``all_arms``)
# and the reporter's per-layer deltas iterate this tuple, so a new name here is
# picked up end-to-end automatically.
LAYER_NAMES: Tuple[str, ...] = (
    "context",
    "routing",
    "verify_gate",
    "retry",
    "guardrails",
    "rerank",
    "expansion",
    "memory_lane",
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

# The LLM listwise rerank layer (issue #1044 AC2). Like :data:`NEW_FLOW_LAYERS`
# this is an OPT-IN, model-dependent layer that is NOT part of ``full``: the
# Haiku listwise rerank (``agentrail.context.llm_rerank``) is default-OFF and
# only reorders when a headless ``claude`` binary is on PATH. It cannot be
# "minused" from ``full`` (it is not in it), so — exactly like the new-flow
# layers — it is A/B'd as a PLUS arm: ``full`` vs ``full-plus-llm_rerank``. It
# rides ``extra_layers`` (never a base :data:`LAYER_NAMES` field), so ``full`` /
# ``baseline`` stay byte-identical to today.
LLM_RERANK_LAYER: str = "llm_rerank"

# Three more OPT-IN, flag-gated context/pipeline layers that — exactly like
# :data:`LLM_RERANK_LAYER` — are default-OFF and NOT part of ``full``, so they
# are A/B'd as PLUS arms (``full`` vs ``full-plus-<layer>``) and ride
# ``extra_layers`` (never a base :data:`LAYER_NAMES` field). Each has a live
# resolver that keys on one env var (the runner's ``_arm_env`` bridge sets it):
#
#   cutoff          — adaptive pack-tail confidence cutoff (#1096), toggled by
#                     ``agentrail.context.retrieval.resolve_pack_cutoff`` reading
#                     ``AGENTRAIL_CONTEXT_PACK_CUTOFF``.
#   symbol_packing  — symbol-range pack windows (#1044 AC4), toggled by
#                     ``agentrail.context.packs.symbol_packing_enabled`` reading
#                     ``AGENTRAIL_CONTEXT_SYMBOL_PACKING``.
#   gather          — the JIT read-only context-gatherer phase (#1049), toggled
#                     by ``agentrail.run.pipeline.jit_gather_enabled`` reading
#                     ``AGENTRAIL_JIT_GATHER`` AND requiring a cheap gather model
#                     (``AGENTRAIL_EVAL_GATHER_MODEL``) so the phase actually fires.
CUTOFF_LAYER: str = "cutoff"
SYMBOL_PACKING_LAYER: str = "symbol_packing"
GATHER_LAYER: str = "gather"

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

# The cheap model the LLM-rerank arm pins for its listwise reorder. Held fixed
# (a fast, cheap tier — the SAME Haiku tier the live stage defaults to, mirroring
# ``agentrail.context.llm_rerank.LLM_RERANK_DEFAULT_MODEL``) so the ``full`` vs
# ``full-plus-llm_rerank`` A/B toggles ONLY the layer, never the reranker's model.
PINNED_LLM_RERANK_MODEL: str = "claude-haiku-4-5-20251001"

# The cheap model the GATHER arm pins for its read-only context-gatherer phase.
# The gather phase runs ONLY when ``AGENTRAIL_JIT_GATHER=1`` AND a gather model
# is opted in (``AGENTRAIL_EVAL_GATHER_MODEL``), and the model MUST differ from
# the implementer's :data:`PINNED_MODEL` — a same-model gatherer trips the
# independence guard in ``resolve_gather_command`` and silently returns "" (no
# phase). Held fixed to the SAME cheap Haiku tier the live phase defaults to
# (mirroring ``agentrail.run.critic.GATHER_DEFAULT_MODEL``) so ``full`` vs
# ``full-plus-gather`` toggles ONLY the phase, never its model.
PINNED_GATHER_MODEL: str = "claude-haiku-4-5-20251001"

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
    rerank: bool
    expansion: bool
    memory_lane: bool

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
        extra_layers: on/off state of the opt-in, model-dependent layers that
            are NOT part of ``full``: the NEW-flow layers (issue #980,
            :data:`NEW_FLOW_LAYERS`) and the LLM listwise rerank layer (issue
            #1044, :data:`LLM_RERANK_LAYER`). EMPTY (``{}``) for ``baseline`` and
            ``full`` so their meaning is unchanged. The new-flow arm sets every
            new-flow layer ON (a leave-one-out arm flips exactly one OFF); the
            ``full-plus-llm_rerank`` arm sets exactly ``{llm_rerank: True}``.
        critic_model: the cheap critic model the arm pins, or ``""`` when the
            arm does not run the critic (``baseline``/``full``). When set, the
            eval runner forwards it so a critic command is built — the trigger
            the opt-in critic / best-of-N layers need to activate.
        gather_model: the cheap gather model the arm pins, or ``""`` when the arm
            does not run the JIT gatherer (everything but ``full-plus-gather``).
            When set, the eval runner forwards it via ``AGENTRAIL_EVAL_GATHER_MODEL``
            so a gather command is built — the trigger (alongside
            ``AGENTRAIL_JIT_GATHER=1``) the opt-in gather phase needs to fire.
    """

    name: str
    layers: Layers
    model: str = PINNED_MODEL
    temperature: float = PINNED_TEMPERATURE
    extra_layers: Mapping[str, bool] = field(default_factory=lambda: _NO_EXTRA_LAYERS)
    critic_model: str = ""
    gather_model: str = ""


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

    Every base AgentRail layer stays ON (so the new flow is a strict superset
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


# ---------------------------------------------------------------------------
# The LLM-rerank A/B arm (issue #1044 AC2): ``full`` PLUS the opt-in Haiku
# listwise rerank, paired against plain ``full`` (rerank OFF).
# ---------------------------------------------------------------------------


def llm_rerank_arm() -> Arm:
    """``full`` PLUS the opt-in LLM listwise rerank layer (issue #1044 AC2).

    Every base AgentRail layer stays ON (a strict superset of ``full``) and the
    LLM-rerank layer is switched ON via ``extra_layers`` (``{llm_rerank: True}``).
    Model and temperature are held fixed to ``full`` so a ``full`` vs this
    comparison isolates exactly the LLM rerank. Like the new-flow layers this is
    opt-in and model-dependent — it only reorders when a headless ``claude``
    binary is available (:func:`agentrail.context.llm_rerank.llm_rerank_model_path_available`)
    — so it is a PLUS arm, never a ``full-minus`` (it is not in ``full``).
    """
    base = full()
    return Arm(
        name=f"full-plus-{LLM_RERANK_LAYER}",
        layers=base.layers,
        model=base.model,
        temperature=base.temperature,
        extra_layers=MappingProxyType({LLM_RERANK_LAYER: True}),
    )


def llm_rerank_arms() -> List[Arm]:
    """The LLM-rerank A/B pair: ``full`` (rerank OFF) vs ``full-plus-llm_rerank`` (ON).

    The OFF arm is plain :func:`full` — the LLM rerank is default-OFF and ``full``
    carries no ``llm_rerank`` extra layer, so it retrieves WITHOUT the listwise
    reorder. The ON arm (:func:`llm_rerank_arm`) adds exactly the LLM-rerank
    layer. Reporting the ``fileNDCG`` (issue #1088 rank-aware metric) of each is
    the AC2 A/B: the LLM rerank is a membership-preserving ORDERING change, so
    nDCG is the only metric it can move — precision/recall are set-based and
    cannot see a reorder.
    """
    return [full(), llm_rerank_arm()]


# ---------------------------------------------------------------------------
# Three more PLUS A/B arms — cutoff (#1096), symbol-packing (#1044 AC4), and
# gather (#1049). Each mirrors :func:`llm_rerank_arm` exactly: ``full`` PLUS the
# one opt-in layer switched ON via ``extra_layers``, paired against plain
# ``full`` (layer OFF). Model/temperature are held fixed to ``full`` so a
# ``full`` vs ``full-plus-<layer>`` comparison isolates exactly that layer.
# ---------------------------------------------------------------------------


def cutoff_arm() -> Arm:
    """``full`` PLUS the adaptive pack-tail confidence cutoff (issue #1096).

    Every base AgentRail layer stays ON (a strict superset of ``full``) and the
    cutoff layer is switched ON via ``extra_layers`` (``{cutoff: True}``). The
    runner's ``_arm_env`` bridges this to ``AGENTRAIL_CONTEXT_PACK_CUTOFF=1``,
    the only flag ``agentrail.context.retrieval.resolve_pack_cutoff`` reads —
    default-OFF, so ``full`` (which carries no cutoff extra layer) packs without
    the tail trim and the A/B toggles ONLY the cutoff.
    """
    base = full()
    return Arm(
        name=f"full-plus-{CUTOFF_LAYER}",
        layers=base.layers,
        model=base.model,
        temperature=base.temperature,
        extra_layers=MappingProxyType({CUTOFF_LAYER: True}),
    )


def cutoff_arms() -> List[Arm]:
    """The cutoff A/B pair: ``full`` (cutoff OFF) vs ``full-plus-cutoff`` (ON)."""
    return [full(), cutoff_arm()]


def symbol_packing_arm() -> Arm:
    """``full`` PLUS the symbol-range pack windows (issue #1044 AC4).

    Every base AgentRail layer stays ON (a strict superset of ``full``) and the
    symbol-packing layer is switched ON via ``extra_layers``
    (``{symbol_packing: True}``). The runner's ``_arm_env`` bridges this to
    ``AGENTRAIL_CONTEXT_SYMBOL_PACKING=1``, the only flag
    ``agentrail.context.packs.symbol_packing_enabled`` reads — default-OFF, so
    ``full`` packs by line window and the A/B toggles ONLY symbol packing.
    """
    base = full()
    return Arm(
        name=f"full-plus-{SYMBOL_PACKING_LAYER}",
        layers=base.layers,
        model=base.model,
        temperature=base.temperature,
        extra_layers=MappingProxyType({SYMBOL_PACKING_LAYER: True}),
    )


def symbol_packing_arms() -> List[Arm]:
    """The symbol-packing A/B pair: ``full`` (OFF) vs ``full-plus-symbol_packing`` (ON)."""
    return [full(), symbol_packing_arm()]


def gather_arm() -> Arm:
    """``full`` PLUS the JIT read-only context-gatherer phase (issue #1049).

    Every base AgentRail layer stays ON (a strict superset of ``full``) and the
    gather layer is switched ON via ``extra_layers`` (``{gather: True}``). Unlike
    the other PLUS arms, the gather phase needs TWO triggers, both bridged by the
    runner's ``_arm_env``: ``AGENTRAIL_JIT_GATHER=1`` (read by
    ``agentrail.run.pipeline.jit_gather_enabled``) AND a cheap gather model — a
    pinned :data:`PINNED_GATHER_MODEL` forwarded as ``AGENTRAIL_EVAL_GATHER_MODEL``
    (read by ``resolve_gather_command``). Without the model the phase resolves to
    "" and never fires. The pinned model is a cheap Haiku tier that DIFFERS from
    the implementer's :data:`PINNED_MODEL` so it clears the independence guard.
    ``full`` carries neither trigger, so the A/B toggles ONLY the gather phase.
    """
    base = full()
    return Arm(
        name=f"full-plus-{GATHER_LAYER}",
        layers=base.layers,
        model=base.model,
        temperature=base.temperature,
        extra_layers=MappingProxyType({GATHER_LAYER: True}),
        gather_model=PINNED_GATHER_MODEL,
    )


def gather_arms() -> List[Arm]:
    """The gather A/B pair: ``full`` (gather OFF) vs ``full-plus-gather`` (ON)."""
    return [full(), gather_arm()]


__all__ = [
    "LAYER_NAMES",
    "NEW_FLOW_LAYERS",
    "LLM_RERANK_LAYER",
    "CUTOFF_LAYER",
    "SYMBOL_PACKING_LAYER",
    "GATHER_LAYER",
    "PINNED_MODEL",
    "PINNED_TEMPERATURE",
    "PINNED_CRITIC_MODEL",
    "PINNED_LLM_RERANK_MODEL",
    "PINNED_GATHER_MODEL",
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
    "llm_rerank_arm",
    "llm_rerank_arms",
    "cutoff_arm",
    "cutoff_arms",
    "symbol_packing_arm",
    "symbol_packing_arms",
    "gather_arm",
    "gather_arms",
]

# Re-export for callers that prefer ``dataclasses.FrozenInstanceError`` checks
# without importing the stdlib module themselves.
FrozenInstanceError = dataclasses.FrozenInstanceError
