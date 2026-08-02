// Pure loop core for Arc B's "reviewer of record": a headless Jace worker
// that claims one queued PR-review job at a time from the console's
// `review_jobs` queue (Task 2's `claimReviewJob`, fronted by Task 4's claim
// route) and drives it through a root task-mode eve session running the
// canned review choreography (Task 6's prompt template).
//
// EVERY I/O boundary is an injected async function — `claim`, `bind`,
// `complete`, `openSession`, `promptFor` — so this module makes no network
// calls, opens no real eve session, and imports nothing beyond the language.
// The assembler (`review_job_worker.mjs`) wires the real transports
// (`review_job_console.mjs`'s `claimReviewJob` / `bindReviewJobSession` /
// `completeReviewJob`, and an eve `Client({host: self}).session()` for
// `openSession`) and the instrumentation.ts flag-gated start() call. This
// file only owns the LOOP: when to claim, when to open a session and bind
// it, how long to let a review run before giving up on it, and — the
// load-bearing property — that none of that can ever throw or reject out of
// `tick()`.
//
// *** CLAIM FIRST, SESSION ONLY WHEN A JOB EXISTS (Arc B review fix wave —
// this module's SECOND design) ***
//
// An idle poll (nothing eligible in the queue) now costs exactly one cheap
// claim call and NOTHING else: no eve session is opened, so no model turn
// runs. This matters concretely: opening a session means sending a real
// bootstrap message to root (see `review_job_worker.mjs`'s own header
// comment, "THE SESSION-MINTING PROBLEM" — eve has no way to hand out a
// session id without a real turn), and at `DEFAULT_POLL_INTERVAL_MS` (30s)
// that is 2,880 turns/day at REST if paid on every idle poll. The FIRST
// version of this module accepted that cost unconditionally ("every idle 30s
// poll opens and immediately closes a real eve session... deliberate") —
// review flagged it Important once the actual per-poll mechanism (not just
// the idea of it) was concrete and unproven against a live server. This
// version pays that cost ONLY for an actual claimed job, at most once per
// review, never on an empty queue.
//
// THIS REPLACES the first design, where the session opened UNCONDITIONALLY,
// BEFORE claiming, so `claim` could carry the session's own id and the
// console could bind it atomically in the SAME call as the claim itself.
// That atomicity is gone — claiming and binding are separate steps again —
// but the SESSION-RESOLVING INVARIANT the atomicity existed to protect is
// preserved differently: binding still happens BEFORE the real review turn
// is ever sent (`runOnce`'s order is `claim -> openSession -> bind -> send
// -> complete -> close`), so every session-resolving tool the review turn
// calls (the reviewer subagent's tools + root's `post_pr_review`) still
// resolves this job's workspace through the SAME `eveSessionId` ->
// `jace_sessions` lookup they always have — the review turn itself never
// runs unbound. What changed is WHEN in the tick a session gets created
// (after claim, only for a real job) and WHERE the binding call lives (its
// own seam, `bind`, no longer folded into `claim`) — not WHETHER binding
// precedes the turn. This is why the bootstrap-then-real-turn shape
// (`review_job_worker.mjs`) survives this rewrite at all: binding-before-
// the-real-turn is the invariant every session-resolving tool depends on,
// and it was never actually about claim and bind being one atomic call.
//
// `bind` FAILING is NOT `complete`-worthy the way `openSession`/`send`
// failing is. When `openSession` or `send` fails, the job is still
// genuinely `running` under THIS worker's claim (nothing else has touched
// its row), so reporting `outcome:"failed"` via `complete` is safe and
// correct — it lets the console's own retry/backoff policy requeue it
// promptly instead of waiting out the 15-minute stale-running pre-pass. A
// `bind` failure is different: the fix-wave's bind route either already
// released the job back to `queued` (a 503) or refused because the job was
// never/no-longer `running` (a 409 — e.g. reclaimed by the stale-running
// pre-pass while this worker was mid-bootstrap). Either way, this worker's
// own belief that it owns this job is stale the instant `bind` fails, and
// calling `complete` anyway risks resolving a DIFFERENT worker's now-active
// claim on the same row. So a `bind` failure closes the session, logs, and
// returns `"failed"` WITHOUT ever calling `complete` — the console's own
// state (already released, or already re-claimed by someone else) is
// authoritative, never this worker's guess.
//
// `claim` takes NO arguments at all (`() => Promise<ReviewJob | null>`) —
// there is no `eveSessionId` to carry at claim time anymore, and `workerId`
// remains something the assembler's transport closure curries in itself
// (`review_job_worker.mjs`'s `createClaimFn`) rather than something this
// core ever touches.
//
// TIMEOUT MECHANICS: `session.send(...)` is raced against a `jobTimeoutMs`
// timer via `Promise.race`. The interface gives no cancellation signal, so a
// losing `send()` is not actually aborted — it is simply no longer awaited by
// this tick, and may resolve or reject on its own later, in the background.
// A LATE REJECTION from that abandoned promise is the classic
// `Promise.race` loser-promise hazard: if nothing were still listening, Node
// would report it as an unhandled rejection, potentially crashing the
// process on a completely unrelated later tick. It does not need an extra
// `.catch()` here, though: `Promise.race` itself subscribes a rejection
// handler to EVERY promise passed to it, synchronously, at the moment it is
// constructed — before `send()` has any chance to settle — so the losing
// promise is never actually "unhandled" by Node's own bookkeeping, no matter
// how late it eventually rejects. Verified empirically (a standalone repro:
// race a never-settling promise against a fast timeout, reject the loser
// long after the race has already resolved via the timeout branch — zero
// `unhandledRejection` events) and pinned by the "loses the race ... rejects
// LATE" test in the sibling test file, which is this module's actual
// authority on the guarantee, not this comment.
export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_JOB_TIMEOUT_MS = 15 * 60_000;

