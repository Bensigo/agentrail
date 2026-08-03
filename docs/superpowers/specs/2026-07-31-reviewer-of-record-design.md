# PR-Event Reviewer of Record — Design (Arc B)

**Date:** 2026-07-31 (directional) · **2026-08-01 refined build-ready** against a full read of the live console/Jace/pipeline code (HEAD `f6c8fa85`, post-Arc-C)
**Status:** Build-ready for **phase B1**; B2 (sandbox boot) is committed arc scope, flagged, and specced directionally at the end — it gets its own refinement when B1 is live.
**Scope (B1):** GitHub-App webhook intake (console), the `review_jobs` Postgres queue, a Jace-side headless review worker (in-process loop), notification on completion, and the **outright deletion** of the AFK pipeline's model-review step.
**Prior art:** Arc A (`2026-07-31-reviewer-judgment-engine-design.md`) — the reviewer this arc makes the reviewer of record; the `post_pr_review` COMMENT-only seam (carries `acCoverage` + `judgment` since Arc A — the posted payload must not regress it); Arc C's `ac_evidence.json` (future join, not consumed in B1).
**Non-goals:** merge gating (advisory stays advisory); reviewing non-PR events; touching the mechanical verify gate or Arc C's AC proof gate; new review logic (Arc A owns the reviewer); B2 sandbox boot (committed, separate phase); fixing the classic per-repo webhook's fail-open defect (recorded below; separate fix).

## Judgment removed

- **Merge confidence** — every PR gets the judgment review structurally, not only when a human remembers to ask.
- **Verification (separation of duties)** — the builder's pipeline stops certifying its own work; the weaker internal reviewer that certified the riskiest code is deleted, not deprecated.

## Problem (what the code actually does today)

