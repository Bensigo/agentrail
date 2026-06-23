"""Sandbox-enforcement guardrail — PURE policy (no file I/O).

Migrated (decision semantics unchanged) from
``agentrail/run/sandbox_enforcement.py`` for issue #921.  In-sandbox Context
Compiler enforcement blocks raw repo-wide search until the sandboxed agent has
queried the Context Compiler, and records every bypass attempt as an audit event.

This module holds only the **pure** parts:

* :func:`compute_token_delta` — the signed enforcement-vs-baseline token metric.
* :class:`SandboxEnforcementGuardrail` — the seam adapter: given an observed
  bypass count, ``PASS`` iff no bypass was attempted, else ``FAIL``.

What deliberately does NOT live here
------------------------------------
All filesystem I/O — reading the enforcement toggle from ``.agentrail/config.json``
(``is_enforcement_enabled``), appending/counting bypass JSONL events
(``record_bypass_event`` / ``count_bypass_events``), and installing the sandbox
hook script (``install_sandbox_hooks``) — lives in
:mod:`agentrail.guardrails.adapters.sandbox_enforcement` (AC2).  Importing this
module pulls in no ``subprocess``/``gh``/``git``/``pytest`` and no file I/O.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Union

from agentrail.guardrails.base import Verdict
from agentrail.guardrails.registry import register


def compute_token_delta(
    *,
    enforcement_on_tokens: Union[int, float],
    baseline_tokens: Union[int, float],
) -> Union[int, float]:
    """Return enforcement_on_tokens − baseline_tokens (signed).

    A negative result means enforcement cost *more* tokens than the baseline —
    this is intentionally representable so the metric is falsifiable and cannot
    be reported as a one-sided savings claim.
    """
    return enforcement_on_tokens - baseline_tokens


# ---------------------------------------------------------------------------
# Guardrail seam adapter (pure) — registered so `list_guardrails()` sees it.
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class SandboxEnforcementGuardrail:
    """Adapts the bypass-count metric to the :class:`Guardrail` protocol.

    Blocking guardrail.  Producing the count (reading the bypass JSONL) is I/O and
    lives in the adapter :mod:`agentrail.guardrails.adapters.sandbox_enforcement`;
    this guardrail's pure decision is over the *already-counted* attempts:
    ``PASS`` when no bypass of the context-enforcement sandbox was attempted
    (``bypass_count == 0``), else ``FAIL`` reporting the count.
    ``evaluate(bypass_count=N)``.
    """

    name: str = "sandbox_enforcement"
    description: str = (
        "Enforces in-sandbox Context Compiler use: a run that bypassed the "
        "context-enforcement hook (any recorded bypass attempt) fails."
    )
    blocking: bool = True

    def evaluate(self, **kwargs: object) -> Verdict:
        bypass_count = int(kwargs.get("bypass_count", 0) or 0)
        if bypass_count > 0:
            return Verdict.failing(
                f"{bypass_count} context-enforcement bypass attempt(s) recorded"
            )
        return Verdict.passing()


# Register the singleton instance at import time so `list_guardrails()` sees it.
SANDBOX_ENFORCEMENT_GUARDRAIL = register(SandboxEnforcementGuardrail())
