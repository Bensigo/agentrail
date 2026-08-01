# Reviewer of Record (Arc B, phase B1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every PR event on a connected repo becomes a queued review job that a headless Jace worker executes through the existing reviewer choreography and posts as the one review of record — and the AFK pipeline's internal model-review step is deleted outright.

**Architecture:** Console owns intake (new GitHub-App webhook, fail-closed) and the `review_jobs` Postgres queue (SKIP LOCKED claim, EvalPlanQual-guarded supersede, claim-time session binding into `jace_sessions`). The Jace service runs an instrumentation-launched worker loop (Discord-gateway precedent) that drives a root task-mode eve session with a canned choreography prompt. The python AFK reviewer is removed from the same release.

**Tech Stack:** Next.js route handlers + vitest (console), Drizzle/Postgres hand-authored migration (db-postgres), eve/Nitro + node:test or vitest per apps/jace convention (jace), Python 3/pytest (agentrail).

**Spec:** `docs/superpowers/specs/2026-07-31-reviewer-of-record-design.md` (build-ready B1, merged #1557). Exploration anchors in the spec's "Contradictions resolved" section are load-bearing — trust file content over line numbers.

## Global Constraints

- Repo root for all work: the worktree checkout of branch `feat/reviewer-of-record`. Console/db work under `apps/console` + `packages/db-postgres`; jace under `apps/jace`; python under `agentrail/`.
- **apps/jace is excluded from the pnpm workspace**: install with `cd apps/jace && pnpm install --ignore-workspace`, test with `cd apps/jace && pnpm test`. NEVER `git add apps/jace/pnpm-lock.yaml`.
- **Migration journal gotcha:** migrations ≥0004 are hand-authored (`drizzle-kit generate` is broken here); apply order is `_journal.json`'s `idx`, which is NOT the filename number (tail is out of numeric order). Recompute BOTH the next filename and the next `idx` live from `packages/db-postgres/drizzle/migrations/` + `meta/_journal.json` before writing.
- **The six session-resolving Jace tool modules must NOT be modified** (five reviewer tools + `post_pr_review` — each resolves `ctx.session.parent?.rootSessionId ?? ctx.session.id` → console → `getJaceSessionByEveSessionId` → workspace). The claim-time `jace_sessions` binding is what makes them work headlessly; any diff touching them is a spec violation.
- `post_pr_review` and its core/route are untouched — the posted payload's Arc-A richness (acCoverage + judgment) must not regress by construction.
- New env vars go in `.env.example` ONLY (never a real `.env`): `GITHUB_APP_WEBHOOK_SECRET`, `REVIEWER_OF_RECORD_WORKSPACES`, `REVIEW_JOBS_DAILY_BUDGET`, `JACE_REVIEW_WORKER`.
- Naming rule: new code says "review job", never "review gate" (`review_gates` is an existing unrelated feature).
- Python deletion must NOT touch `agentrail/cli/commands/doctor.py` / `_template_sync.py` legacy-script arrays (their `review-pr` strings guard a long-dead bash script).
- Search discipline: the repo hook blocks Grep/Glob and bare `grep` — Read exact paths; `bash <<'EOF' ... python3 heredoc ... EOF` for searches.
- Fail-closed rule for the new webhook: unset secret → 401. Never copy the classic route's fail-open (`connectors/github/webhook/route.ts:90`).
- Commit after each task with the task's message.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/db-postgres/src/schema/review_jobs.ts` (new) + migration + journal entry | the queue table |
| `packages/db-postgres/src/queries/review_jobs.ts` (new) | enqueue/supersede/claim/complete/bind + workspace-by-installation |
| `apps/console/app/api/v1/webhooks/github-app/route.ts` (new) | PR-event intake, fail-closed |
| `apps/console/app/api/v1/runner/review-jobs/claim/route.ts` (new) | claim + session binding |
| `apps/console/app/api/v1/runner/review-jobs/complete/route.ts` (new) | complete + notify |
| `apps/jace/agent/lib/review_job_worker.core.mjs` (new) | pure worker loop (injected transports) |
| `apps/jace/agent/lib/review_job_prompt.mjs` (new) | canned choreography instruction + result schema |
| `apps/jace/agent/lib/review_job_console.mjs` (new) | claim/complete HTTP transport |
| `apps/jace/agent/instrumentation.ts` | worker wiring behind `JACE_REVIEW_WORKER` |
| `agentrail/afk/runner.py`, `state.py`, `store.py`, `cli/commands/{afk,internal}.py`, `afk/{review,review_engine}.py`, `afk/review_push.py`, `agentrail/templates/docs/agents/{pr-review,github-pr-reviewer}.md`, `run/pipeline.py` | the deletion surface |

---

### Task 0: Baseline

- [ ] **Step 1:** `git -C . status --short --branch` → `## feat/reviewer-of-record...origin/main`, clean (plan file may be committed).
- [ ] **Step 2:** Record green baselines with the exact commands used:
  - `cd packages/db-postgres && pnpm test` (note which tests need a DB and whether one is available locally; record skips honestly)
  - console: find the console test script in `apps/console/package.json` and run it (prior arcs recorded "console 57/57")
  - `cd apps/jace && pnpm install --ignore-workspace && pnpm test`
  - `python3 -m pytest agentrail/tests/afk agentrail/tests/cli agentrail/tests/run/test_pipeline_objective_gate.py -q`

---

### Task 1: `review_jobs` schema + migration

**Files:** Create `packages/db-postgres/src/schema/review_jobs.ts`; modify `packages/db-postgres/src/schema/index.ts` (export); create `packages/db-postgres/drizzle/migrations/<NEXT>_review_jobs.sql`; modify `drizzle/migrations/meta/_journal.json`.

**Interfaces (produces):** table `review_jobs` with columns exactly: `id uuid PK` (caller-supplied deterministic), `workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE`, `repo text NOT NULL`, `pr_number integer NOT NULL`, `head_sha text NOT NULL`, `event text NOT NULL`, `state text NOT NULL DEFAULT 'queued'` (`queued|running|posted|superseded|skipped|failed`), `attempts integer NOT NULL DEFAULT 0`, `claimed_by text`, `claimed_at timestamptz`, `next_eligible_at timestamptz`, `posted_review_url text`, `verdict text`, `skip_reason text`, `created_at/updated_at timestamptz NOT NULL DEFAULT now()`. Indexes: partial `(state) WHERE state='queued'` as `review_jobs_queued_idx`, plus `(workspace_id, repo, pr_number)` as `review_jobs_pr_idx`. Type export `ReviewJobRow`.

- [ ] **Step 1:** Read a modern sibling schema (`schema/jace_sessions.ts`) + one recent migration (`0064_slack_installations.sql`) to mirror conventions. Compute next filename + next journal `idx` via a python heredoc over `meta/_journal.json` (print both; they differ).
- [ ] **Step 2:** Write the schema file (drizzle `pgTable` mirroring column list above, doc-comment stating: deterministic id = uuid5 of `(workspaceId, repo, prNumber, headSha)` computed in the query layer — the `entryId` precedent; "review job ≠ review gate" naming note). Export from `schema/index.ts` alphabetically.
- [ ] **Step 3:** Write the hand-authored migration SQL (CREATE TABLE + both indexes + the header comment convention the recent migrations use, including the drizzle-kit-broken note). Append the journal entry with the freshly computed `idx`/`tag` (same `version`/`when` field shapes as the last entry).
- [ ] **Step 4:** `cd packages/db-postgres && pnpm test` — schema module imports cleanly (any schema-shape unit tests the package has stay green). If the package has a migration-apply test/harness, run it; otherwise note that verification is CI's.
- [ ] **Step 5:** Commit: `feat(db): review_jobs queue table — deterministic-id PR review jobs (Arc B §2)`

---

### Task 2: Queue queries — enqueue/supersede/claim/complete/bind + installation lookup

**Files:** Create `packages/db-postgres/src/queries/review_jobs.ts`; modify the package's query barrel (mirror how `queries/runner.ts` is exported); modify `packages/db-postgres/src/queries/github-app-token.ts` (add `getWorkspaceByGithubInstallationId`); Test: `packages/db-postgres/src/__tests__/review-jobs.test.ts` (+ `.integration.test.ts` if the DB harness pattern applies — mirror `queue-retry-backoff.integration.test.ts`'s setup).

