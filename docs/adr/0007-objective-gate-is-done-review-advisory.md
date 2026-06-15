# ADR 0007: The Objective Gate is "done"; code review is advisory

## Status

Accepted

## Context

Earlier AgentRail runs treated an LLM reviewer's verdict ("looks good") as the
signal that a run was complete. That signal is unfalsifiable — an LLM can always
say "done" — so the loop had no point at which it was forced to admit it was not
finished. The results were the classic failure modes: bad changes merged on an
opinion, and loops that spun or escalated without a defined stop. The same
disease appeared at the metric layer (a "savings" number that could only ever be
positive; see ADR 0009).

A loop you can leave unattended needs a definition of "done" that can come back
**negative**.

## Decision

A run's definition of done is the **Objective Gate**: tests, build, and lint
pass and the issue's acceptance criteria are met, evidenced by a **Red-Green
Proof** trail (ADR 0008). It is the only signal that says a run is complete.

LLM **Code Review** is **advisory only** — findings are surfaced as suggestions a
human can convert into issues on the dashboard. The **Review Gate** policy
checkpoint requires objective-gate and independent-verification evidence, not an
LLM verdict.

## Consequences

- The loop has a falsifiable stop condition and is safe to run unattended.
- Merges are backed by objective evidence, not model opinion.
- We give up the familiar "AI reviewer approves the merge" UX.
- Quality is now bounded by the quality of the issue's acceptance criteria. This
  is mitigated by ADR 0008 (anti-false-green roles) and an input contract: an
  issue cannot enter the **Issue Queue** without machine-checkable acceptance
  criteria.
