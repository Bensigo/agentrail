"""In-sandbox Context Compiler enforcement — back-compat shim (issue #921).

The PURE part (``compute_token_delta``) moved to
``agentrail.guardrails.policies.sandbox_enforcement`` and the filesystem I/O
(``is_enforcement_enabled`` / ``record_bypass_event`` / ``count_bypass_events`` /
``install_sandbox_hooks``) moved to
``agentrail.guardrails.adapters.sandbox_enforcement``.  This module re-exports
both so every existing caller keeps working unchanged::

    from agentrail.run.sandbox_enforcement import (
        is_enforcement_enabled, install_sandbox_hooks, record_bypass_event,
        count_bypass_events, compute_token_delta,
    )

The decision semantics are identical — these names ARE the migrated objects
(re-exported, not re-implemented).  No decision logic remains here (AC4).
"""
from __future__ import annotations

# Pure metric — from the policy.
from agentrail.guardrails.policies.sandbox_enforcement import (  # noqa: F401
    compute_token_delta,
)

# Filesystem I/O — from the adapter.
from agentrail.guardrails.adapters.sandbox_enforcement import (  # noqa: F401
    count_bypass_events,
    install_sandbox_hooks,
    is_enforcement_enabled,
    record_bypass_event,
)

__all__ = [
    "is_enforcement_enabled",
    "install_sandbox_hooks",
    "record_bypass_event",
    "count_bypass_events",
    "compute_token_delta",
]
