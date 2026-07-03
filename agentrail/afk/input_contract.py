"""Issue Input-Contract validator — back-compat shim (issue #921).

The PURE decision logic moved to ``agentrail.guardrails.policies.input_contract``
(the framework-neutral guardrails package).  This module re-exports it so every
existing caller keeps working unchanged::

    from agentrail.afk.input_contract import (
        Validated, Rejected, Result, validate, admit_to_queue,
    )

The Input-Contract v2 checks (issue #1026) add three more entrance guards, whose
public surface is re-exported here too so callers using the ``afk`` import path
reach the same objects: :func:`screen_injection`, :func:`content_hash`,
:class:`WriterClass`, :class:`AdmissionLedger`, and :class:`Admission`.

The decision semantics are identical — these names ARE the migrated policy's
objects (re-exported, not re-implemented), so ``isinstance`` checks across the old
and new import paths line up exactly.  No decision logic remains here (AC4).
"""
from __future__ import annotations

from agentrail.guardrails.policies.input_contract import (  # noqa: F401
    Admission,
    AdmissionLedger,
    Rejected,
    Result,
    Validated,
    WriterClass,
    admit_to_queue,
    content_hash,
    screen_injection,
    validate,
)

__all__ = [
    "Validated",
    "Rejected",
    "Result",
    "validate",
    "admit_to_queue",
    "Admission",
    "AdmissionLedger",
    "WriterClass",
    "content_hash",
    "screen_injection",
]
