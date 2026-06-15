# ADR 0009: The operations console shows only falsifiable metrics; "savings" is a separate dated benchmark

## Status

Accepted

## Context

The console displayed a one-sided "savings" number — a counterfactual against an
imagined worst case that could never go negative. It showed the product "winning"
while real spend rose, which is what first surfaced the trust problem: a metric
that cannot fail is a mirror, not a measurement.

## Decision

The **Agent Operations Console** shows only **falsifiable** metrics — numbers
that can come back negative:

- **Cost-per-Issue-to-Green**, **accept rate**, **Objective Gate** /
  **Independent Verification** pass-fail, **escalation rate**, **cache
  read-to-creation ratio**, and **security flags**.

The Runs view stays. The one-sided savings number is **removed**.

The "20–30% vs **Raw-Agent Baseline**" cost claim is a **separate, dated
validation-benchmark surface**, never a live per-run ticker — because the
raw-agent arm is not run in production (running it would double customer cost).
Live operational cost and the periodic vs-raw-agent comparison live on different
surfaces.

Rule of thumb: **no number on the operations console that cannot come back
negative.** If it can't fail, it's marketing, not a metric.

## Consequences

- The dashboard becomes trustworthy: every displayed number can fail, so each one
  means something.
- We lose the always-positive "savings" figure from the live console.
- Forces honest instrumentation (e.g. metering cache-write cost, which was
  previously dropped).
- Requires a **dashboard redesign**: remove the savings widget; add connector,
  trigger/heartbeat, and queue views (see the implementation plan).