/**
 * @typedef {{ id: string, repo: string, prNumber: number, headSha: string,
 *   event: string, workspaceId: string }} ReviewJob
 * @typedef {{ id: string,
 *   send: (args: { message: string, outputSchema: unknown }) => Promise<unknown>,
 *   close: () => Promise<void> }} EveSession
 */

/**
 * Build a review-job worker: a poll-claim-execute-complete loop, entirely
 * driven by injected functions, that never lets a failure anywhere in that
 * chain kill the loop or escape as an unhandled rejection.
 *
 * @param {{
 *   claim: () => Promise<ReviewJob | null>,
 *   bind: (args: { jobId: string, eveSessionId: string }) => Promise<void>,
 *   complete: (args: { jobId: string, outcome: "posted"|"failed",
 *     postedReviewUrl?: string|null, verdict?: string, summaryLine?: string,
 *     error?: string }) => Promise<void>,
 *   openSession: () => Promise<EveSession>,
 *   promptFor: (job: ReviewJob) => string,
 *   resultSchema: unknown,
 *   intervalMs?: number,
 *   jobTimeoutMs?: number,
 *   log?: (message: string, err?: unknown) => void,
 * }} deps
 * @returns {{ start: () => void, stop: () => void, tick: () => Promise<"idle"|"done"|"failed"> }}
 */
