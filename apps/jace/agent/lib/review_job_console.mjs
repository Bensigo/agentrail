// Console transports for Arc B's headless review-job worker: the two HTTP
// calls review_job_worker.core.mjs's (Task 5) `claim`/`complete` seams need,
// hitting the routes Task 4 built
// (apps/console/app/api/v1/runner/review-jobs/{claim,complete}/route.ts —
// see that task's own report, .superpowers/sdd/task-4-report.md, for the
// exact wire contract this mirrors; it was consulted directly rather than
// re-deriving the shape from this task's brief text alone).
//
// `resolveConsoleConfig` is duplicated verbatim from the sibling *.core.mjs
// modules (fetch_pr_diff.core.mjs, console_gated_approval.core.mjs,
// create_issue.core.mjs, ...) rather than imported — same reasoning as all
// of those: each module here is pure and dependency-free of its siblings by
// design.
//
// TIMEOUT DISCIPLINE (Task 6 brief, obligation 1): review_job_worker.core.mjs
// races ONLY `send` against `jobTimeoutMs` — `claim`/`complete` are NOT
// raced by the core at all, so a transport that hangs here wedges the
// worker's `inFlight` flag forever with no recovery (every subsequent
// `tick()` call becomes a silent no-op — see the core's own `tick()` doc
// comment: "A tick already in flight makes any overlapping call a no-op").
// Both functions below therefore default to `realTransport`, an
// AbortController-bounded fetch, mirroring console_gated_approval.core.mjs's
// own `realTransport` (same REQUEST_TIMEOUT_MS=8000 house convention)
// byte-for-byte.
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
// either (review_job_worker.core.mjs's `runOnce`/`runJob` never thread
// eveSessionId past `claim`).

const REQUEST_TIMEOUT_MS = 8000;

export const CLAIM_PATH = "/api/v1/runner/review-jobs/claim";
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
 * Claim the next eligible review job, binding `eveSessionId` to it
 * server-side in the same call (Arc B §3). Resolves `null` on 204 (nothing
 * eligible); throws on any non-2xx (the worker core's `runOnce` catches this
 * — see review_job_worker.core.mjs's `claim()` try/catch, which logs and
 * treats it the same as "no job": idle, session closed, loop alive).
 *
 * @param {{ workerId: string, eveSessionId: string,
 *   env?: Record<string, string|undefined>,
 *   transport?: (url: string, init: object) => Promise<{status: number, json: () => Promise<unknown>}> }} args
 * @returns {Promise<{ id: string, repo: string, prNumber: number, headSha: string, event: string, workspaceId: string } | null>}
 */
export async function claimReviewJob({ workerId, eveSessionId, env = {}, transport = realTransport }) {
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
    body: JSON.stringify({
      workerId: String(workerId ?? ""),
      eveSessionId: String(eveSessionId ?? ""),
    }),
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
 * Report a claimed job's outcome. Never sends `eveSessionId` — not a
 * parameter this function reads at all (see this module's header comment).
 * Resolves (void) on any 2xx; throws on non-2xx (the worker core's `runJob`
 * catches this and only logs it — a failed report never changes the outcome
 * the loop already returns; the console's stale-requeue is the documented
 * safety net).
 *
 * @param {{ jobId: string, outcome: "posted"|"failed",
 *   postedReviewUrl?: string|null, verdict?: string, summaryLine?: string,
 *   error?: string, env?: Record<string, string|undefined>,
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
