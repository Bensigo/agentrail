import { createHash } from "crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import { previewBoots } from "../schema/preview_boots.js";
import type { PreviewBootRow } from "../schema/preview_boots.js";

/**
 * The boot plane's queue queries (B2b Task 2, plan
 * docs/superpowers/plans/2026-08-02-b2b-sandbox-boot.md; spec
 * docs/superpowers/specs/2026-08-02-b2-behavioral-evidence-design.md §B2b
 * §4-5). Every exported function here operates on the `preview_boots` table
 * (schema: `../schema/preview_boots.ts`) landed by the prior task on this
 * branch — see that file's doc-comment for the full state-lifecycle picture
 * (pending -> claimed -> booting -> ready, plus terminal failed/torn_down).
 *
 * Modeled directly on `review_jobs.ts`: the same uuid5 deterministic-id
 * mechanism, the same advisory-xact-lock enqueue+supersede transaction
 * shape, the same SKIP LOCKED claim, the same guarded
 * `WHERE id = $ AND status = $ RETURNING *` transition style, and the same
 * `db.execute` raw-row `mapRow`/`toDateOrNull` mapping (a plain
 * `db.execute(sql\`...\`)` hands back snake_case keys with timestamptz
 * columns as wire strings, unlike the drizzle query-builder `db.select()`
 * path used by `getPreviewBoot` below, which maps them to `Date` itself).
 *
 * Key difference from `review_jobs`: a preview boot is SINGLE-ATTEMPT, not
 * retriable. There is no "running" job that gets requeued back to a claimable
 * state after a stale timeout — a boot whose liveness goes stale is failed
 * outright (see `expireStalePreviewBoots` below and the schema's own
 * lifecycle doc-comment, which lists no back-to-pending path). This is why
 * `claimPreviewBoot`'s pre-pass is one function call
 * (`expireStalePreviewBoots`, which itself runs two independent UPDATE
 * sweeps — see its own doc-comment) rather than review_jobs.ts's two-part
 * requeue-stale-running-then-fail-exhausted-queued pair.
 */

// --- deterministic row id (mirrors review_jobs.ts's reviewJobId) -----------

// RFC 4122 URL namespace — byte-for-byte the same constant
// `review_jobs.ts`'s own copy uses (itself copied from `github_intake.ts`,
// which does not export its `uuid5Url` helper). Duplicated here rather than
// imported for the same reason review_jobs.ts gives: this module mirrors the
// MECHANISM exactly while staying independent of that file's review-job-
// specific code.
const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/** uuid5(NAMESPACE_URL, name) — deterministic, so the same logical boot
 *  request always maps to the same row. Identical algorithm to
 *  `review_jobs.ts`'s private `uuid5Url`. */
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
 * preview-boot twin of `review_jobs.ts`'s `reviewJobId`: same uuid5
 * mechanism, namespace seed `"preview-boot"` in place of `"review-job"`.
 * Deterministic so a replayed/duplicate boot request for the SAME
 * (workspace, repo, PR, head) always re-derives the SAME id, which is what
 * makes `enqueuePreviewBoot`'s `ON CONFLICT (id) DO NOTHING` an
 * exactly-once admit — see `schema/preview_boots.ts`'s own doc-comment on
 * `id` for why a random id here would silently defeat that.
 */
export function previewBootId(input: {
  workspaceId: string;
  repo: string;
  prNumber: number;
  headSha: string;
}): string {
  return uuid5Url(
    `preview-boot:${input.workspaceId}:${input.repo}:${input.prNumber}:${input.headSha}`
  );
}

// --- row mapping (raw db.execute results are snake_case) --------------------

/**
 * Every raw-SQL statement below (claim/report/expire) uses `RETURNING *`
 * against the `postgres` driver directly, which hands back snake_case keys
 * unmapped by drizzle's schema layer — mirrors `review_jobs.ts`'s own
 * `mapReviewJobRow`/`toDateOrNull` pair. Timestamp columns need an explicit
 * `new Date(...)` conversion, not just a TS cast: `db.execute(sql\`...\`)`
 * hands back every `timestamptz` value as a raw wire string (e.g.
 * `"2026-08-02 10:00:00.000000+00"`), unlike `db.select()` (used by
 * `getPreviewBoot` below), which maps `timestamptz` columns to `Date` itself.
 * A bare `as Date` cast here would compile fine and then silently hand every
 * caller a string with a `Date`-typed lie.
 */