- Review is on-request in chat. Nothing fires on PR events; there is **no `pull_request` webhook at all** (the only GitHub receiver, `apps/console/app/api/v1/connectors/github/webhook/route.ts`, handles `issues`/`push` for classic per-repo hooks and resolves workspaces by repo-name containment — and its signature check **fails open** when no secret is set, route.ts:90, a defect the Telegram route's doc-comment already names).
- The duplicate reviewer is **AFK's `Runner._review_and_gate`** (`agentrail/afk/runner.py:617-677`): worktree → subprocess `agentrail internal review-pr` → `review_engine` prompt/run/validate → PR comment via `review.py` + findings pushed by `review_push.py`. A review-parse failure **fails the whole issue** (runner.py:623-625). `finalize_objective_gate`'s `review_advisory` param is NOT this reviewer — it is dead plumbing (sole production caller passes `None`, `run/pipeline.py:2069-2072`).

## Decision

One reviewer of record: Jace's. PRs flow to it through App-webhook events as **queued jobs, not turns** — per-PR serialization with supersede semantics, cross-PR concurrency, per-workspace fairness. The AFK model-review step is **deleted in the same wave** (owner ruling 2026-07-31: never flagged/stubbed; rollback = git revert).

## Design

### 1. Webhook intake (console — new route, new secret, new query)

- **New route `POST /api/v1/webhooks/github-app`** — deliberately distinct from the classic `connectors/github/webhook` route (different resolution model; the two coexist). Follows the Telegram route's discipline, not the classic GitHub route's:
  - Verifies `X-Hub-Signature-256` HMAC against **new env `GITHUB_APP_WEBHOOK_SECRET`** (add to `.env.example` beside the other `GITHUB_APP_*` vars). **Fail closed**: unset secret or bad signature → 401 before the payload is trusted; `timingSafeEqual` with length guard (precedent: `telegram/webhook/route.ts:70-80`).
  - Resolves the workspace **server-side from the payload's `installation.id`** via a **new query `getWorkspaceByGithubInstallationId`** (`workspaces.githubInstallationId`, `schema/workspaces.ts:109-119`; only the reverse lookup exists today — `github-app-token.ts:28-49`). Unknown installation → 200 `{ok:true, ignored:true}`.
  - Accepts `pull_request` events only: `opened`, `ready_for_review`, `reopened` enqueue immediately; `synchronize` enqueues **deferred** (below); draft PRs are skipped until `ready_for_review`; every other event/action → 200 ignored. Webhooks are never an error surface (house doctrine, telegram route).
  - Repo ownership: the PR's repo full-name must resolve via `getRepositoryByName(workspaceId, repo)` (`queries/index.ts:899-911`) — an installation event for a repo the workspace hasn't connected is 200-ignored.
  - Rollout gate: env `REVIEWER_OF_RECORD_WORKSPACES` (comma-separated workspace ids; empty = intake disabled) checked after resolution — dogfood on agentrail's own workspace first.

### 2. The `review_jobs` queue (Postgres)

New table `review_jobs` (`packages/db-postgres/src/schema/review_jobs.ts` + hand-authored migration — **journal gotcha**: migrations ≥0004 are hand-written, `drizzle-kit generate` is broken in this checkout, and the journal's `idx` ≠ filename number (`_journal.json` tail is out of numeric order); recompute BOTH the next filename (0065 at exploration time) and the next `idx` (69 at exploration time) at build time):

`id` (deterministic uuid5 of `(workspaceId, repo, prNumber, headSha)` — the `entryId` precedent, `github_intake.ts:475-481`), `workspace_id`, `repo`, `pr_number`, `head_sha`, `event`, `state` (`queued | running | posted | superseded | skipped | failed`), `attempts`, `claimed_by`, `claimed_at`, `next_eligible_at`, `posted_review_url`, `verdict`, `skip_reason`, `created_at`, `updated_at`.

- **Idempotency:** deterministic id + `ON CONFLICT (id) DO NOTHING` — a replayed webhook is a no-op (same idiom as `enqueueGithubIssue`).
- **Debounce (`synchronize`):** inserted with `next_eligible_at = now() + 60s`; the claim query only picks eligible rows, so a push storm's newer heads supersede the still-ineligible older ones before any runs. No unique-window machinery.
- **Supersede, never cancel:** on insert for a new head, mark that `(workspace, repo, pr)`'s other **`queued`** jobs `superseded` — a multi-row conditional UPDATE, so the **EvalPlanQual lesson applies HERE**: repeat `state = 'queued'` on the UPDATE's own WHERE, never only in a CTE (`confirmAlignmentBrief` precedent, `github_intake.ts:996-1057`). A `running` job is never touched — it finishes and posts labeled with its `headSha`.
- **Claim:** single-statement `UPDATE ... WHERE id = (SELECT id ... WHERE state='queued' AND (next_eligible_at IS NULL OR next_eligible_at <= now()) ... ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *` — the `claimQueueEntry` shape verbatim (`runner.ts:672-774`). **Not** the EvalPlanQual idiom (the directional spec conflated the two; the claim needs no CTE guard).
- **Fairness (v1):** the claim subquery skips workspaces that already have a `running` review job (per-workspace serialization = fairness at dogfood scale; round-robin refinement comes with load). Per-PR serialization falls out of supersede + this rule.
- **Budget:** per-workspace daily cap (env `REVIEW_JOBS_DAILY_BUDGET`, default 50): over budget → `skipped` with `skip_reason='daily budget exhausted'`, never silent.
- **Staleness:** `claimed_at` older than 15 min with state `running` → re-queued by the claim route's next pass (attempts+1; attempts > 2 → `failed`). Mirrors the liveness-reclaim posture (`runner.ts:443-476`) without a new heartbeat channel in v1 (a review is minutes, not hours).

### 3. Claim/complete routes + headless session binding (console)

Two new routes under the Jace runner surface, auth `requireJaceConsoleSecret` (the worker IS Jace; `jace-console-auth.ts:76-109`):

- **`POST /api/v1/runner/review-jobs/claim`** — body `{ workerId, eveSessionId }`. Claims the next eligible job (query above) and, in the same transaction, **binds the worker's freshly-created headless eve session to the job's workspace** by inserting a `jace_sessions` row (`channel: 'review-job'`, `workspaceId` from the job row, no chat identity). This is the refinement's replacement for the directional `reviewJobToken`: **zero changes to any tool** — all six session-resolving modules (the five reviewer tools + `post_pr_review`, each resolving `ctx.session.parent?.rootSessionId ?? ctx.session.id` → `getJaceSessionByEveSessionId` → workspace) work unchanged, and workspace resolution stays server-side on the one existing path instead of a third auth scheme threaded through six files. Response: job row (repo, prNumber, headSha, event) or 204.
- **`POST /api/v1/runner/review-jobs/complete`** — body `{ jobId, outcome: posted|failed, postedReviewUrl?, verdict?, error? }`. Guarded UPDATE (`state='running'` on the WHERE). On `posted`, fires the owner notification through the console's **existing notify machinery** (`runner/result/notify.ts` — it already handles the legacy direct senders vs. `jaceOwns<Channel>Notify` cutover split; the directional spec's "existing notify path" is this, not Jace's run-outcome channel, which is run-outcome-scoped and workspace-gated): one line + review link + judgment verdicts + anything `blocker`.

### 4. The headless review worker (Jace service, in-process)

- **Home:** launched from `apps/jace/agent/instrumentation.ts` `setup()` — the **Discord-gateway precedent** (instrumentation.ts:96-106; eve's only authored slot for persistent background work; `defineSchedule` is wrong here: minute-granularity cron that never fires under `eve dev`). Same discipline: module-scope double-start guard, retry with backoff, no rejection ever escapes setup.
- **Flag:** env `JACE_REVIEW_WORKER` — worker starts only when `"1"` (default off; deploy order safe: intake without worker queues, worker without intake idles).
- **Loop (concurrency 1 in v1, config for 2):** poll claim (30s idle interval) → on a job: create a fresh eve session against the local process (`eve/client` `Client({host: self})`.`session()` — the `needs-approval-roundtrip.mjs` precedent) → claim already bound it → `session.send({ message: <canned review-job instruction>, outputSchema: <job result schema> })`.
- **The canned instruction** (a versioned template in `apps/jace/agent/lib/review_job_prompt.mjs`) tells **root Jace** exactly the choreography it already performs in chat: dispatch the `reviewer` subagent for `(repo, prNumber)`; relay honestly (existing root rules: acCoverage + judgment verbatim, cannot_judge never softened); post via `post_pr_review`; if the PR's ACs are behavioral AND a preview URL is present in the PR (deployments API/PR-comment detection is the reviewer's/QA's judgment, rung 1), dispatch `qa` and fold `ac_results` in; if there is no preview URL, call `request_preview_boot(repo, prNumber, headSha)` and, if it returns a booted URL, dispatch `qa` against that URL exactly as rung 1 (rung 2); if the tool returns a `bootLogKey`, include it in the structured result's `evidenceKeys`; return `{posted, reviewUrl, verdict, blockers[], evidenceKeys?}`. Headless-via-root is deliberate: **no external API can address a declared subagent directly** (exploration finding — `Client.session()` reaches root only), and root's write surface during the job is the same surface the chat flow already trusts for exactly this choreography.
- Worker reports `complete` with the structured result; on send failure/timeout (15 min) reports `failed` (attempts/backoff handled console-side).
- **Rung 3 honesty (B1/B2):** no preview URL and no boot becomes ready → behavioral ACs return `not_testable` with the concrete reason through the existing QA/reviewer vocabularies; the posted review says which environment rung was reached. Never a silent skip.

### 5. Pipeline model-review deletion — one source of truth

Deleted outright in this arc (same wave as intake+worker going live), from the **real** deletion surface (exploration §4):

- `Runner._review` + `_review_and_gate`'s review half (`afk/runner.py:429-467, 617-677`) — the objective-gate fix loop survives; the review subprocess, `REVIEWING` status transitions, and "review produced no parseable output → fail the issue" behavior do not.
- `agentrail internal review-pr` (`cli/commands/internal.py:68-194`), `afk/review_engine.py`, `afk/review.py`, the findings half of `afk/review_push.py` (`parse_findings` + the findings field of `push_review_gate`; the objective-gate status/blockingReasons push **stays**), `IssueStatus.REVIEWING` (`afk/state.py:28`), the orphaned `--max-review-rounds`/`AfkState.max_review_rounds` plumbing (its loop bound was a hardcoded `max_fix = 2` all along — runner.py:618), and the two agent templates (`templates/docs/agents/pr-review.md`, `github-pr-reviewer.md`).
- `finalize_objective_gate`'s dead `review_advisory` param (production always passes `None`) — removed, tests updated.
- Tests: `test_review.py`, `test_review_policy.py`, `test_review_engine.py`, `test_review_push.py` (findings half), `test_runner_review.py`, `test_runner_review_gate.py`, `test_internal_cli.py` (review-pr cases), plus one-line `AfkState(...)` constructor fixes in the boilerplate cluster (`test_runner_worktree_hooks.py`, `test_afk_options.py`, `test_store_roundtrip.py`, `test_runner_push_guardrail.py`, `observability/test_afk_session_env.py`).
- **Do NOT touch** `doctor.py:575-580` / `_template_sync.py:85-93` — their `review-pr` strings guard the long-deleted pre-M3 bash script, unrelated.
- **Recorded blast radius:** the console **Review Gates dashboard** (`/dashboard/[workspaceId]/review-gates/`) keeps its objective-gate half (status/blockingReasons still populate) but its LLM-findings section goes permanently empty — accepted for B1; the reviewer-of-record's findings live on the PR and in `review_jobs`; feeding the dashboard from Arc B reviews is a v2/Arc-D decision, noted on the page's issue when deletion lands.
- Regression pin: a test asserting the deleted entry points stay gone (no `internal review-pr` command, no `_review_and_gate` attribute) and that a runner `_process` pass completes with no review phase.

## Evidence & reuse

`review_jobs` rows + posted reviews keyed `(workspaceId, repo, prNumber, headSha)` are the events Arc D's Change Record consumes and the population Arc E's calibration measures. The queue is deliberately the shape a future `qa_jobs` twin can copy. Naming note (exploration finding): the existing `review_gates` table/dashboard is a DIFFERENT concept (per-run CI+advisory telemetry) — new code says "review job", never "review gate".

## Testing

- Webhook: signature required (unset secret → 401 — pinned so the classic route's fail-open defect is not replicated), bad signature 401, non-PR events ignored 200, draft skipped, unknown installation ignored, rollout-gate off → ignored, dedupe on redelivery (same id no-op), synchronize gets `next_eligible_at`.
- Queue SQL (integration, `queue-retry-backoff.integration.test.ts` style): claim skips ineligible/other-workspace-running, SKIP LOCKED contention (two concurrent claims, one wins), supersede marks only `queued` rows (EvalPlanQual pin: repeated predicate on the outer WHERE — `confirm-unpark-race-proof` style), stale running re-queue, budget skip visible, terminal states frozen.
- Claim/complete routes: auth (missing/wrong bearer), session binding row created with job's workspace, complete guarded on running, notify fired on posted.
- Worker: unit tests on the loop core (fake client + fake console): double-start guard, idle poll, claim→send→complete happy path, send timeout → failed, never-throws discipline. Prompt template prose-pinned (choreography bullets: dispatch reviewer, post, honest relay, rung-3 wording).
- Deletion: the regression pin above; full AFK suite green with review modules gone; `review_gates` objective-half ingest still tested.
- Cross-boundary: a fake end-to-end (webhook payload → job row → claimed → fake session posts via existing pr-review route fixtures → complete → notified) at the console level.

## Scale posture (1K–10K reviews/hour) — unchanged conclusions, corrected mechanics

Ceilings in order: (1) LLM tokens (prompt caching, tiered reviews, provider spread, pricing pass-through); (2) GitHub per-installation limits (~200-250 full reviews/hour/workspace — fine, load is per-installation-parallel; read-through caching on file-at-SHA later); (3) worker fleet (the loop is stateless-claim based — extraction to a separate service is a topology change the queue contract already permits); (4) the queue itself is a non-issue (8 writes/sec at 10K/hour; SKIP LOCKED + partial index on `state='queued'`). Supersede+debounce+fairness+budget are already the scale-correct primitives in v1.

## Rollout

B1: intake gated by `REVIEWER_OF_RECORD_WORKSPACES` (agentrail's own workspace first), worker gated by `JACE_REVIEW_WORKER`, advisory-only, budget-capped. Deploy order safe in both directions. The AFK deletion rides the same release; interim protection is unchanged (the deleted step's verdict was one unproven model line — its absence removes theater, not protection).

## Phase B2 (committed scope, ships after B1 proves the seam — own flag, own refinement pass)

No preview URL → an ephemeral sandbox (the fleet runner's untrusted-code isolation tier, never Jace's process) clones the PR head, boots via `jace.preview` config or detected recipe, reachable only from the browser sidecar, public-safe env only, resource/time-capped, destroyed after; boot logs attach to evidence; boot-impossible → rung 3. B2 exists because most repos have no preview deploys — rung 3 alone leaves the common case unverified.

**Visual evidence attaches to the PR (owner requirement, 2026-08-02).** Whenever the behavioral stage drives a browser — rung 1 preview OR rung 2 sandbox — it captures **per-AC screenshots** (and, where the sidecar supports it cheaply, a short recording of the verification pass) as first-class evidence, not just prose `ac_results`. Capture is native to the existing playwright/browser sidecars; the new plumbing is storage + attachment: artifacts upload through a console runner route into the house object store (the S3/minio seam the console already runs), keyed `(workspaceId, repo, prNumber, headSha, acId)`, and the posted review embeds/links each verified AC's evidence (signed URLs; GitHub's comment-upload CDN has no public API, so the console serves them). "Every rung ends in evidence" means SEEABLE evidence for UI work: a human reading the review clicks straight from "AC3: verified" to the pixels that prove it. The same artifacts feed Arc D's Change Record verification stage. Failure honesty: a screenshot of the FAILING state attaches to `failed` ACs too; `not_testable` records why no browser ever ran.

## Contradictions resolved (exploration 2026-08-01)

1. No PR webhook exists; classic route is per-repo-hook + repo-name resolution → new App-scoped route, coexisting (§1).
2. Classic route fails open on missing secret (known defect) → new route pinned fail-closed; classic fix out of scope, recorded.
3. No App-level webhook secret env → `GITHUB_APP_WEBHOOK_SECRET` added (§1).
4. No workspace-by-installation-id query → `getWorkspaceByGithubInstallationId` added (§1).
5. "EvalPlanQual guard on the claim" conflated two idioms → claim = SKIP LOCKED (`claimQueueEntry` shape); EvalPlanQual = the supersede write (§2).
6. Headless subagent invocation isn't a primitive; `Client.session()` reaches root only → root task-mode session + canned choreography instruction; `reviewJobToken` replaced by claim-time **session binding** so all six tools resolve unchanged (§3, §4).
7. `defineSchedule` wrong for the worker (minute cron, dead in dev) → instrumentation-launched loop, Discord-gateway precedent (§4).
8. "Existing notify path" is two coexisting paths and Jace's channel is run-outcome-scoped + workspace-gated → notify from the console's `notify.ts` machinery on complete (§3).
9. `review_advisory` is dead plumbing, not the duplicate reviewer; the real one is AFK's `_review_and_gate` → deletion surface remapped (§5).
10. Review Gates dashboard findings-half empties on deletion → recorded disposition (§5).
11. `--max-review-rounds` is orphaned (real bound: hardcoded `max_fix=2`) → retired with the step (§5).
12. "review gate" vs "review job" naming collision → naming rule (Evidence & reuse).
13. Two independent parsers of review text existed (`review.py::classify`, `review_push.py::parse_findings`) → both die; completeness check covers both call sites (§5).
