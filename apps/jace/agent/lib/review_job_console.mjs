// Console transports for Arc B's headless review-job worker: the three HTTP
// calls review_job_worker.core.mjs's `claim`/`bind`/`complete` seams need,
// hitting the routes Task 4 built plus the fix-wave's new bind route
// (apps/console/app/api/v1/runner/review-jobs/{claim,bind,complete}/route.ts
// — see Task 4's own report, .superpowers/sdd/task-4-report.md, and this
// task's fix-wave report for the exact wire contracts these mirror).
//
// `resolveConsoleConfig` is duplicated verbatim from the sibling *.core.mjs
// modules (fetch_pr_diff.core.mjs, console_gated_approval.core.mjs,
// create_issue.core.mjs, ...) rather than imported — same reasoning as all
// of those: each module here is pure and dependency-free of its siblings by
// design.
//
// TIMEOUT DISCIPLINE (Task 6 brief, obligation 1): review_job_worker.core.mjs
// races ONLY `send` against `jobTimeoutMs` — `claim`/`bind`/`complete` are
// NOT raced by the core at all, so a transport that hangs here wedges the
// worker's `inFlight` flag forever with no recovery (every subsequent
// `tick()` call becomes a silent no-op — see the core's own `tick()` doc
// comment: "A tick already in flight makes any overlapping call a no-op").
// All three functions below therefore default to `realTransport`, an
// AbortController-bounded fetch, mirroring console_gated_approval.core.mjs's
// own `realTransport` (same REQUEST_TIMEOUT_MS=8000 house convention)
// byte-for-byte.
//
// ARC B REVIEW FIX WAVE (per-job session restructure) — `claimReviewJob`'s
// body is now `{workerId}` ONLY: claim no longer carries or binds an
// `eveSessionId` (that used to happen atomically inside the claim call; see
// review_job_worker.core.mjs's own header comment for why it moved). Binding
// is its own transport now, `bindReviewJobSession({jobId, eveSessionId})`,
// called by the assembler AFTER a session is opened for an actual claimed
// job, right before the real review turn is sent.
//
// `claimReviewJob`'s 200 body is `{ job: {...} }` (a wrapper key, not the
// job's fields at the top level) and its 204 body is empty — both verified
// against Task 4's actual route implementation, not assumed from this
// task's brief text alone (which only said "204 -> null" and left the 200
// shape implicit).
//
// `completeReviewJob` NEVER sends `eveSessionId` — it isn't a parameter this
// function even reads, by construction (Task 6 brief prose pin), matching
// the core's own `complete(...)` call shape, which never includes one
// either. `claimReviewJob` likewise never sends `eveSessionId` post-fix-wave,
// for the same reason: it isn't a parameter either function reads.

const REQUEST_TIMEOUT_MS = 8000;

export const CLAIM_PATH = "/api/v1/runner/review-jobs/claim";
export const BIND_PATH = "/api/v1/runner/review-jobs/bind";
export const COMPLETE_PATH = "/api/v1/runner/review-jobs/complete";

/**
 * Resolve the console endpoint + bearer from the environment. Trims both,
 * strips a trailing slash from the base URL, and reports which var(s) are
 * missing. Deliberately duplicated verbatim from the sibling *.core.mjs
 * modules rather than shared — see this module's header comment.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ ok: true, baseUrl: string, token: string } | { ok: false, missing: string[] }}
 */
export function resolveConsoleConfig(env = {}) {
  const baseUrl = String(env.JACE_CONSOLE_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env.JACE_CONSOLE_TOKEN ?? "").trim();
  const missing = [];
  if (!baseUrl) missing.push("JACE_CONSOLE_BASE_URL");
  if (!token) missing.push("JACE_CONSOLE_TOKEN");
  if (missing.length) return { ok: false, missing };
  return { ok: true, baseUrl, token };
}

/** @param {string} baseUrl — already trimmed + de-slashed */
export function buildClaimUrl(baseUrl) {
  return `${baseUrl}${CLAIM_PATH}`;
}

/** @param {string} baseUrl — already trimmed + de-slashed */
export function buildBindUrl(baseUrl) {
  return `${baseUrl}${BIND_PATH}`;
}

/** @param {string} baseUrl — already trimmed + de-slashed */
export function buildCompleteUrl(baseUrl) {
  return `${baseUrl}${COMPLETE_PATH}`;
}

