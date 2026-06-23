"""Pricing adapter for the eval harness (issue #934).

CONTEXT.md rail: the eval *never* hard-codes prices. Every dollar figure the
reporter produces routes through this adapter, which delegates to the single
source of truth — ``agentrail.run.pricing.cost_usd``. This module exists so the
reporter has one obvious seam for cost, and so a single parity test
(``usage_cost(u) == cost_usd(u)``) proves the eval's dollars stay consistent
with the rest of the system.

Deliberately trivial: any cleverness here would be a place for the eval's cost
to drift from production cost. The adapter is a pass-through by design.
"""

from __future__ import annotations

from agentrail.run.pricing import cost_usd


def usage_cost(usage: object) -> float:
    """Return the USD cost of *usage*, delegating to the single-source pricer.

    *usage* must expose the same attributes ``cost_usd`` reads
    (``.model``, ``.input_tokens``, ``.output_tokens``, ``.cache_tokens``, and
    optionally ``.cache_creation_tokens``) — i.e. the ``Usage`` dataclass from
    ``agentrail.run.usage_capture``.
    """
    return cost_usd(usage)
