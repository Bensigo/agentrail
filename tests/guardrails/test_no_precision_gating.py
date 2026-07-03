"""AC5 (#1037): ``precision_at_budget`` is absent from every gating code path.

The label-share ``precision_at_budget`` proxy is gameable (a rerank that trims
filler to a smaller, more relevant pack LOWERS it), so it must never decide
whether a run passes. This test locks two structural facts so a future change
cannot quietly wire it back into a gate:

1. The guardrails :class:`~agentrail.guardrails.signals.Signals` — the SOLE input
   every gating policy reads — has no precision / precision_at_budget field. A
   policy therefore *cannot* read the value even by accident.
2. No module under ``agentrail.guardrails`` (policies + adapters + the gate
   entrypoints) so much as mentions ``precision_at_budget``.

It survives only as a labeled diagnostic in
:mod:`agentrail.context.pack_quality` / on the dashboard.
"""
from __future__ import annotations

import dataclasses
import importlib
import inspect
import pkgutil

import agentrail.guardrails as guardrails_pkg
from agentrail.guardrails.signals import Signals


def test_signals_has_no_precision_field():
    field_names = {f.name for f in dataclasses.fields(Signals)}
    offenders = {n for n in field_names if "precision" in n.lower()}
    assert offenders == set(), (
        "Signals gained a precision field; a gate could now read "
        f"precision_at_budget. Offending fields: {offenders}"
    )


def _all_guardrail_modules():
    """Every importable module under the agentrail.guardrails package tree."""
    seen = {}
    for info in pkgutil.walk_packages(
        guardrails_pkg.__path__, prefix=f"{guardrails_pkg.__name__}."
    ):
        try:
            seen[info.name] = importlib.import_module(info.name)
        except Exception:
            # A module that fails to import cannot gate on anything; skip it.
            continue
    return seen


def test_no_guardrail_module_references_precision_at_budget():
    offenders = []
    for name, module in _all_guardrail_modules().items():
        try:
            source = inspect.getsource(module)
        except (OSError, TypeError):
            continue
        if "precision_at_budget" in source or "precision_at_budget" in name:
            offenders.append(name)
    assert offenders == [], (
        "precision_at_budget leaked into a guardrails module; it must never "
        f"gate a run (AC5). Offenders: {offenders}"
    )