**Interfaces (produces):**
- `reviewJobId({workspaceId, repo, prNumber, headSha}) -> string` — deterministic uuid5 (mirror `entryId`, `github_intake.ts:475-481`; namespace seed string `"review-job"`).
- `enqueueReviewJob({workspaceId, repo, prNumber, headSha, event}) -> {id, deduped: boolean, superseded: number}` — INSERT `ON CONFLICT (id) DO NOTHING` (deduped = no row returned); `next_eligible_at = now() + interval '60 seconds'` iff `event === 'synchronize'`; then the supersede write: `UPDATE review_jobs SET state='superseded', updated_at=now() WHERE workspace_id=$1 AND repo=$2 AND pr_number=$3 AND head_sha <> $4 AND state='queued'` — **the `state='queued'` predicate on the UPDATE's own WHERE is the EvalPlanQual lesson; if any CTE is used, repeat the predicate on the outer UPDATE anyway** (`confirmAlignmentBrief` precedent, `github_intake.ts:996-1057`). Returns count superseded.
- `claimReviewJob({workerId, dailyBudget}) -> ReviewJobRow | null` — first a stale-requeue pre-pass (`UPDATE ... SET state='queued', attempts=attempts+1, claimed_by=NULL, claimed_at=NULL WHERE state='running' AND claimed_at < now() - interval '15 minutes'`; then `UPDATE ... SET state='failed', skip_reason='stale after retries' WHERE state='queued' AND attempts > 2`); then the claim, copying `claimQueueEntry`'s single-statement shape (`runner.ts:672-774`): `UPDATE review_jobs SET state='running', claimed_by=$1, claimed_at=now(), updated_at=now() WHERE id = (SELECT id FROM review_jobs rj WHERE state='queued' AND (next_eligible_at IS NULL OR next_eligible_at <= now()) AND NOT EXISTS (SELECT 1 FROM review_jobs r2 WHERE r2.workspace_id = rj.workspace_id AND r2.state='running') ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`; budget: before claiming, count today's non-superseded jobs for the candidate's workspace — over `dailyBudget` → mark that candidate `skipped` with `skip_reason='daily budget exhausted'` and loop to the next candidate (implement as: claim first, then if over budget flip the claimed row to `skipped` and recurse — simplest correct form; document the choice).
- `bindReviewJobSession({jobId, eveSessionId}) -> void` — INSERT into `jace_sessions` `{workspaceId: job.workspaceId, channel: 'review-job', conversationKey: 'review-job:'+jobId, eveSessionId, status: 'active'}` (schema allows workspace-anchored rows with null chatIdentityId — CHECK is workspace-OR-identity; conversationKey unique per job under `jace_sessions_conversation_unique`). Re-bind on conflict: `ON CONFLICT ... DO UPDATE SET eve_session_id = excluded.eve_session_id` on the conversation unique.
- `completeReviewJob({jobId, outcome, postedReviewUrl, verdict, error}) -> ReviewJobRow | null` — guarded: `WHERE id=$1 AND state='running'`; `outcome: 'posted'` → `state='posted'`, url+verdict recorded; `'failed'` → `attempts+1`, `state = attempts > 2 ? 'failed' : 'queued'` with `next_eligible_at = now() + interval '5 minutes'` (simple fixed backoff v1; document divergence from the exponential `nextQueueTransition` — a review retry is rare and cheap to keep simple), `skip_reason=NULL`, error recorded in `skip_reason` only when terminally failed.
- `getWorkspaceByGithubInstallationId(installationId: number) -> {workspaceId} | null` — SELECT on `workspaces.githubInstallationId` (only the reverse exists today, `github-app-token.ts:28-49`).