export function createReviewJobWorker({
  claim,
  bind,
  complete,
  openSession,
  promptFor,
  resultSchema,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
  jobTimeoutMs = DEFAULT_JOB_TIMEOUT_MS,
  log = () => {},
}) {
  let intervalHandle = null;
  let inFlight = false;

  /** A broken logger must never take down the loop. */
  function safeLog(message, err) {
    try {
      log(message, err);
    } catch {
      /* swallow */
    }
  }

  /** Session close is best-effort on every path, including after an error. */
  async function safeClose(session) {
    try {
      await session.close();
    } catch (err) {
      safeLog("review-job-worker: session.close() failed", err);
    }
  }

  /**
   * Report a job as failed via complete(), swallowing complete()'s own
   * failure (logged only, never re-thrown — the console's stale-requeue is
   * the documented safety net either way). Used for `openSession`/`send`
   * failures, where the job is still genuinely this worker's to resolve —
   * NEVER used for a `bind` failure; see this module's header comment for
   * why that path is different.
   */
  async function reportFailed(job, failureMessage) {
    try {
      await complete({ jobId: job.id, outcome: "failed", error: failureMessage });
    } catch (err) {
      safeLog("review-job-worker: complete() failed after reporting a failure", err);
    }
  }

  /** Run the claimed, session-bound job to completion (or failure), reporting either way. */
  async function runJob(session, job) {
    const timeoutMessage = `review job timed out after ${jobTimeoutMs}ms`;
    let timer;
    const timeoutPromise = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(timeoutMessage)), jobTimeoutMs);
    });

    let result;
    let failureMessage = null;
    try {
      // Constructed and raced in the same synchronous step, with no `await`
      // in between — see this module's header comment for why that is what
      // makes the losing side of this race safe to abandon.
      const sendPromise = session.send({ message: promptFor(job), outputSchema: resultSchema });
      result = await Promise.race([sendPromise, timeoutPromise]);
    } catch (err) {
      failureMessage = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }

    if (failureMessage === null) {
      try {
        // `result` is the model's structured output, shaped by `resultSchema`
        // (Task 6's REVIEW_JOB_RESULT_SCHEMA: {posted, reviewUrl, verdict,
        // blockers, summaryLine}). Only `reviewUrl` gets renamed — to
        // `postedReviewUrl`, matching `complete`'s own documented shape and
        // the console's complete-route body (Arc B plan Task 4) —
        // `verdict`/`summaryLine` pass through unchanged. `blockers` is
        // deliberately dropped here: it is not part of `complete`'s contract
        // (only `jobId, outcome, postedReviewUrl, verdict, summaryLine,
        // error`), so nothing in this module ever reads it.
        await complete({
          jobId: job.id,
          outcome: "posted",
          postedReviewUrl: result?.reviewUrl,
          verdict: result?.verdict,
          summaryLine: result?.summaryLine,
        });
      } catch (err) {
        safeLog("review-job-worker: complete() failed after a posted result", err);
      }
      await safeClose(session);
      return "done";
    }

    await reportFailed(job, failureMessage);
    await safeClose(session);
    return "failed";
  }

  /**
   * One full attempt: claim first (cheap, no session cost); a real job then
   * opens a session, binds it, and runs the review; nothing eligible costs
   * nothing further.
   */
  async function runOnce() {
    let job;
    try {
      job = await claim();
    } catch (err) {
      safeLog("review-job-worker: claim() failed", err);
      return "idle";
    }

    if (!job) {
      return "idle";
    }

    let session;
    try {
      session = await openSession();
    } catch (err) {
      // The job is still genuinely `running` under this claim (nothing else
      // has touched it) — reportFailed() is safe and correct here, unlike
      // the bind-failure branch below. See this module's header comment.
      safeLog("review-job-worker: openSession() failed", err);
      await reportFailed(job, err instanceof Error ? err.message : String(err));
      return "failed";
    }

    try {
      await bind({ jobId: job.id, eveSessionId: session.id });
    } catch (err) {
      // Deliberately NOT reportFailed()/complete() here — see this module's
      // header comment ("`bind` FAILING is NOT `complete`-worthy...") for
      // why this worker's own view of the job is stale the instant bind
      // fails, and completing it anyway could resolve someone else's claim.
      safeLog("review-job-worker: bind() failed", err);
      await safeClose(session);
      return "failed";
    }

    return runJob(session, job);
  }

  /**
   * Run one poll-claim-execute-complete cycle. Never rejects: every
   * injected-function failure is caught, logged, and swallowed somewhere
   * above. A tick already in flight makes any overlapping call a no-op that
   * resolves "idle" immediately, so ticks never run concurrently regardless
   * of whether they arrive from `start()`'s interval or a direct call.
   */
  async function tick() {
    if (inFlight) return "idle";
    inFlight = true;
    try {
      return await runOnce();
    } finally {
      inFlight = false;
    }
  }

  /** Idempotent: a second start() while already running is a no-op. */
  function start() {
    if (intervalHandle !== null) return;
    intervalHandle = setInterval(() => {
      // tick() is documented to never reject; this .catch is belt-and-suspenders
      // against a future regression here specifically, since nothing else is
      // ever awaiting this fire-and-forget call.
      tick().catch((err) => {
        safeLog("review-job-worker: tick() rejected unexpectedly — this should never happen", err);
      });
    }, intervalMs);
  }

  /** Idempotent: safe to call before start(), or more than once. */
  function stop() {
    if (intervalHandle === null) return;
    clearInterval(intervalHandle);
    intervalHandle = null;
  }

  return { start, stop, tick };
}
