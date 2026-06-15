# ADR 0011: Escalate-on-failure model cascade with compacted handoff and a Budget Leash

## Status

Accepted

## Context

Pinning the strong model (e.g. Opus) to a phase overpays on easy issues — in
practice the plan phase on Opus was ~33% of spend. We want difficulty-based model
selection without an upfront classifier. Prompt caches are model-scoped, so
switching models loses the warm cache — which constrains how escalation should
work.

## Decision

**Difficulty is revealed, not predicted.** Execute first on the cheap model. When
the **Objective Gate** fails and triggers a retry, escalate to the stronger model
with a **compacted failure handoff** — the goal, the cheap attempt's diff, and the
exact gate error — produced cheaply by the failing attempt itself (it already has
the context warm).

A **Budget Leash** bounds total spend per issue: a per-issue cost ceiling plus an
escalation-attempt limit. Exhausting it routes the issue to the
**Escalated-to-human** terminal state (ADR-adjacent: Run Outcome in CONTEXT.md),
never an infinite retry.

Escalation is modelled as an **Issue Queue** transition: re-enqueue at a higher
tier with the compacted handoff and a decremented budget.

## Consequences

- The strong model is paid for only on issues that proved hard.
- The escalation prompt is small and focused — and since the cache is cold across
  models anyway, minimizing what is sent is the correct lever.
- Often *higher* quality: the strong model debugs a concrete failure rather than
  solving from a blank slate.
- We accept a cold cache on escalation (escalation is rare, so the common cheap
  path stays warm).
- Compaction is lossy — it must preserve failure-relevant context (the error, the
  failing region, the attempt) or the strong model inherits the same blindness
  that failed the cheap one.
