# The Change Record — Design (Arc D)

**Date:** 2026-07-31
**Status:** Directional — approved shape; refinement pass when its build starts (after A–C evidence shapes are live; builds on the evidence capability layer once its open PRs land)
**Scope:** A canonical, persistent object representing a software change across its whole lifecycle; console view; PR-comment summary
**Prior art:** the evidence capability layer (registry/envelope/adapters — in-flight PRs #1507–#1509, #1521); Arc A's keyed review objects; Arc C's `ac_evidence.json`.
**Non-goals:** replacing GitHub as the system of record for code; the learning loop itself (Arc E attaches to this object); dashboards-for-dashboards (every surface here answers "why should I trust this change").

## Judgment removed

- **Merge confidence** — "Why should I trust this PR?" is answered by one
  artifact, not reconstructed by a human across five tabs.
- **Requirements understanding** — the requirement→shipped traceability is
  standing, so "what was this for?" never needs archaeology.
- **Production risk** (post-merge) — the record keeps living: outcome
  attaches to the same object the decision was made on.

## Problem

Evidence exists but is scattered and mortal: ACs on an issue, bindings in
run artifacts, review judgment in a PR comment, QA in a chat transcript,
outcome nowhere. The PR closes and the trail evaporates — which is why the
memo's question ("why should I trust this PR?") currently requires
reconstruction.

## Decision

One persistent `change_record` per change, created at intake and evolved
through the lifecycle:

```
Requirement → Planning → Implementation → Verification → Review → QA
→ Merge → Production outcome → Learning → Memory
```

The object survives beyond the PR. Stages append; nothing is rewritten.
Every producer we've built (grilling/issues, factory runs, Arc C's gate,
Arc A/B's reviews, QA advisories, deploys, incidents) becomes a stage
adapter writing into it.

## Design

### 1. Storage

`change_records`: `id, workspaceId, repo, issueNumber?, prNumber?,
headShas[], mergedSha?, state, createdAt, updatedAt` — plus
`change_record_events`: append-only `(recordId, stage, at, actor,
payloadRef)` where `payloadRef` points at the stage's evidence object
(issue snapshot + ACs; brief/spec refs; run id + commits; `ac_evidence.json`;
review object `(repo, prNumber, headSha)`; QA `ac_results`; merge event;
deploy/incident refs; ledger rows). Records key by issue OR PR and unify
when both exist (a PR that closes an issue joins that issue's record).

### 2. Population (stage adapters)

Each producer writes through one console seam (`runner/change-record`
append route) at the moment it already produces the evidence — no new
computation, only durable attachment. The evidence capability layer's
envelope/registry pattern is the natural implementation substrate; this
spec's refinement pass aligns with whatever shape those PRs land.

### 3. Surfaces

- **Console:** `/changes/<id>` — the lifecycle timeline with each stage's
  evidence inline (the AC table front and center, per Arc C), filterable
  list per repo. Names over ids everywhere.
- **PR comment:** one compact "Change Record" block appended by the
  reviewer-of-record posting path — the AC proof table, judgment verdicts,
  QA status, and the record link. This is the artifact a reviewer reads
  *instead of* reconstructing trust.
- **Chat:** "why should I trust PR #N" answers from the record.

### 4. Post-merge continuation

Merge closes the PR, not the record: deploy outcome, incidents (via the
investigations store), reverts (`false_green` — flows to Arc E), and
eventual ledger learnings append to the same object. This is the §7
requirement made structural: post-merge learning is a stage, not a new
subsystem.

## Evidence & reuse

The Change Record is the aggregation point every prior arc emits into and
the object Arc E's ledger rows reference (`changeRecordId` on every
judgment event). Its PR-comment render is a view; the object is the truth.
If a future component's output cannot attach to a change record stage, the
memo's principle says we question that component.

## Testing (sketch)

Append-only invariants, stage-adapter idempotency (re-delivered events
don't duplicate stages), issue↔PR unification, record view route tests,
comment-render caps, cross-tenant isolation on every read/write seam.

## Rollout

Flagless storage (append from day one, invisible), surfaced per workspace
behind a flag; backfill best-effort from existing runs/PRs where evidence
still exists.

## North-star note

The record is what lets us *show* — not assert — **merge confidence** and
**senior review time** ("everything a senior needed was on one page").
Its completeness per change is an internal health metric, never a vanity
one.