function toDateOrNull(value: unknown): Date | null {
  return value == null ? null : new Date(value as string);
}

function mapPreviewBootRow(row: Record<string, unknown>): PreviewBootRow {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    repo: row.repo as string,
    prNumber: row.pr_number as number,
    headSha: row.head_sha as string,
    ref: row.ref as string,
    status: row.status as string,
    workerId: (row.worker_id as string | null) ?? null,
    claimedAt: toDateOrNull(row.claimed_at),
    url: (row.url as string | null) ?? null,
    port: (row.port as number | null) ?? null,
    reason: (row.reason as string | null) ?? null,
    attempts: row.attempts as number,
    expiresAt: toDateOrNull(row.expires_at),
    lastLivenessAt: toDateOrNull(row.last_liveness_at),
    nextEligibleAt: toDateOrNull(row.next_eligible_at),
    createdAt: toDateOrNull(row.created_at) as Date,
    updatedAt: toDateOrNull(row.updated_at) as Date,
  };
}

// --- enqueue + supersede ------------------------------------------------------

export type EnqueuePreviewBootResult = {
  id: string;
  /** True when the deterministic id already existed (`ON CONFLICT (id) DO
   *  NOTHING` matched) — a duplicate/replayed boot request for the exact
   *  same (workspace, repo, PR, head), not a new row. */
  deduped: boolean;
  /** How many OTHER still-non-terminal (`pending|claimed|booting|ready`)
   *  boots for this (workspace, repo, prNumber) were flipped to `torn_down`
   *  by this call — a newer push's boot request obsoletes an older,
   *  still-in-flight one for the same PR. Zero on a lone/first boot for a
   *  PR, or on a dedupe (see the deduped-guard note below). */
  superseded: number;
};

/**
 * Admit one boot request as a durable, idempotent `preview_boots` row, then
 * supersede any OTHER still-in-flight boot for the SAME (workspace, repo,
 * prNumber) whose head differs — a push storm's newest head wins the race to
 * get a preview, older still-in-flight heads are torn down rather than
 * piling up (or worse, serving a stale diff).
 *
 * Mirrors `review_jobs.ts`'s `enqueueReviewJob` exactly for the SAME
 * concurrency reasons documented there in full: the insert + supersede run
 * inside ONE `db.transaction`, whose FIRST statement takes a per-PR
 * `pg_advisory_xact_lock` (blocking, not `_try_`) so two concurrent enqueues
 * for the same PR (duplicate webhook deliveries, a rapid push storm) can
 * never each commit their own insert and then each supersede the OTHER's
 * now-admitted row (the mutual-supersede race) — whichever acquires the lock
 * runs its entire insert+supersede pair and commits before the next one
 * proceeds. The lock key is `preview-boot:<workspaceId>:<repo>:<prNumber>` —
 * scoped to the PR, not the head — deliberately namespaced with a
 * `preview-boot:` prefix distinct from `review_jobs.ts`'s own
 * `review-job:<...>` lock keys, so the two queues' advisory locks (both
 * hashed via `hashtext`) can never collide on the same PR.
 *
 * Deduped-supersede guard (same rationale as `enqueueReviewJob`'s "Arc B
 * review fix wave 2"): the supersede runs ONLY when the insert actually
 * inserted (`!deduped`). A redelivered/duplicate request for an
 * already-tracked head must be a hard no-op — running the supersede anyway
 * would let a dead head's stale redelivery flip the CURRENT legitimate
 * survivor to `torn_down` too. A deduped call always returns
 * `superseded: 0`.
 *
 * The supersede's own WHERE lists all four scoping predicates
 * (workspace/repo/pr/head) plus `status IN ('pending','claimed','booting',
 * 'ready')` on the UPDATE's OWN WHERE (not left to a CTE) — the same
 * EvalPlanQual-safe placement `review_jobs.ts`'s own supersede uses, so
 * Postgres re-checks the status predicate against the freshly-locked row
 * version at lock time. Unlike `review_jobs`'s supersede (which only ever
 * targets `state = 'queued'`, since a `running` review job survives until
 * it completes), this supersede targets EVERY non-terminal status including
 * `claimed`/`booting`/`ready` — a newer push should tear down an
 * already-booted preview for the old head too, not just an unclaimed one.
 * That teardown is NOT performed here: this call only flips the row's
 * status; the worker's own supervise loop (Task 7) is what notices the
 * flipped status and actually kills the child process — see
 * `schema/preview_boots.ts`'s own doc-comment for why marking the row is
 * safe on its own.
 */
