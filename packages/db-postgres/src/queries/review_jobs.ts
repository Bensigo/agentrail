import { createHash } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import { reviewJobs } from "../schema/review_jobs.js";
import type { ReviewJobRow } from "../schema/review_jobs.js";
import { jaceSessions } from "../schema/jace_sessions.js";

/**
 * Reviewer of Record queue queries (Arc B §2-§3, spec
 * docs/superpowers/specs/2026-07-31-reviewer-of-record-design.md). Every
 * exported function here operates on the `review_jobs` table (schema:
 * `../schema/review_jobs.ts`) landed by the prior task on this branch — see
 * that file's doc-comment for the full state-lifecycle picture
 * (queued -> running -> posted|failed, plus superseded/skipped).
 *
 * Naming: "review job", never "review gate" — `review_gates` is a
 * DIFFERENT, unrelated table (per-run CI+advisory telemetry).
 */

// --- deterministic row id (mirrors github_intake.ts's entryId) --------------

// RFC 4122 URL namespace — the same one Python's uuid.NAMESPACE_URL uses,
// byte-for-byte the same constant `github_intake.ts`'s own copy uses for
// `entryId`. Duplicated (not imported) because `github_intake.ts` does not
// export its `uuid5Url` helper — this module mirrors the MECHANISM exactly
// while staying independent of that file's queue_entries-specific code.
const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/** uuid5(NAMESPACE_URL, name) — deterministic, so the same logical job always
 *  maps to the same row. Identical algorithm to `github_intake.ts`'s private
 *  `uuid5Url`. */
