# PR-Event Reviewer of Record — Design (Arc B)

**Date:** 2026-07-31
**Status:** Directional — approved shape; gets a refinement pass when its build starts (after Arcs A and C land)
**Scope:** GitHub webhook intake, a Postgres-backed review-job queue, a Jace-side headless review worker, pipeline model-review retirement
**Prior art:** Arc A (`2026-07-31-reviewer-judgment-engine-design.md`) — the reviewer this arc makes the reviewer of record; the AC-aware arc's `post_pr_review` posting seam (COMMENT-only, hardened).
**Non-goals:** merge gating (advisory stays advisory in v1); reviewing non-PR events; replacing the factory's mechanical verify gate (tests, red-green trail — that stays); any new review logic (Arc A owns the reviewer itself).

## Judgment removed

- **Merge confidence** — every PR gets the judgment review structurally, not
  only when a human remembers to ask. The review exists before the human
  looks.
- **Verification (separation of duties)** — the builder's pipeline stops
  certifying its own work: loop-produced PRs are reviewed by an independent
  agent with independent context. The audit's "plausible green-CI PR"
  failure mode gets a standing, unprompted check.

## Problem

Review today is on-request: the owner asks in chat. Agent-produced PRs —
the ones most likely to be plausible-but-wrong — are reviewed only if
someone remembers. Meanwhile the pipeline's internal model-review step
duplicates (and has drifted behind) the Jace reviewer: two reviewers, no
single source of truth, and the weaker one certifies the riskiest code.

## Decision

One reviewer of record: Jace's. PRs flow to it through events, as **queued
jobs, not turns** — per-PR serialization with supersede semantics, cross-PR
concurrency, and per-workspace fairness, so no review blocks, obstructs, or
cancels another. The pipeline keeps its mechanical gate; its model-review
step is **removed — deleted, not flagged** (owner ruling 2026-07-31: a
lingering second review path defeats the single source of truth).

## Design

### 1. Webhook intake (console)

- `POST /api/v1/webhooks/github` — verifies `X-Hub-Signature-256` against
  the GitHub App webhook secret (fail closed), accepts `pull_request`
  events for installed repos, resolves the workspace from the installation
  id (server-side, never caller-supplied), and drops everything else with a
  200 (webhooks are never an error surface).
- Event filter: `opened`, `ready_for_review`, `reopened` enqueue;
  `synchronize` enqueues behind a **debounce window (60s)** so push-storms
  collapse to one job; draft PRs are skipped until `ready_for_review`.

### 2. The review-job queue (Postgres)

`review_jobs`: `id, workspaceId, repo, prNumber, headSha, event, state
(queued | running | posted | superseded | skipped | failed), attempts,
claimedBy, claimedAt, postedReviewUrl, createdAt, updatedAt`.

- **Idempotency:** unique on `(workspaceId, repo, prNumber, headSha)` —
  a replayed webhook is a no-op.
- **Supersede, never cancel:** a new head for a PR marks that PR's
  `queued` jobs `superseded`; a `running` job is never killed — it
  finishes, posts (its review is labeled with its `headSha`, so it is
  honest about what it judged), and the newer head's job runs next.
- **Fairness + caps:** workers claim round-robin per workspace;
  per-workspace daily review budget (config, default generous) — over
  budget → `skipped` with a visible reason, never silent.
- Claim/complete via console runner routes with the same heartbeat +
  re-enqueue posture the factory queue already proved (`EvalPlanQual`
  guard style on the claim UPDATE).

### 3. The headless review worker (Jace service)

A worker loop in the Jace service (concurrency 2 default) polls the claim
route, runs the Arc A reviewer **headlessly** — no chat conversation. The
tenant chain today requires an `eveSessionId` ledger row; headless runs use
a **scoped job credential instead**: the claim response carries a
short-lived `reviewJobToken`, and the console's pr-review + context routes
accept it as an alternative to `eveSessionId`, resolving the workspace from
the job row (same server-side resolution posture, no fake chat sessions).
The worker posts through the existing COMMENT-only seam and then notifies
the owner's channel through the existing notify path: one line + link, the
judgment verdicts, and anything `blocker`.

### 4. Pipeline removal — one source of truth

The factory's model-review step is **removed outright in this arc** —
deleted, not flagged, not stubbed. The mechanical verify gate (tests,
red-green trail, Arc C's AC evidence) is untouched: machine checks belong
where the build runs; judgment does not. Removal lands in the same wave as
intake + worker going live, so every PR's automatic review switches seams
without a gap; rollback, if ever needed, is a git revert. Interim (until
this arc lands): Jace review stays on-request and the standing human
adversarial review of loop PRs continues — the audit showed the internal
step's verdict was one unproven model line, so its absence removes theater,
not protection.

## Evidence & reuse

`review_jobs` rows + posted reviews keyed `(repo, prNumber, headSha)` are
the events Arc D's Change Record consumes for its review stage, and the
population Arc E's calibration measures (reviews issued vs. dispositions
vs. outcomes). The queue table is deliberately the shape a future
"qa_jobs" twin can copy.

## Testing (sketch)

Signature verification (reject unsigned/wrong-secret), event filtering,
debounce, idempotency + supersede transitions (SQL-level, EvalPlanQual
lesson applied), claim contention, budget skip visibility, worker
happy-path against a fake console, and a pipeline regression pin that the
removed model-review step stays removed (no dangling config or dead step
references).

## Rollout

Flagged intake per workspace (start with agentrail's own repos — dogfood),
advisory-only, budget-capped. Deploy order safe: intake without workers
queues; workers without intake idle.

## North-star note

This arc is what makes **senior review time** and **reviewer agreement**
measurable at population scale — every PR has a review to agree or
disagree with. Latency and comment counts are explicitly not success
metrics.
