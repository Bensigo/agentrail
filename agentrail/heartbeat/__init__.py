"""The **Heartbeat** — the trigger layer that dispatches queued issues.

CONTEXT.md: the Heartbeat is *event-first* (issue labeled, CI fails on an open
PR) and dispatches from the **Issue Queue**; it stops when the queue is empty
(every issue is green or escalated to a human). It is the **capstone**: enabled
only after the **Objective Gate**, the **Budget Leash**, and the security
guardrail exist (ADR 0010).

This package is *thin orchestration* (verification-contract-architecture.md):
the dispatch decision is a pure function over the **Issue Queue** state machine
(``agentrail/afk/queue_state.py``) and entries enter through the Input-Contract
gate (``agentrail/afk/input_contract.py``). It reinvents neither — I/O (launching
a run, calling ``gh``) lives at the edges and is injectable for tests.
"""