export async function enqueuePreviewBoot(input: {
  workspaceId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  ref: string;
}): Promise<EnqueuePreviewBootResult> {
  const id = previewBootId(input);
  const lockKey = `preview-boot:${input.workspaceId}:${input.repo}:${input.prNumber}`;

  return db.transaction(async (tx) => {
    // Must be the FIRST statement in the transaction — see this function's
    // doc-comment for why every concurrent enqueue for this PR needs to
    // serialize here.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

    const inserted = Array.from(
      await tx.execute(sql`
        INSERT INTO preview_boots (id, workspace_id, repo, pr_number, head_sha, ref)
        VALUES (${id}, ${input.workspaceId}, ${input.repo}, ${input.prNumber}, ${input.headSha}, ${input.ref})
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `)
    );
    const deduped = inserted.length === 0;

    // Deduped-supersede guard — see this function's doc-comment.
    if (deduped) {
      return { id, deduped: true, superseded: 0 };
    }

    const superseded = Array.from(
      await tx.execute(sql`
        UPDATE preview_boots
        SET status = 'torn_down', reason = 'superseded', updated_at = now()
        WHERE workspace_id = ${input.workspaceId}
          AND repo = ${input.repo}
          AND pr_number = ${input.prNumber}
          AND head_sha <> ${input.headSha}
          AND status IN ('pending', 'claimed', 'booting', 'ready')
        RETURNING id
      `)
    );

    return { id, deduped: false, superseded: superseded.length };
  });
}

// --- expire (stale-liveness sweep) -------------------------------------------

/**
 * A `claimed`/`booting`/`ready` boot that has gone this long without a
 * liveness touch (set at claim time, bumped on every `reportPreviewBoot`
 * call) is presumed dead — its worker crashed, its child process hung, or
 * the network partition ate its reports. 180s gives a supervising worker
 * several missed-and-recovered heartbeat cycles of slack before the row is
 * declared dead.
 */
const STALE_SECONDS = 180;

/**
 * A `pending` boot that has sat this long with NO worker ever claiming it is
 * presumed unclaimable — the worker pool is down, overloaded, or nothing is
 * currently able to service it. 600s (10 min) is comfortably longer than a
 * single worker restart/deploy (a routine bounce must not falsely expire a
 * row that would have been claimed moments later), while still short enough
 * to keep the queue honest — a request nobody has picked up in 10 minutes is
 * stuck, not "about to be claimed," and deserves a terminal answer rather
 * than an indefinite hang.
 *
 * Fix round 1 (task-2 review, Important #1): the brief's original "pending
 * ... attempts exhausted" wording is dead as literally written — nothing in
 * this module ever advances `attempts` for a `pending` row (see this task's
 * report for the full analysis) — but the underlying PRODUCT gap it was
 * pointing at is real: without this sweep, a `pending` row nobody ever
 * claims sits forever with no automatic terminal state. This constant
 * replaces the source docs' undefined "N min" placeholder with a concrete,
 * `attempts`-free age check instead.
 */
const PENDING_STALE_SECONDS = 600;

/**
 * Sweep: fail (a) any non-terminal `claimed`/`booting`/`ready` boot whose
 * liveness has gone stale, and (b) any `pending` boot that has sat unclaimed
 * too long. Two separate UPDATE statements, one per concern — mirrors
 * `review_jobs.ts`'s own two-separate-pre-pass-statements idiom
 * (`requeueStaleRunningReviewJobs` + `failStaleQueuedReviewJobs`) rather than
 * fusing both into one CASE-driven UPDATE: each sweep has its own WHERE
 * column (`last_liveness_at` vs `created_at`) and its own terminal `reason`,
 * so keeping them separate keeps each independently readable and testable.
 *
 * (a) Liveness sweep, deliberately UNCONDITIONAL — unlike `review_jobs.ts`'s
 * analogous stale pre-pass (`requeueStaleRunningReviewJobs`), which puts a
 * stale row BACK to `queued` for another attempt, a preview boot is
 * single-attempt (see this module's own top doc-comment): a stale
 * `claimed`/`booting`/`ready` row goes straight to terminal `failed`, never
 * back to `pending`. This matches `schema/preview_boots.ts`'s own lifecycle
 * doc-comment, which lists no back-to-pending path at all.
 *
 * `last_liveness_at` is never NULL for a row this predicate can match:
 * `claimPreviewBoot` itself sets it at claim time, and every
 * `reportPreviewBoot` call bumps it again — so a `claimed`/`booting`/`ready`
 * row always has a real timestamp to compare against.
 *
 * (b) Pending sweep — a `pending` row has never been claimed, so there is no
 * liveness signal to check; `created_at` is the only clock available. See
 * `PENDING_STALE_SECONDS`'s own doc-comment for the threshold's rationale.
 * `reason = 'never_claimed'` is deliberately distinct from the liveness
 * sweep's `'stale'` so a caller/operator can tell "nobody ever picked this
 * up" apart from "a worker picked it up and then went dark" at a glance.
 */