/** Real fetch with a timeout — mirrors console_gated_approval.core.mjs's own realTransport (AbortController aborts after REQUEST_TIMEOUT_MS). */
async function realTransport(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { status: res.status, json: () => res.json() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Claim the next eligible review job. Resolves `null` on 204 (nothing
 * eligible); throws on any non-2xx (the worker core's `runOnce` catches this
 * — see review_job_worker.core.mjs's `claim()` try/catch, which logs and
 * treats it the same as "no job": idle, loop alive). Does NOT bind a
 * session — see this module's header comment (fix wave); use
 * `bindReviewJobSession` separately, once a session exists for the claimed
 * job.
 *
 * @param {{ workerId: string,
 *   env?: Record<string, string|undefined>,
 *   transport?: (url: string, init: object) => Promise<{status: number, json: () => Promise<unknown>}> }} args
 * @returns {Promise<{ id: string, repo: string, prNumber: number, headSha: string, event: string, workspaceId: string } | null>}
 */
export async function claimReviewJob({ workerId, env = {}, transport = realTransport }) {
  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) {
    throw new Error(`claimReviewJob: console not configured (missing ${cfg.missing.join(", ")})`);
  }

  const res = await transport(buildClaimUrl(cfg.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ workerId: String(workerId ?? "") }),
  });

  const status = Number(res && res.status);
  if (status === 204) return null;
  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    throw new Error(`claimReviewJob: console returned ${Number.isFinite(status) ? status : "an invalid status"}`);
  }

  const body = await res.json();
  return body && typeof body === "object" ? body.job ?? null : null;
}

/**
 * Bind a headless eve session to a claimed job (fix wave — see this
 * module's header comment). Must be called AFTER `openSession()` succeeds
 * for an actual claimed job, and BEFORE the real review turn is sent — every
 * session-resolving tool the review turn calls resolves this job's
 * workspace through this binding.
 *
 * Resolves (void) on 2xx. Throws on non-2xx — the console's bind route maps
 * "job not in running" to 409 (e.g. reclaimed by the stale-running pre-pass
 * while this worker was mid-bootstrap) and a genuine bind failure (already
 * compensated server-side via release) to 503; the worker core's `bind()`
 * try/catch treats EITHER as "this worker no longer owns the job" and does
 * NOT call `complete()` — see that module's own header comment for why.
 * This transport does not need to distinguish 409 from 503 itself; both are
 * "bind did not succeed."
 *
 * @param {{ jobId: string, eveSessionId: string,
 *   env?: Record<string, string|undefined>,
 *   transport?: (url: string, init: object) => Promise<{status: number, json: () => Promise<unknown>}> }} args
 * @returns {Promise<void>}
 */
export async function bindReviewJobSession({ jobId, eveSessionId, env = {}, transport = realTransport }) {
  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) {
    throw new Error(`bindReviewJobSession: console not configured (missing ${cfg.missing.join(", ")})`);
  }

  const res = await transport(buildBindUrl(cfg.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      jobId: String(jobId ?? ""),
      eveSessionId: String(eveSessionId ?? ""),
    }),
  });

  const status = Number(res && res.status);
  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    throw new Error(`bindReviewJobSession: console returned ${Number.isFinite(status) ? status : "an invalid status"}`);
  }
}

/**
 * Report a claimed job's outcome. Never sends `eveSessionId` — not a
 * parameter this function reads at all (see this module's header comment).
 * Resolves (void) on any 2xx; throws on non-2xx (the worker core's `runJob`
 * catches this and only logs it — a failed report never changes the outcome
 * the loop already returns; the console's stale-requeue is the documented
 * safety net).
 *
 * `evidenceKeys` (B2a §1 Task 3): same undefined-omission convention as
 * `postedReviewUrl`/`verdict`/`summaryLine`/`error` below — present ->
 * forwarded verbatim; absent -> the key is never added to the body at all,
 * so a caller that never learned about this field (or the console core's
 * own `complete()` call on any pre-evidence code path) produces the exact
 * same wire body as before this field existed.
 *
 * @param {{ jobId: string, outcome: "posted"|"failed",
 *   postedReviewUrl?: string|null, verdict?: string, summaryLine?: string,
 *   error?: string, evidenceKeys?: string[],
 *   criterionResults?: Array<{criterionId: string, state: string, expected: string, observed: string, evidenceRefs: string[]}>,
 *   env?: Record<string, string|undefined>,
 *   transport?: (url: string, init: object) => Promise<{status: number, json: () => Promise<unknown>}> }} args
 * @returns {Promise<void>}
 */
export async function completeReviewJob({
  jobId,
  outcome,
  postedReviewUrl,
  verdict,
  summaryLine,
  error,
  evidenceKeys,
  criterionResults,
  env = {},
  transport = realTransport,
}) {
  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) {
    throw new Error(`completeReviewJob: console not configured (missing ${cfg.missing.join(", ")})`);
  }

  // Built field-by-field (never a spread of the caller's args) so an
  // unexpected extra property — e.g. an accidental eveSessionId — can never
  // ride onto the wire. See this module's header comment.
  const body = { jobId, outcome };
  if (postedReviewUrl !== undefined) body.postedReviewUrl = postedReviewUrl;
  if (verdict !== undefined) body.verdict = verdict;
  if (summaryLine !== undefined) body.summaryLine = summaryLine;
  if (error !== undefined) body.error = error;
  if (evidenceKeys !== undefined) body.evidenceKeys = evidenceKeys;
  if (criterionResults !== undefined) body.criterionResults = criterionResults;

  const res = await transport(buildCompleteUrl(cfg.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const status = Number(res && res.status);
  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    throw new Error(`completeReviewJob: console returned ${Number.isFinite(status) ? status : "an invalid status"}`);
  }
}
