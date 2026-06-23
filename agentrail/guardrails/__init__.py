"""AgentRail guardrails — one framework-neutral home for guardrail policy.

Guardrails implement the **Objective Gate**, **Review Gate**, **Red-Green
Proof**, and **Independent Verification** definitions of "done" / "quality"
(see ``CONTEXT.md``).  This package is the seam those policies register into so
they are reusable across harnesses and discoverable by agents/tooling.

Public seam
-----------
* :class:`Verdict` / :class:`VerdictStatus` — the result vocabulary.
* :class:`Guardrail` — the structural protocol every policy satisfies.
* :func:`list_guardrails` / :func:`register` / :func:`get_guardrail` — the
  registry.

Importing this package imports :mod:`agentrail.guardrails.policies`, which
registers every shipped guardrail, so::

    from agentrail.guardrails import list_guardrails
    list_guardrails()  # includes the output_enforcer guardrail

works out of the box (AC1).
"""
from __future__ import annotations

from agentrail.guardrails.base import Guardrail, Verdict, VerdictStatus
from agentrail.guardrails.registry import (
    get_guardrail,
    list_guardrails,
    register,
)

# Side-effect import: register every shipped policy so the registry is populated
# the moment `agentrail.guardrails` is imported.
from agentrail.guardrails import policies  # noqa: F401,E402

__all__ = [
    "Guardrail",
    "Verdict",
    "VerdictStatus",
    "get_guardrail",
    "list_guardrails",
    "register",
]
