// Pure root-tool seam for recording the review job's complete verification
// plan before any evidence is collected. The console, not the model, binds
// the job to workspace/repo/PR/head and persists the plan.

const REVIEW_JOBS_PATH = "/api/v1/runner/review-jobs";

const NOTES = {
  config_missing:
    "The review verification-plan endpoint is not configured for this Jace deployment; no plan was recorded.",
  bad_request:
    "The review verification plan was malformed; no plan was recorded.",
  unreachable:
    "The review verification-plan endpoint could not be reached; no plan was recorded. Do not retry from here.",
  review_context:
    "The console could not bind this plan to the active review job, exact Acceptance Record head, and confirmed Contract; no plan was recorded.",
  request_failed:
    "The console rejected the review verification plan with an unexpected status; no plan was recorded.",
  bad_body:
    "The console responded, but the verification-plan response was not valid; no plan was confirmed.",
};

export function resolveConsoleConfig(env = {}) {
  const baseUrl = String(env.JACE_CONSOLE_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env.JACE_CONSOLE_TOKEN ?? "").trim();
  const missing = [];
  if (!baseUrl) missing.push("JACE_CONSOLE_BASE_URL");
  if (!token) missing.push("JACE_CONSOLE_TOKEN");
  return missing.length ? { ok: false, missing } : { ok: true, baseUrl, token };
}

export function buildVerificationPlanUrl(baseUrl, jobId) {
  return `${baseUrl}${REVIEW_JOBS_PATH}/${encodeURIComponent(jobId)}/verification-plan`;
}

export function degraded(reason, extra = {}) {
  return { ok: false, degraded: true, reason, note: NOTES[reason] ?? NOTES.request_failed, ...extra };
}

function nonblank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate and project the complete plan set. Projection means model-supplied
 * extras can never ride to the console as an undeclared second write shape.
 */
export function normalizePlans(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const ids = new Set();
  const plans = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const criterionId = typeof raw.criterionId === "string" ? raw.criterionId.trim() : "";
    const modality = raw.modality;
    const status = raw.status;
    const flow = typeof raw.flow === "string" ? raw.flow.trim() : "";
    const notTestableReason = typeof raw.notTestableReason === "string" ? raw.notTestableReason.trim() : "";
    if (!criterionId || ids.has(criterionId) || !["ui", "api", "job", "data"].includes(modality)) return null;
    ids.add(criterionId);
    if (status === "planned") {
      if (!flow || notTestableReason) return null;
      plans.push({ criterionId, modality, status, flow });
    } else if (status === "not_testable") {
      if (!notTestableReason || flow) return null;
      plans.push({ criterionId, modality, status, notTestableReason });
    } else {
      return null;
    }
  }
  return plans;
}

/**
 * POST a complete plan for the server-bound review job. Never throws. If the
 * plan cannot be durably recorded, the headless reviewer has no authority to
 * post a review or claim `not_testable`; the prompt requires the turn to fail
 * closed instead.
 */
export async function planReviewVerification({ eveSessionId, jobId, plans, env = {}, transport }) {
  const sessionId = String(eveSessionId ?? "").trim();
  const reviewJobId = String(jobId ?? "").trim();
  const normalizedPlans = normalizePlans(plans);
  if (!sessionId || !reviewJobId || !normalizedPlans) return degraded("bad_request");

  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return degraded("config_missing", { missing: cfg.missing });

  let response;
  try {
    response = await transport(buildVerificationPlanUrl(cfg.baseUrl, reviewJobId), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ eveSessionId: sessionId, plans: normalizedPlans }),
    });
  } catch {
    return degraded("unreachable");
  }

  const status = Number(response && response.status);
  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    if (status === 400) return degraded("bad_request", { status });
    if (status === 409) return degraded("review_context", { status });
    return degraded("request_failed", { status });
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return degraded("bad_body", { status });
  }
  if (!body || typeof body !== "object" || body.ok !== true) return degraded("bad_body", { status });
  return { ok: true };
}
