// Pure loop core for Arc B's "reviewer of record": a headless Jace worker
// that claims one queued PR-review job at a time from the console's
// `review_jobs` queue (Task 2's `claimReviewJob`, fronted by Task 4's claim
// route) and drives it through a root task-mode eve session running the
// canned review choreography (Task 6's prompt template).
//
// EVERY I/O boundary is an injected async function — `claim`, `complete`,
// `openSession`, `promptFor` — so this module makes no network calls, opens
// no real eve session, and imports nothing beyond the language. Task 6 wires
// the real transports (`review_job_console.mjs`'s `claimReviewJob` /
// `completeReviewJob`, and an eve `Client({host: self}).session()` for
// `openSession`) and the instrumentation.ts flag-gated start() call. This
// file only owns the LOOP: when to open/close a session, when to claim, how
// long to let a review run before giving up on it, and — the load-bearing
// property — that none of that can ever throw or reject out of `tick()`.
//
// SESSION OPENS BEFORE CLAIMING, always, even when there turns out to be no
// job. This looks wasteful (every idle 30s poll opens and immediately closes
// a real eve session) but is deliberate: the design this replaces issued a
// `reviewJobToken` AFTER claiming and bound the session to it later, as a
// separate step — a window in which a claimed job could end up bound to no
// session, or bound twice. Arc B's refinement collapses that into ONE
// atomic step server-side: `claim` is called with the session's own `id` as
// `eveSessionId`, and the console's claim route binds that session to
// whatever job it claims in the same transaction
// (`bindReviewJobSession`, spec §3). That atomicity is only possible if the
// session already exists by the time `claim` is called — so it must be
// opened first, unconditionally, and closed again (best-effort) on every
// exit path, including the "nothing was queued" one.
//
// `claim` is called here as `claim({ eveSessionId })` — NOT `{ workerId,
// eveSessionId }`, even though the console's HTTP contract needs both
// (`review_job_console.mjs`'s planned `claimReviewJob({workerId,
// eveSessionId})`, Arc B plan Task 6). This core has no configured identity
// for itself and the exact factory signature above has no `workerId` field
// to source one from — resolving a stable worker identity (hostname, pid, an
// env var) is exactly the kind of environment-dependent concern Task 6's
// transport wiring owns, not this pure loop. The real `claim` Task 6 injects
// here is expected to be a closure that already knows its own `workerId` and
// merges it in before the HTTP call, e.g.
// `({eveSessionId}) => claimReviewJob({workerId: MY_ID, eveSessionId})`.
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
 *   claim: (args: { eveSessionId: string }) => Promise<ReviewJob | null>,
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

  /** Run the claimed job to completion (or failure), reporting either way. */
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
        // (Task 6's planned REVIEW_JOB_RESULT_SCHEMA: {posted, reviewUrl,
        // verdict, blockers, summaryLine}). Only `reviewUrl` gets renamed —
        // to `postedReviewUrl`, matching `complete`'s own documented shape
        // and the console's complete-route body (Arc B plan Task 4)
        // — `verdict`/`summaryLine` pass through unchanged. `blockers` is
        // deliberately dropped here: it is not part of `complete`'s
        // contract (only `jobId, outcome, postedReviewUrl, verdict,
        // summaryLine, error`), so nothing in this module ever reads it.
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

    try {
      await complete({ jobId: job.id, outcome: "failed", error: failureMessage });
    } catch (err) {
      safeLog("review-job-worker: complete() failed after a failed result", err);
    }
    await safeClose(session);
    return "failed";
  }

  /** One full attempt: open, claim, and either idle out or run the job. */
  async function runOnce() {
    let session;
    try {
      session = await openSession();
    } catch (err) {
      safeLog("review-job-worker: openSession() failed", err);
      return "idle";
    }

    let job;
    try {
      job = await claim({ eveSessionId: session.id });
    } catch (err) {
      safeLog("review-job-worker: claim() failed", err);
      await safeClose(session);
      return "idle";
    }

    if (!job) {
      await safeClose(session);
      return "idle";
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