- [ ] **Step 1 (TDD):** Write the test file first. Mandatory cases (mirror the package's existing test harness style — read `queue-retry-backoff.integration.test.ts` + a unit sibling to split unit-vs-integration the way the package does): deterministic id stability + dedupe on re-enqueue; synchronize sets `next_eligible_at` ≈ +60s, opened does not; supersede flips ONLY `queued` siblings (a `running` sibling untouched — the EvalPlanQual pin, `confirm-unpark-race-proof` style if the harness supports it); claim skips ineligible (future `next_eligible_at`), skips workspaces with a running job, claims oldest first; two concurrent claims → one winner (integration, SKIP LOCKED); stale running requeued then terminally failed after attempts>2; budget exhaustion → `skipped` with visible reason; complete guarded (second complete no-ops); bind inserts the exact `jace_sessions` shape (assert workspaceId/channel/conversationKey/eveSessionId) and re-binds on conflict; installation lookup hit + miss.
- [ ] **Step 2:** Run to verify failures (module missing).
- [ ] **Step 3:** Implement per the interface block above.
- [ ] **Step 4:** `cd packages/db-postgres && pnpm test` green (record honestly which integration cases ran vs. need CI's DB).
- [ ] **Step 5:** Commit: `feat(db): review_jobs queries — SKIP LOCKED claim, EvalPlanQual supersede, session binding (Arc B §2-§3)`

---

### Task 3: The GitHub-App webhook route

**Files:** Create `apps/console/app/api/v1/webhooks/github-app/route.ts`; colocated test (mirror how `apps/console/app/api/v1/runner/pr-review/route.test.ts` or the package's route-test convention names/mounts it); modify `.env.example` (add `GITHUB_APP_WEBHOOK_SECRET`, `REVIEWER_OF_RECORD_WORKSPACES`, `REVIEW_JOBS_DAILY_BUDGET` beside the `GITHUB_APP_*` block with one-line comments).

**Interfaces:** Consumes `enqueueReviewJob`, `getWorkspaceByGithubInstallationId`, `getRepositoryByName` (`queries/index.ts:899-911`). Produces `POST /api/v1/webhooks/github-app`.

**Behavior (each line is a mandatory test case):**
1. Secret unset → 401 `{error:"webhook secret not configured"}` — **fail closed, pinned** (the classic route's fail-open is the anti-pattern).
2. Missing/invalid `X-Hub-Signature-256` (HMAC-SHA256 of the RAW body with the secret; `timingSafeEqual` + length guard first — mirror `telegram/webhook/route.ts:70-80`; verify BEFORE parsing/trusting the payload) → 401.
3. Non-`pull_request` event (`X-GitHub-Event` header) → 200 `{ok:true, ignored:true}`.
4. `pull_request` with action outside `opened|ready_for_review|reopened|synchronize` → 200 ignored.
5. Draft PR (`pull_request.draft === true`) with action `opened`/`reopened`/`synchronize` → 200 ignored (enters via `ready_for_review` later).
6. Unknown `installation.id` (no workspace) → 200 ignored.
7. Workspace not in `REVIEWER_OF_RECORD_WORKSPACES` (comma-separated ids; empty/unset = intake disabled for all) → 200 `{ok:true, ignored:true, reason:"not enrolled"}`.
8. Repo full name (`repository.full_name`) not connected to the workspace (`getRepositoryByName` null) → 200 ignored.
9. Happy path → `enqueueReviewJob` with `headSha = pull_request.head.sha`, 200 `{ok:true, enqueued:true, deduped, superseded}`; replayed delivery → `deduped: true`, still 200.
10. Malformed JSON body after a valid signature → 200 ignored (webhooks are never an error surface — only auth failures are 4xx).

- [ ] **Step 1 (TDD):** tests first (mirror the console's existing route-test fixtures for constructing signed requests — a small local `sign(body, secret)` helper with `crypto.createHmac("sha256", secret)`, header `sha256=<hex>`); **Step 2:** verify failures; **Step 3:** implement; **Step 4:** console test script green; **Step 5:** Commit: `feat(console): github-app webhook — fail-closed PR-event intake for review jobs (Arc B §1)`

---

### Task 4: Claim + complete routes (+ notify)

**Files:** Create `apps/console/app/api/v1/runner/review-jobs/claim/route.ts` and `.../complete/route.ts`; colocated tests; (read `apps/console/app/api/v1/runner/result/notify.ts` first — reuse its exported send helpers the way `runner/result` does; if its helpers are not exported for reuse, extract the minimal send call the same file already makes — do not build a new notification system).

**Interfaces:** Consumes `claimReviewJob`, `bindReviewJobSession`, `completeReviewJob`, `requireJaceConsoleSecret` (`apps/console/lib/jace-console-auth.ts:76-109`). Produces the two routes, auth `Bearer JACE_CONSOLE_TOKEN`.

**Behavior (mandatory test cases):**
- Both routes: missing/wrong bearer → the exact status/shape `requireJaceConsoleSecret` produces (mirror `runner/pr-review`'s auth tests).
- claim: body `{workerId, eveSessionId}` (both required, 400 otherwise). No eligible job → 204 empty. Job claimed → `bindReviewJobSession` called with the job id + eveSessionId, response 200 `{job: {id, repo, prNumber, headSha, event, workspaceId}}`. Binding failure → job flipped back to `queued` (release, not leak) and 503.
- complete: body `{jobId, outcome: "posted"|"failed", postedReviewUrl?, verdict?, error?}`; unknown job or not-running → 409; `posted` → 200 + notify fired once with: one line naming repo+PR, the review URL, the judgment verdicts string, and any `blocker` items (the worker passes these in `verdict`/structured fields — accept a `summaryLine` field in the body and pass it through; the WORKER composes content, console only routes it); `failed` → recorded, no notify, 200.
- Notify goes through the console's existing machinery in `runner/result/notify.ts` (the legacy-vs-`jaceOwns<Channel>Notify` split lives there already) — test with the same fakes/mocks its existing tests use.

- [ ] Steps: TDD → fail → implement → console tests green → Commit: `feat(console): review-job claim/complete routes — session binding + notify on posted (Arc B §3)`

---

### Task 5: The worker core (pure)

**Files:** Create `apps/jace/agent/lib/review_job_worker.core.mjs`; Test `apps/jace/agent/lib/review_job_worker.core.test.mjs` (mirror the sibling `.core.test.mjs` style — e.g. `post_pr_review.core.test.mjs`).

**Interfaces (produces):**
```js
export function createReviewJobWorker({
  claim,      // async ({workerId, eveSessionId}) => job | null
  complete,   // async ({jobId, outcome, postedReviewUrl, verdict, summaryLine, error}) => void
  openSession, // async () => ({ id, send: async ({message, outputSchema}) => result, close: async () => void })
  promptFor,  // (job) => string
  resultSchema, // JSON schema for the structured job result
  intervalMs = 30_000,
  jobTimeoutMs = 15 * 60_000,
  log = () => {},
}) => ({ start: () => void, stop: () => void, tick: async () => "idle"|"done"|"failed" })
```
Loop contract (each a test with fakes): `start()` twice → second is a no-op (double-start guard); `tick()` with no job → "idle", no session opened; happy path → opens session FIRST, claims with that session id, sends `promptFor(job)` + schema, completes with `outcome:"posted"` + fields from the structured result, closes session, → "done"; send rejects or exceeds `jobTimeoutMs` → complete `outcome:"failed"` with the error string, session closed, → "failed", **and the loop keeps running** (next `tick` still fires); claim throws → logged, "idle", loop alive; complete throws after a posted result → logged, loop alive (console's stale-requeue is the safety net); `stop()` halts the interval. NOTHING may escape: every `tick` path resolves, never rejects (assert via a rejection-tripwire in tests).

- [ ] Steps: TDD (all cases above) → fail → implement (a plain `setInterval`-driven loop with an in-flight guard so ticks never overlap) → `cd apps/jace && pnpm test` green → Commit: `feat(jace): review-job worker core — never-throw claim/execute/complete loop (Arc B §4)`

---

### Task 6: Prompt template + console transport + instrumentation wiring

**Files:** Create `apps/jace/agent/lib/review_job_prompt.mjs`, `apps/jace/agent/lib/review_job_console.mjs`; modify `apps/jace/agent/instrumentation.ts`; Tests: `review_job_prompt.test.mjs` (prose pins), `review_job_console.core.test.mjs` (transport with injected fetch, `resolveConsoleConfig` convention duplicated per module like the sibling cores), and an instrumentation pin test if the file has one (read it — the Discord gateway block is the model).

**Interfaces:**
- `review_job_prompt.mjs` exports `reviewJobPrompt(job) -> string` and `REVIEW_JOB_RESULT_SCHEMA` (object: `{posted: boolean, reviewUrl: string|null, verdict: string, blockers: string[], summaryLine: string}`).
- The prompt text (verbatim-required bullets; adapt only surrounding glue):
```
You are executing review job <jobId> headlessly — no human is in this conversation.
Review PR #<prNumber> in <repo> at head <headSha>. Do exactly your normal review choreography:
- Dispatch the reviewer subagent for this PR. Relay its result with your standing honesty rules:
  acCoverage and judgment verbatim, cannot_judge never softened, evidence lines included.
- Post the review with post_pr_review. One review, one verdict.
- If acceptance criteria are behavioral (running-app behavior a diff cannot prove) AND the PR
  carries a reachable preview URL, dispatch qa against it and fold its ac_results into the posted
  review's coverage before posting. If there is no preview URL, do NOT guess: the affected ACs
  are not_testable with the concrete reason, and the posted review says which environment rung
  was reached.
- Do not create issues, send channel messages, or take any action beyond the review itself.
Return ONLY the structured result: posted, reviewUrl, verdict, blockers (every blocker-severity
finding title), summaryLine (one line for the owner: repo, PR, verdict, judgment verdicts).
```
- `review_job_console.mjs` exports `claimReviewJob({workerId, eveSessionId})` / `completeReviewJob(fields)` hitting `POST <JACE_CONSOLE_BASE_URL>/api/v1/runner/review-jobs/{claim,complete}` with `Authorization: Bearer <JACE_CONSOLE_TOKEN>`; 204 → null; non-2xx → throw with status (the worker core catches).
- `instrumentation.ts`: inside `setup()` beside the Discord gateway block: `if ((process.env.JACE_REVIEW_WORKER || "").trim() === "1") { void startReviewJobWorker(process.env).catch(...) }` — a thin `review_job_worker.mjs` assembler that builds `openSession` from `eve/client` (`Client({host: local})`.`session()` — mirror `apps/jace/scripts/needs-approval-roundtrip.mjs`'s client usage for host/port resolution), wires prompt/schema/transport, and calls `.start()`. Same discipline as the gateway: module-scope started-guard, no escaping rejection.

**Prose pins (mandatory):** prompt contains "Dispatch the reviewer subagent", "post_pr_review", "cannot_judge never softened", "not_testable with the concrete reason", "Do not create issues", "Return ONLY the structured result"; schema fields pinned; transport never sends `eveSessionId` in complete (only claim needs it).

- [ ] Steps: TDD → fail → implement → `cd apps/jace && pnpm test` green → Commit: `feat(jace): headless review worker wired — canned choreography prompt, flag-gated instrumentation start (Arc B §4)`

---

### Task 7: Python deletion, wave 1 — the runner's review half

**Files:** Modify `agentrail/afk/runner.py` (delete `_review` :429-467 and the review half of `_review_and_gate` :617-677 — the objective-gate fix loop survives, renamed if clearer; delete the "review produced no parseable output → fail" behavior), `agentrail/afk/state.py` (remove `IssueStatus.REVIEWING` :28 and `max_review_rounds` :71,343), `agentrail/afk/store.py` (drop `max_review_rounds` serialization :60,74), `agentrail/cli/commands/afk.py` (drop `--max-review-rounds` :35,82,118 + `max_review_rounds` config key). Fix the constructor-boilerplate test cluster (one-line changes): `test_runner_worktree_hooks.py`, `test_afk_options.py`, `test_store_roundtrip.py`, `test_runner_push_guardrail.py`, `observability/test_afk_session_env.py`. Delete `agentrail/tests/afk/test_runner_review.py`, `test_runner_review_gate.py`'s review-only cases (keep gate-push cases that survive — judge per test), `test_state.py`/`test_timeline.py` REVIEWING/max_review_rounds cases.

**Behavior contract:** after this task, `Runner._process` flows PR-creation → objective gate → done with NO review step, NO `REVIEWING` status ever set, and a full-suite run proves no orphaned references (`python3 -m pytest agentrail/tests/afk -q` green; a python heredoc scan for `REVIEWING|max_review_rounds|_review_and_gate|_review\b` over `agentrail/` returns only historical docs/spec files, no live code).

- [ ] Steps: scan-first (list every reference live), delete, fix tests, full afk suite green → Commit: `feat(afk): delete the runner's model-review step — one reviewer of record (Arc B §5)`

---

### Task 8: Python deletion, wave 2 — CLI, engine, parsers, templates + regression pin

**Files:** Delete `agentrail/afk/review_engine.py`, `agentrail/afk/review.py`, `agentrail/cli/commands/internal.py`'s `review-pr` subcommand (`_review_pr_native` :68-194 + its registration; if `internal.py` has other subcommands keep them), the findings half of `agentrail/afk/review_push.py` (`parse_findings` :73-120 + the `findings` field of `push_review_gate`'s payload; `push_review_gate`'s objective status/blockingReasons push and `push_memory_items` STAY), `agentrail/templates/docs/agents/pr-review.md` + `github-pr-reviewer.md`, `finalize_objective_gate`'s `review_advisory` param (`run/pipeline.py:397-428` + its `data["review"]` write + sole `None` call site + the tests constructing non-None in `test_pipeline_objective_gate.py`). Delete tests: `test_review.py`, `test_review_policy.py`, `test_review_engine.py`, `test_internal_cli.py`'s review-pr cases, `test_review_push.py`'s findings cases (keep objective-push cases). Create `agentrail/tests/afk/test_reviewer_of_record_deletion.py`:

```python
"""Arc B §5 regression pin: the pipeline's model-review step stays deleted."""


def test_internal_cli_has_no_review_pr_command():
    from agentrail.cli.commands import internal
    assert not hasattr(internal, "_review_pr_native")


def test_runner_has_no_review_attributes():
    from agentrail.afk.runner import Runner
    assert not hasattr(Runner, "_review")
    assert not hasattr(Runner, "_review_and_gate")


def test_review_modules_are_gone():
    import importlib.util
    for mod in ("agentrail.afk.review", "agentrail.afk.review_engine"):
        assert importlib.util.find_spec(mod) is None


def test_issue_status_has_no_reviewing():
    from agentrail.afk.state import IssueStatus
    assert not hasattr(IssueStatus, "REVIEWING")
```

**Do NOT touch** `doctor.py` / `_template_sync.py` legacy arrays.

- [ ] Steps: scan-first, delete, prune tests, add the pin, then `python3 -m pytest agentrail/tests/afk agentrail/tests/cli agentrail/tests/run -q` green → Commit: `feat(afk): delete review engine/CLI/parsers + review_advisory — deletion pinned (Arc B §5)`

---

### Task 9: Console cross-boundary e2e

**Files:** Test only — `apps/console/app/api/v1/webhooks/github-app/e2e.test.ts` (or the console's integration-test home; mirror its conventions).

One test walking the whole console side with fakes at the DB/notify boundaries the existing route tests already fake: signed webhook payload (opened, enrolled workspace, connected repo) → job row exists queued → claim with an `eveSessionId` → response carries the job AND the `jace_sessions` binding row exists with `channel:'review-job'` → complete `posted` with a summaryLine → job `posted` + notify fake called once with the summaryLine. Plus the storm variant: two `synchronize` deliveries for successive heads → first superseded, second eligible-deferred.

- [ ] Steps: write → green (wiring already landed; failures are integration bugs — fix production code, never weaken) → Commit: `test(console): reviewer-of-record e2e — webhook to notify through the queue (Arc B)`

---

### Task 10: Whole-arc verification + AC walk

- [ ] **Step 1:** Full sweeps: db-postgres, console, jace (`--ignore-workspace` install reminder), `python3 -m pytest agentrail/tests -q` (or the focused superset if the full run is impractical locally — record what ran).
- [ ] **Step 2:** Walk the AC checklist below; name the proving file/test per item; unproven → back to its task.
- [ ] **Step 3:** Push + PR (coordinator runs the final whole-branch review + merge sequence).

## Acceptance criteria (final walk)

1. **Webhook fail-closed:** unset secret → 401 pinned; bad signature 401; verification precedes body trust; classic route untouched.
2. **Event discipline:** only `pull_request` opened/ready_for_review/reopened/synchronize enqueue; drafts skipped; synchronize deferred 60s; everything else 200-ignored; malformed-after-auth 200-ignored.
3. **Server-side resolution:** workspace from `installation.id` via the new query; repo ownership via `getRepositoryByName`; rollout gate `REVIEWER_OF_RECORD_WORKSPACES` enforced; nothing caller-supplied trusted.
4. **Queue semantics:** deterministic-id dedupe; supersede flips only `queued` siblings (EvalPlanQual predicate on the outer WHERE, pinned); SKIP LOCKED claim with one winner under contention; per-workspace no-second-running fairness; oldest-first; stale requeue then terminal fail; budget → visible `skipped`.
5. **Session binding:** claim inserts the `jace_sessions` row (workspace anchor, `channel:'review-job'`, per-job conversationKey); **zero diffs** in the six session-resolving tool modules; binding failure releases the claim.
6. **Complete + notify:** guarded complete; notify exactly once on `posted` through the existing console notify machinery with summary line + URL + judgment verdicts + blockers; `failed` retries with backoff then terminal.
7. **Worker:** flag-gated (`JACE_REVIEW_WORKER`), instrumentation-launched with double-start guard, never-throw tick discipline, session-per-job opened before claim and closed after, timeout → failed + loop alive.
8. **Choreography prompt:** verbatim bullets pinned (reviewer dispatch, honest relay, post_pr_review, rung-1 QA fold, rung-3 not_testable wording, no-side-actions rule, structured-result-only).
9. **Deletion complete:** review step, CLI, engine, both parsers' findings paths, REVIEWING, max_review_rounds, templates, review_advisory all gone; objective-gate push + memory push survive; doctor/_template_sync untouched; regression pin green; live-code scan clean.
10. **Deploy-order safety:** intake with worker off queues; worker with intake off idles (204 path); both flags default off/empty.
11. **Naming + non-regression:** new code never says "review gate"; `post_pr_review` and the six resolver modules have zero diffs.