export async function expireStalePreviewBoots(): Promise<void> {
  await db.execute(sql`
    UPDATE preview_boots
    SET status = 'failed', reason = 'stale', updated_at = now()
    WHERE status IN ('claimed', 'booting', 'ready')
      AND last_liveness_at < now() - (${STALE_SECONDS} || ' seconds')::interval
  `);

  await db.execute(sql`
    UPDATE preview_boots
    SET status = 'failed', reason = 'never_claimed', updated_at = now()
    WHERE status = 'pending'
      AND created_at < now() - (${PENDING_STALE_SECONDS} || ' seconds')::interval
  `);
}

// --- claim --------------------------------------------------------------------

/**
 * The atomic claim, copying `review_jobs.ts`'s own `claimEligibleReviewJob`
 * shape: select-the-oldest-eligible + flip to `claimed` in ONE
 * `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)` statement, so
 * two concurrent claimers never claim the same row.
 *
 * No per-workspace concurrency bound here (unlike `review_jobs.ts`'s
 * `NOT EXISTS` clause, which caps at one `running` review job per
 * workspace): a workspace can legitimately want several PRs' previews
 * booted at once, so every pending candidate across every workspace
 * competes purely on `created_at` (oldest first).
 *
 * `ttlSeconds` is caller-supplied (not a fixed literal like
 * `review_jobs.ts`'s hardcoded 60-second debounce), so the interval is built
 * with the `(<n> || ' seconds')::interval` string-concat-then-cast idiom the
 * brief calls for, rather than Postgres's `make_interval()` or a literal
 * `interval` — this is the same idiom `claimPreviewBoot`'s own brief
 * prescribes verbatim.
 */
export async function claimPreviewBoot(input: {
  workerId: string;
  ttlSeconds: number;
}): Promise<PreviewBootRow | null> {
  // Pre-pass: a claimed/booting/ready row whose worker went dark is failed
  // BEFORE the claim's own SELECT runs, so it never masks a fresh pending
  // candidate's eligibility and never lingers as a phantom "in progress"
  // boot nobody is actually supervising.
  await expireStalePreviewBoots();

  const claimed = Array.from(
    await db.execute(sql`
      UPDATE preview_boots
      SET status = 'claimed',
          worker_id = ${input.workerId},
          claimed_at = now(),
          expires_at = now() + (${input.ttlSeconds} || ' seconds')::interval,
          last_liveness_at = now(),
          updated_at = now()
      WHERE id = (
        SELECT id FROM preview_boots
        WHERE status = 'pending'
          AND (next_eligible_at IS NULL OR next_eligible_at <= now())
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `)
  ) as Array<Record<string, unknown>>;

  const raw = claimed[0];
  return raw ? mapPreviewBootRow(raw) : null;
}

// --- report (guarded per-target-status transitions) --------------------------

export type ReportPreviewBootInput = {
  id: string;
  /** The worker id the row was claimed under — every UPDATE below is scoped
   *  `WHERE worker_id = $workerId`, so a caller that is not the row's
   *  current claimant always gets a `null` no-op, never a transition. */
  workerId: string;
  status: "booting" | "ready" | "failed" | "torn_down";
  /** Written on a 'ready' report. NOTE (Fix round 1, task-2 review Minor
   *  #2): an explicit `null` and an omitted `undefined` are indistinguishable
   *  here — BOTH preserve whatever the column already holds (see the
   *  'ready' branch's own comment on the `COALESCE` it uses). There is
   *  currently no way to clear an already-set `url` back to null via this
   *  function; no caller needs that today. */
  url?: string | null;
  /** Written on a 'ready' report; same omit-and-explicit-null-both-preserve
   *  semantics as `url` above. */
  port?: number | null;
  /** Written on a 'failed'/'torn_down' report. */
  reason?: string | null;
};

