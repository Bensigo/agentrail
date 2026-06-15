# ADR 0010: Execution-only autonomy — the agent never selects its own work

## Status

Accepted

## Context

"Autonomous agent" often means goal-seeking: the agent inspects a repo or a
"vision" and decides *what* to work on next. That causes goal drift and creates
real safety risk (an agent that picks its own objectives can wander into
destructive or out-of-scope actions, leak credentials, or push to production).

## Decision

AgentRail's autonomy is **execution-only**. Humans — or **Code Review**
suggestions a human converts — create issues. The **Issue Queue** holds them. The
agent decides only *how* to complete each issue; it never selects its own work.

- The **Heartbeat** dispatches queued issues and stops when the queue is empty.
- Per-run drift is caught by issue scope plus **Independent Verification** (a
  change that edits unrelated areas fails verification).

Goal drift is therefore **designed out**, not detected — the agent cannot drift
from a vision it was never given.

## Consequences

- Vision-level drift cannot happen; the blast radius is bounded to one
  well-scoped issue at a time.
- Safer to position and sell as "safe to leave unattended."
- AgentRail is **not** a "give it your roadmap and walk away" product; it is
  "give it well-formed issues and walk away."
- Makes **issue quality** the single lever for cost, quality, *and* safety.