function uuid5Url(name: string): string {
  const ns = Buffer.from(NAMESPACE_URL.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(ns)
    .update(Buffer.from(name, "utf8"))
    .digest();
  const b = hash.subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * The durable row id for a (workspaceId, repo, prNumber, headSha) — the
 * review-job twin of `entryId` (github_intake.ts:475-481): same uuid5
 * mechanism, namespace seed `"review-job"` in place of `entryId`'s
 * `"agentrail-queue"`. Deterministic so a replayed webhook delivery for the
 * SAME (workspace, repo, PR, head) always re-derives the SAME id, which is
 * what makes `enqueueReviewJob`'s `ON CONFLICT (id) DO NOTHING` an
 * exactly-once admit (see `review_jobs.ts`'s schema doc-comment — a random
 * id here would silently defeat that).
 */
export function reviewJobId(input: {
  workspaceId: string;
  repo: string;
  prNumber: number;
  headSha: string;
}): string {
  return uuid5Url(
    `review-job:${input.workspaceId}:${input.repo}:${input.prNumber}:${input.headSha}`
  );
}

/**
 * Read the review-job history for one PR, oldest first. Workspace-scoped and
 * repo/pr-specific — a caller must already have resolved the PR identity from
 * a trusted run row before asking for this history.
 */
export async function listReviewJobsForPr(input: {
  workspaceId: string;
  repo: string;
  prNumber: number;
}): Promise<ReviewJobRow[]> {
  return db
    .select()
    .from(reviewJobs)
    .where(
      and(
        eq(reviewJobs.workspaceId, input.workspaceId),
        eq(reviewJobs.repo, input.repo),
        eq(reviewJobs.prNumber, input.prNumber)
      )
    )
    .orderBy(reviewJobs.createdAt);
}

/**
 * Read only review jobs for the exact head a run published. A run-level
 * evidence surface must use this instead of the PR-wide history so a later
 * push cannot be presented as evidence for an earlier run.
 */
export async function listReviewJobsForPrHead(input: {
  workspaceId: string;
  repo: string;
  prNumber: number;
  headSha: string;
}): Promise<ReviewJobRow[]> {
  return db
    .select()
    .from(reviewJobs)
    .where(
      and(
        eq(reviewJobs.workspaceId, input.workspaceId),
        eq(reviewJobs.repo, input.repo),
        eq(reviewJobs.prNumber, input.prNumber),
        eq(reviewJobs.headSha, input.headSha)
      )
    )
    .orderBy(reviewJobs.createdAt);
}

// --- row mapping (raw db.execute results are snake_case) --------------------

/**
 * Every raw-SQL statement below uses `RETURNING *` (or an explicit column
 * list) against the `postgres` driver directly, which hands back snake_case
 * keys unmapped by drizzle's schema layer — mirrors `claimQueueEntry`'s own
 * manual mapping (`runner.ts:672-774`). This is the single place that
 * reshapes such a raw row into the camelCase `ReviewJobRow` shape drizzle's
 * `$inferSelect` produces, so every claim/complete caller sees one
 * consistent type regardless of which raw statement produced the row.
 *
 * Timestamp columns need an explicit `new Date(...)` conversion, not just a
 * TS cast: verified empirically (this task's report) that
 * `db.execute(sql\`...\`)` — unlike the drizzle query-builder path
 * (`db.select()`), which maps `timestamptz` columns to `Date` itself — hands
 * back every `timestamptz` value as a raw wire string (e.g.
 * `"2026-08-01 11:19:21.631415+00"`). `claimQueueEntry`'s own precedent
 * never had to handle this because its `RETURNING` list carries no
 * timestamp column; a bare `as Date` cast here would compile fine and then
 * silently hand every caller (Task 4's routes) a string with a `Date`-typed
 * lie — `.getTime()`/`.toISOString()` would throw or misbehave at runtime.
 */
function toDateOrNull(value: unknown): Date | null {
  return value == null ? null : new Date(value as string);
}

function mapReviewJobRow(row: Record<string, unknown>): ReviewJobRow {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    repo: row.repo as string,
    prNumber: row.pr_number as number,
    headSha: row.head_sha as string,
    event: row.event as string,
    state: row.state as string,
    attempts: row.attempts as number,
    claimedBy: (row.claimed_by as string | null) ?? null,
    claimedAt: toDateOrNull(row.claimed_at),
    nextEligibleAt: toDateOrNull(row.next_eligible_at),
    postedReviewUrl: (row.posted_review_url as string | null) ?? null,
    verdict: (row.verdict as string | null) ?? null,
    skipReason: (row.skip_reason as string | null) ?? null,
    // jsonb comes back ALREADY PARSED from `db.execute` — postgres.js (the
    // underlying driver, see ../db.ts) has a built-in jsonb type parser that
    // runs regardless of drizzle's own query-builder path, so unlike the
    // timestamp columns above this needs no explicit conversion (mirrors
    // channel_inbox.ts's `claimNextChannelMessage`, whose own raw-row
    // `payload` field is passed through the same way, no JSON.parse). Null
    // while the column is unset (queued/running, or a posted completion
    // that didn't carry evidenceKeys — see completeReviewJob's own
    // doc-comment).
    evidenceKeys: (row.evidence_keys as string[] | null) ?? null,
    createdAt: toDateOrNull(row.created_at) as Date,
    updatedAt: toDateOrNull(row.updated_at) as Date,
  };
}

// --- enqueue + supersede ------------------------------------------------------

export type EnqueueReviewJobResult = {
  id: string;
  /** True when the deterministic id already existed (`ON CONFLICT (id) DO
   *  NOTHING` matched) — a replayed webhook delivery for the exact same
   *  (workspace, repo, PR, head), not a new row. */
  deduped: boolean;
  /** How many OTHER still-`queued` jobs for this (workspace, repo, PR) were
   *  flipped to `superseded` by this call (a newer push replacing an older,
   *  not-yet-run head). Zero on a lone/first job for a PR, or on a dedupe
   *  that has no other queued sibling. */
  superseded: number;
};

/**
 * Admit one PR event as a durable, idempotent `review_jobs` row, then
 * supersede any OTHER still-`queued` job for the SAME (workspace, repo,
 * prNumber) whose head differs — a push storm's newest head wins the race to
 * be reviewed, older still-queued heads are stood down rather than piling up.
 *
 * `event === 'synchronize'` seeds `next_eligible_at` ~60s out (debounce): a
 * rapid-fire push storm's LATER heads get a chance to land their OWN row and
 * run the supersede below against still-ineligible OLDER heads before any of
 * them is actually claimable. `opened`/`reopened`/other events are eligible
 * immediately (`next_eligible_at` stays null). Computed with the DB's own
 * `now()` (not the app server's `Date.now()`) so every time comparison in
 * this module shares one clock.
 *
 * ARC B REVIEW FIX — mutual-supersede race (Important defect): the insert
 * and the supersede used to be two separate, non-transactional round trips.
 * Two concurrent enqueues for the SAME PR (GitHub redeliveries, or a
 * `synchronize` burst) could each commit their own insert, then each run
 * their own supersede against the OTHER's now-queued row — `head_sha <>
 * own` + `state = 'queued'` matches the sibling for BOTH callers under
 * READ COMMITTED, since each transaction's supersede is a separate
 * statement that only ever excludes ITS OWN head. Both rows end
 * `superseded` and the PR silently gets zero eligible jobs — reproduced
 * directly (see this task's report) before this fix, on the very first
 * `Promise.all([enqueueReviewJob(shaA), enqueueReviewJob(shaB)])` iteration.
 *
 * Fix: the insert + supersede now run inside ONE `db.transaction`, whose
 * FIRST statement takes a per-PR `pg_advisory_xact_lock` (blocking, not the
 * `_try_` variant — an enqueue is rare and latency-tolerant, so waiting for
 * a same-PR peer to finish is simpler than deciding what to do on a failed
 * try-lock; contrast `channel_inbox.ts`'s `pg_try_advisory_xact_lock`
 * embedded inline in a single hot claim statement, a different shape for a
 * different problem — that lock lets a busy claim loop skip contended work
 * instantly rather than block). The lock key is `review-job:<workspaceId>:
 * <repo>:<prNumber>` — scoped to the PR, not the head — so ANY two
 * concurrent enqueues for the same PR (regardless of head) are fully
 * serialized: whichever acquires the lock first runs its ENTIRE
 * insert+supersede pair, commits (which releases the advisory lock), and
 * only then does the second transaction proceed against the now-committed,
 * fully-consistent state. `pg_advisory_xact_lock` auto-releases at
 * transaction end (commit or rollback) — no manual unlock needed.
 *
 * The supersede's own WHERE keeps ALL FOUR original predicates plus the
 * EvalPlanQual doctrine (`confirmAlignmentBrief` precedent, github_intake.ts
 * :996-1057): `state = 'queued'` is repeated on the UPDATE's OWN WHERE
 * rather than left to a CTE alone, so Postgres's EvalPlanQual re-checks it
 * against the freshly-locked row version at lock time, not a stale
 * statement-start snapshot. There is no CTE here at all (a single flat
 * UPDATE), but the predicate placement is preserved for the same reason:
 * if this is ever refactored to use a CTE to compute the candidate set, the
 * `state = 'queued'` predicate MUST stay on the UPDATE's own WHERE too, not
 * move solely into the CTE. The advisory lock serializes ACROSS
 * transactions (closing the race above); this repeated predicate is what
 * still guards correctness WITHIN one transaction/statement — the two are
 * complementary, neither replaces the other.
 *
 * ARC B REVIEW FIX WAVE 2 — deduped-supersede guard (Important defect, the
 * SEQUENTIAL sibling of the concurrent race above; the advisory lock does
 * NOT help here since there is no concurrency, just a stale redelivery
 * arriving late). Sequence: enqueue(head A) -> enqueue(head B) supersedes A
 * (the correct, normal single-caller path, B now the queued survivor) ->
 * GitHub REDELIVERS the now-dead head-A webhook -> the deterministic id
 * hits `ON CONFLICT (id) DO NOTHING` (`deduped = true`) -> if the supersede
 * ran anyway, `head_sha <> 'A'` still matches B (still `queued`) and flips
 * the legitimate survivor to `superseded` too — both rows dead, PR silently
 * unreviewed, purely sequentially (reproduced directly, see this task's
 * report). Fix: the supersede now runs ONLY when the insert actually
 * inserted (`!deduped`) — semantics: an enqueue that created no new row
 * supersedes nothing, because dedupe means "this exact head is already
 * tracked; its siblings were already handled back when THIS head first
 * inserted." A deduped call returns `superseded: 0` unconditionally.
 *
 * KNOWN ACCEPTED RESIDUAL (do not attempt to fix): an out-of-order FIRST
 * delivery of an OLDER head arriving AFTER a newer head's enqueue is a
 * genuinely NEW id (never seen before) — it will still insert and still
 * supersede the newer, currently-queued row, because nothing here can tell
 * "this head is chronologically older" from a bare webhook payload; true
 * commit/delivery ordering isn't knowable from the GitHub event alone. This
 * is the supersede-never-cancel design's accepted edge: the wrong head
 * would get reviewed once, that posted review is honestly labeled with its
 * own `headSha` (never misrepresented as reviewing the current tip), and
 * the PR's next real event (its next legitimate push) self-heals the queue
 * by superseding that stale review's job in turn.
 */
export async function enqueueReviewJob(input: {
  workspaceId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  event: string;
}): Promise<EnqueueReviewJobResult> {
  const id = reviewJobId(input);
  const lockKey = `review-job:${input.workspaceId}:${input.repo}:${input.prNumber}`;

  return db.transaction(async (tx) => {
    // Must be the FIRST statement in the transaction: every concurrent
    // enqueue for this PR blocks here until the current holder commits
    // (releasing the lock), so no two insert+supersede pairs for the same
    // PR ever interleave.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

    const inserted = Array.from(
      await tx.execute(sql`
        INSERT INTO review_jobs (id, workspace_id, repo, pr_number, head_sha, event, next_eligible_at)
        VALUES (
          ${id}, ${input.workspaceId}, ${input.repo}, ${input.prNumber}, ${input.headSha}, ${input.event},
          CASE WHEN ${input.event} = 'synchronize' THEN now() + interval '60 seconds' ELSE NULL END
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `)
    );
    const deduped = inserted.length === 0;

    // Deduped-supersede guard (Arc B review fix wave 2 — see this
    // function's doc-comment for the redelivery scenario this closes): a
    // redelivery of an already-tracked head must be a hard no-op. Running
    // the supersede anyway would let a dead head's stale webhook flip the
    // CURRENT legitimate survivor to `superseded` too.
    if (deduped) {
      return { id, deduped: true, superseded: 0 };
    }

    const superseded = Array.from(
      await tx.execute(sql`
        UPDATE review_jobs
        SET state = 'superseded', updated_at = now()
        WHERE workspace_id = ${input.workspaceId}
          AND repo = ${input.repo}
          AND pr_number = ${input.prNumber}
          AND head_sha <> ${input.headSha}
          AND state = 'queued'
        RETURNING id
      `)
    );

    return { id, deduped: false, superseded: superseded.length };
  });
}

// --- claim --------------------------------------------------------------------

/**
 * Stale-running pre-pass: a job stuck `running` for >15 minutes (a worker
 * that crashed/hung mid-review) is requeued with `attempts` bumped, exactly
 * like the claim's own pre-pass step, run unconditionally on every claim
 * attempt (cheap — a partial index backs `state = 'queued'`, and this
 * predicate is `state = 'running'`, a small, terminal-poor set in practice).
 */
async function requeueStaleRunningReviewJobs(): Promise<void> {
  await db.execute(sql`
    UPDATE review_jobs
    SET state = 'queued', attempts = attempts + 1, claimed_by = NULL, claimed_at = NULL, updated_at = now()
    WHERE state = 'running' AND claimed_at < now() - interval '15 minutes'
  `);
}

/**
 * Terminal pre-pass: a `queued` job that has already exhausted its retry
 * budget (bumped by the stale-running pre-pass above, run-over-run) is
 * escalated to terminal `failed` rather than being claimed and requeued
 * forever.
 */
async function failStaleQueuedReviewJobs(): Promise<void> {
  await db.execute(sql`
    UPDATE review_jobs
    SET state = 'failed', skip_reason = 'stale after retries', updated_at = now()
    WHERE state = 'queued' AND attempts > 2
  `);
}

/**
 * The atomic claim, copying `claimQueueEntry`'s single-statement shape
 * (`runner.ts:672-774`): select-the-oldest-eligible + flip to `running` in
 * ONE `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)` statement,
 * so two concurrent claimers never claim the same row (SKIP LOCKED lets the
 * loser's inner SELECT skip past a row a concurrent claim is already
 * locking, rather than blocking on it).
 *
 * The `NOT EXISTS` clause additionally bounds concurrency to at most one
 * `running` review job per workspace at a time — a workspace's OTHER queued
 * PRs simply wait their turn rather than every open PR getting reviewed
 * simultaneously.
 */
async function claimEligibleReviewJob(input: {
  workerId: string;
  dailyBudget: number;
}): Promise<ReviewJobRow | null> {
  const claimed = Array.from(
    await db.execute(sql`
      UPDATE review_jobs
      SET state = 'running', claimed_by = ${input.workerId}, claimed_at = now(), updated_at = now()
      WHERE id = (
        SELECT id FROM review_jobs rj
        WHERE state = 'queued'
          AND (next_eligible_at IS NULL OR next_eligible_at <= now())
          AND NOT EXISTS (
            SELECT 1 FROM review_jobs r2
            WHERE r2.workspace_id = rj.workspace_id AND r2.state = 'running'
          )
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `)
  ) as Array<Record<string, unknown>>;

  const raw = claimed[0];
  if (!raw) return null;
  const row = mapReviewJobRow(raw);

  // Budget check (spec §2 "Budget"): count today's (UTC calendar date of
  // created_at) non-superseded jobs for THIS candidate's workspace. Simplest
  // correct form per the brief — claim first, then decide, rather than
  // trying to fold the budget count into the claim's own WHERE (that would
  // need a correlated aggregate subquery re-evaluated per candidate row,
  // considerably harder to reason about for one extra round trip that only
  // fires when a workspace is already at/over budget).
  const countRows = Array.from(
    await db.execute(sql`
      SELECT count(*)::int AS count
      FROM review_jobs
      WHERE workspace_id = ${row.workspaceId}
        AND state <> 'superseded'
        AND (created_at AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date
    `)
  ) as Array<{ count: number }>;
  const countToday = Number(countRows[0]?.count ?? 0);

  if (countToday > input.dailyBudget) {
    // Flip THIS candidate to skipped (never silent — skip_reason always
    // set, matching the schema's "never silent" budget-skip contract) and
    // recurse to the next candidate. Recursion terminates because each call
    // either claims a row it does not immediately skip, or moves a
    // candidate to a terminal state (skipped) so it can never be
    // reconsidered — the set of `queued` rows strictly shrinks or the
    // function returns.
    await db.execute(sql`
      UPDATE review_jobs
      SET state = 'skipped', skip_reason = 'daily budget exhausted', updated_at = now()
      WHERE id = ${row.id}
    `);
    return claimEligibleReviewJob(input);
  }

  return row;
}

/**
 * Claim the next eligible review job for a worker: stale-requeue pre-pass,
 * then terminal-fail pre-pass, then the atomic SKIP LOCKED claim + budget
 * check. Returns null when nothing is eligible (queue empty, everything
 * ineligible/debounced, or every candidate workspace is over budget).
 */
export async function claimReviewJob(input: {
  workerId: string;
  dailyBudget: number;
}): Promise<ReviewJobRow | null> {
  await requeueStaleRunningReviewJobs();
  await failStaleQueuedReviewJobs();
  return claimEligibleReviewJob(input);
}

// --- complete -------------------------------------------------------------

export type CompleteReviewJobInput = {
  jobId: string;
  outcome: "posted" | "failed";
  postedReviewUrl?: string | null;
  verdict?: string | null;
  error?: string | null;
  // B2a §1 Task 3 — the object-store keys (Task 2's `review-evidence`
  // upload route) a completed review actually cited. Written ONLY on the
  // `posted` branch below, and only when present (`== null` — covers both
  // `undefined` and an explicit `null` — leaves the column untouched at SQL
  // NULL); the `failed` branch never references `evidence_keys` at all, by
  // construction, so passing this on a failed completion is silently a
  // no-op, never a write. See schema/review_jobs.ts's own doc-comment for
  // why NULL and `[]` must stay distinguishable.
  evidenceKeys?: string[] | null;
};

/**
 * Resolve a claimed (`running`) review job. Guarded by `WHERE id = $1 AND
 * state = 'running'` so a duplicate/late completion call (e.g. a retried
 * worker callback) is a no-op — returns null rather than clobbering
 * whatever already resolved the job.
 *
 * `outcome: 'failed'` uses a simple FIXED 5-minute backoff — deliberately
 * NOT `nextQueueTransition`'s exponential+jittered schedule
 * (`computeBackoffDelayMs`/`backoffFloorMs`, #1389). A review-posting
 * failure is rare (a transient GitHub API hiccup on an otherwise-completed
 * review, not a flaky multi-minute agent run) and cheap to retry, so a flat
 * delay is the simplest-correct v1; revisit only if review retries turn out
 * to cluster the way runner retries did.
 *
 * Beyond the brief's literal fields, `claimed_by`/`claimed_at` are cleared
 * when a job goes back to `queued` for retry (mirroring the stale-running
 * pre-pass's own running->queued reset in `claimReviewJob` — a `queued` row
 * should never carry a stale claimant) but left untouched on a terminal
 * outcome (`posted` or terminally `failed`), where they double as "who last
 * worked this / when" audit info. Also, a terminal `failed` with no `error`
 * supplied falls back to a fixed message rather than a null `skip_reason` —
 * the schema's own doc-comment says `skip_reason` is never silent for a
 * terminal row.
 *
 * B2a §1 Task 3: `evidenceKeys`, when present, is written to `evidence_keys`
 * ONLY on the `posted` branch — the `failed` branch's UPDATE has no
 * `evidence_keys` clause at all, so it structurally can never set the
 * column regardless of what a caller passes. Absent/null `evidenceKeys` on
 * a `posted` completion writes SQL NULL (`::jsonb` cast on a bound `null`
 * parameter), never `'null'::jsonb` or `'[]'::jsonb` — additive: a caller
 * that never learned about this field behaves byte-identically to before
 * it existed.
 */
export async function completeReviewJob(
  input: CompleteReviewJobInput
): Promise<ReviewJobRow | null> {
  if (input.outcome === "posted") {
    const evidenceKeysJson =
      input.evidenceKeys == null ? null : JSON.stringify(input.evidenceKeys);
    const rows = Array.from(
      await db.execute(sql`
        UPDATE review_jobs
        SET state = 'posted',
            posted_review_url = ${input.postedReviewUrl ?? null},
            verdict = ${input.verdict ?? null},
            evidence_keys = ${evidenceKeysJson}::jsonb,
            updated_at = now()
        WHERE id = ${input.jobId} AND state = 'running'
        RETURNING *
      `)
    ) as Array<Record<string, unknown>>;
    const raw = rows[0];
    return raw ? mapReviewJobRow(raw) : null;
  }

  const rows = Array.from(
    await db.execute(sql`
      UPDATE review_jobs
      SET attempts = attempts + 1,
          state = CASE WHEN attempts + 1 > 2 THEN 'failed' ELSE 'queued' END,
          next_eligible_at = CASE WHEN attempts + 1 > 2 THEN NULL ELSE now() + interval '5 minutes' END,
          skip_reason = CASE WHEN attempts + 1 > 2
            THEN COALESCE(${input.error ?? null}, 'review failed (no error detail)')
            ELSE NULL
          END,
          claimed_by = CASE WHEN attempts + 1 > 2 THEN claimed_by ELSE NULL END,
          claimed_at = CASE WHEN attempts + 1 > 2 THEN claimed_at ELSE NULL END,
          updated_at = now()
      WHERE id = ${input.jobId} AND state = 'running'
      RETURNING *
    `)
  ) as Array<Record<string, unknown>>;
  const raw = rows[0];
  return raw ? mapReviewJobRow(raw) : null;
}

// --- release (post-claim, pre-complete escape hatch) -------------------------

/**
 * Release a claimed review job back to `queued` after a POST-CLAIM failure
 * that is NOT the worker's fault — Task 4's claim route calls this when its
 * own `bindReviewJobSession` call throws right after a successful
 * `claimEligibleReviewJob`: the row is already `running`, but the caller can
 * make no further progress (no session bound), so it must not be left
 * dangling forever. Without this, the ONLY recovery would be the 15-minute
 * stale-running pre-pass (`requeueStaleRunningReviewJobs`) — correct
 * eventually, but a needless quarter-hour stall for what is usually a
 * transient bind/db hiccup.
 *
 * Guarded exactly like `completeReviewJob`'s own UPDATEs (`WHERE id = $1 AND
 * state = 'running'`), so this is always safe to call: a job that already
 * moved on (re-claimed after this call raced with the stale-running
 * pre-pass, or resolved to a terminal state some other way) is a silent
 * no-op, never a resurrection/clobber of whatever state it is actually in.
 * An unknown `jobId` matches zero rows for the same reason — also a no-op,
 * never a throw (unlike `bindReviewJobSession`'s "unknown id is a caller
 * bug" contract: a release racing a job's own natural completion is an
 * expected, ordinary outcome here, not a bug).
 *
 * Deliberately does NOT bump `attempts` or set `skip_reason`/
 * `next_eligible_at`: this is an infra release of the CALLER's own claim,
 * not a worker-reported review failure (that path is `completeReviewJob`'s
 * `outcome: 'failed'` branch, which owns the retry/backoff/terminal-escalate
 * policy). A released job is immediately eligible again, exactly as if it
 * had never been claimed.
 */
export async function releaseReviewJob(input: { jobId: string }): Promise<void> {
  await db.execute(sql`
    UPDATE review_jobs
    SET state = 'queued', claimed_by = NULL, claimed_at = NULL, updated_at = now()
    WHERE id = ${input.jobId} AND state = 'running'
  `);
}

// --- session binding --------------------------------------------------------

/**
 * Read a review job's CURRENT state, or null if no such row exists.
 *
 * Arc B review fix wave (per-job session restructure): claim no longer
 * binds a session — that moved to its own console route, `bind`, called
 * once a session has been opened for an actual claimed job. That route
 * needs to reject binding a job that isn't (or is no longer) `running`
 * (e.g. reclaimed by the stale-running pre-pass while the worker was
 * mid-bootstrap) with a 409 — but `bindReviewJobSession` itself has NO
 * state precondition (a plain SELECT with no `WHERE state = ...`, unlike
 * `completeReviewJob`/`releaseReviewJob`'s own guarded `UPDATE ... WHERE
 * id = $1 AND state = 'running'`), so it cannot signal that distinction on
 * its own. This is the minimal, purely-additive read the bind route
 * composes with the UNCHANGED `bindReviewJobSession` to make that check
 * possible — it does not modify `bindReviewJobSession`'s own contract,
 * behavior, or tests in any way.
 *
 * Deliberately returns `null` rather than throwing for an unknown id — the
 * bind route's own "not running" branch treats `state !== "running"`
 * (which is true for both "doesn't exist" and "exists but some other
 * state") as ONE outcome, mirroring `completeReviewJob`'s own established
 * "unknown job OR not-running -> 409" precedent (see that route's own
 * doc-comment) rather than inventing a distinct status for an edge case
 * with the same practical remedy.
 */
export async function getReviewJobState(jobId: string): Promise<string | null> {
  const rows = await db
    .select({ state: reviewJobs.state })
    .from(reviewJobs)
    .where(eq(reviewJobs.id, jobId))
    .limit(1);
  return rows[0]?.state ?? null;
}

/**
 * Bind (or re-bind) the Eve session backing a review job's own
 * (workspace, channel='review-job', conversationKey) row in `jace_sessions`
 * — the same session store every other Jace channel uses, so review-job
 * turns get the same publish/approval plumbing for free. The conversation
 * key is scoped to this one job (`review-job:<jobId>`), never reused, so a
 * re-bind (ON CONFLICT) only ever happens for the SAME job resuming an
 * existing conversation (e.g. a re-claim after a crash), never two different
 * jobs colliding.
 *
 * Throws when `jobId` does not name an existing `review_jobs` row: unlike a
 * lookup, this function's contract is `Promise<void>` with no null/false
 * escape hatch for "not found" — a caller passing an unknown id is a caller
 * bug, and failing loudly is better than silently doing nothing.
 */
export async function bindReviewJobSession(input: {
  jobId: string;
  eveSessionId: string;
}): Promise<void> {
  const jobRows = await db
    .select({ workspaceId: reviewJobs.workspaceId })
    .from(reviewJobs)
    .where(eq(reviewJobs.id, input.jobId))
    .limit(1);
  const job = jobRows[0];
  if (!job) {
    throw new Error(
      `bindReviewJobSession: no review_jobs row for id ${input.jobId}`
    );
  }

  const conversationKey = `review-job:${input.jobId}`;

  await db
    .insert(jaceSessions)
    .values({
      workspaceId: job.workspaceId,
      channel: "review-job",
      conversationKey,
      eveSessionId: input.eveSessionId,
      status: "active",
    })
    .onConflictDoUpdate({
      target: [
        jaceSessions.workspaceId,
        jaceSessions.channel,
        jaceSessions.conversationKey,
      ],
      set: { eveSessionId: input.eveSessionId, updatedAt: new Date() },
    });
}