/**
 * Guarded resolve of one boot's status report, scoped to the CURRENT
 * claimant. Mirrors `review_jobs.ts`'s `completeReviewJob`: one UPDATE per
 * target-status branch, each guarded by `WHERE id = $ AND worker_id = $ AND
 * <status is a legal FROM state for this target>`, `RETURNING *` so a
 * matched row comes back mapped, and a stale/foreign/already-terminal call
 * matches zero rows and returns `null` — never throws, never resurrects or
 * clobbers a row that already moved on.
 *
 * Per-target guards (see this task's brief for the full state-machine
 * rationale):
 *  - `booting`: legal FROM `claimed` or `booting` (idempotent re-report
 *    while still booting). Illegal from `ready` (no going backwards) or
 *    `pending` (nothing to report against — never claimed).
 *  - `ready`: legal FROM `claimed`, `booting`, OR `ready` itself. The
 *    `ready` -> `ready` case is NOT a bogus self-transition — it is the
 *    worker's periodic liveness re-report while supervising an already-live
 *    boot, and this is the ONLY branch that needs to tell "first ready"
 *    (url/port not yet set) apart from "still ready" (url/port already
 *    set): `url`/`port` are written with `COALESCE($new, <column>)`, so an
 *    omitted (`undefined` -> bound `null`) value on a re-report PRESERVES
 *    whatever is already stored instead of clobbering it back to NULL,
 *    while a real value on the first ready report writes through normally
 *    (`COALESCE(realValue, null) = realValue`).
 *  - `failed` / `torn_down`: legal from ANY non-terminal status
 *    (`status NOT IN ('failed', 'torn_down')`) — a boot can die at any
 *    point in its lifecycle. `reason` is written plainly (not COALESCEd):
 *    both target statuses are terminal, so there is no "preserve across a
 *    re-report" case to protect — a second failure/teardown call for an
 *    already-terminal row is instead rejected outright by the guard itself
 *    (matches zero rows, returns `null`), so the first reason always stands.
 *
 * `last_liveness_at` and `updated_at` are bumped to `now()` on every
 * successful branch — a report of ANY kind, including a terminal one, is
 * proof the worker is (or just was) alive.
 */
export async function reportPreviewBoot(
  input: ReportPreviewBootInput
): Promise<PreviewBootRow | null> {
  let rows: Array<Record<string, unknown>>;

  if (input.status === "booting") {
    rows = Array.from(
      await db.execute(sql`
        UPDATE preview_boots
        SET status = 'booting', last_liveness_at = now(), updated_at = now()
        WHERE id = ${input.id}
          AND worker_id = ${input.workerId}
          AND status IN ('claimed', 'booting')
        RETURNING *
      `)
    ) as Array<Record<string, unknown>>;
  } else if (input.status === "ready") {
    rows = Array.from(
      await db.execute(sql`
        UPDATE preview_boots
        SET status = 'ready',
            url = COALESCE(${input.url ?? null}, url),
            port = COALESCE(${input.port ?? null}, port),
            last_liveness_at = now(),
            updated_at = now()
        WHERE id = ${input.id}
          AND worker_id = ${input.workerId}
          AND status IN ('claimed', 'booting', 'ready')
        RETURNING *
      `)
    ) as Array<Record<string, unknown>>;
  } else {
    // 'failed' | 'torn_down' — legal from any non-terminal status.
    rows = Array.from(
      await db.execute(sql`
        UPDATE preview_boots
        SET status = ${input.status},
            reason = ${input.reason ?? null},
            last_liveness_at = now(),
            updated_at = now()
        WHERE id = ${input.id}
          AND worker_id = ${input.workerId}
          AND status NOT IN ('failed', 'torn_down')
        RETURNING *
      `)
    ) as Array<Record<string, unknown>>;
  }

  const raw = rows[0];
  return raw ? mapPreviewBootRow(raw) : null;
}

// --- read ---------------------------------------------------------------------

/**
 * Plain lookup by id, via the drizzle query-builder path (`db.select()`),
 * which maps `timestamptz` columns to `Date` itself — no `mapPreviewBootRow`/
 * `toDateOrNull` needed here, unlike the raw-SQL functions above. Returns
 * `null` for an unknown id rather than throwing.
 */
export async function getPreviewBoot(id: string): Promise<PreviewBootRow | null> {
  const rows = await db
    .select()
    .from(previewBoots)
    .where(eq(previewBoots.id, id))
    .limit(1);
  return (rows[0] as PreviewBootRow) ?? null;
}
