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

const MAX_UI_STEP_TEXT = 2000;
const PRESS_KEYS = new Set([
  "Enter", "Tab", "Escape", "Space", "Backspace",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
]);

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function uiText(value, allowEmpty = false) {
  if (typeof value !== "string" || value.length > MAX_UI_STEP_TEXT || /[\x00-\x1f\x7f]/.test(value)) return null;
  const normalized = value.trim();
  return allowEmpty || normalized ? normalized : null;
}

/** Project only the closed browser-step protocol accepted by the console. */
export function normalizeUiSteps(value) {
  if (!Array.isArray(value) || value.length < 3 || value.length > 12) return null;
  const steps = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.action !== "string") return null;
    switch (raw.action) {
      case "open": {
        if (!exactKeys(raw, ["action", "path"]) || typeof raw.path !== "string") return null;
        const path = uiText(raw.path);
        if (!path || path !== raw.path || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
        steps.push({ action: "open", path });
        break;
      }
      case "click": {
        if (!exactKeys(raw, ["action", "selector"])) return null;
        const selector = uiText(raw.selector);
        if (!selector) return null;
        steps.push({ action: "click", selector });
        break;
      }
      case "fill": {
        if (!exactKeys(raw, ["action", "selector", "value"])) return null;
        const selector = uiText(raw.selector);
        const fillValue = uiText(raw.value, true);
        if (!selector || fillValue === null) return null;
        steps.push({ action: "fill", selector, value: fillValue });
        break;
      }
      case "press": {
        if (!exactKeys(raw, ["action", "key"]) || !PRESS_KEYS.has(raw.key)) return null;
        steps.push({ action: "press", key: raw.key });
        break;
      }
      case "expect_text": {
        if (!exactKeys(raw, ["action", "text"])) return null;
        const text = uiText(raw.text);
        if (!text) return null;
        steps.push({ action: "expect_text", text });
        break;
      }
      case "screenshot": {
        if (!exactKeys(raw, ["action", "label"])) return null;
        const label = uiText(raw.label);
        if (!label) return null;
        steps.push({ action: "screenshot", label });
        break;
      }
      default:
        return null;
    }
  }
  if (
    steps[0].action !== "open" ||
    steps.at(-2).action !== "expect_text" ||
    steps.at(-1).action !== "screenshot" ||
    steps.slice(1, -2).some((step) => !["click", "fill", "press"].includes(step.action))
  ) return null;
  return steps;
}

/** Project the only API operation this R7.2 executor can perform. */
export function normalizeApiRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, ["method", "path", "expectedStatus"])) return null;
  const path = uiText(value.path);
  if (
    value.method !== "GET" ||
    !path || path !== value.path || !path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("%") || /[?#]/.test(path) ||
    !Number.isInteger(value.expectedStatus) || value.expectedStatus < 100 || value.expectedStatus > 599
  ) return null;
  for (const segment of path.split("/")) {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { return null; }
    if (decoded === "." || decoded === ".." || /[\u0000-\u001f\u007f?#\\/]/u.test(decoded)) return null;
  }
  return { method: "GET", path, expectedStatus: value.expectedStatus };
}

function dataScalar(value) {
  return value === null || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length <= MAX_UI_STEP_TEXT && !/[\x00-\x1f\x7f]/.test(value));
}

function sensitiveExpected(value) {
  if (Number.isInteger(value) && Math.abs(value) >= 100_000_000) return true;
  if (typeof value !== "string") return false;
  const digits = value.replace(/\D/g, "");
  return /[^\s@]+@[^\s@]+\.[^\s@]+/u.test(value) ||
    /\b\d{3}-?\d{2}-?\d{4}\b/u.test(value) ||
    (digits.length >= 10 && digits.length <= 19);
}

/** A bounded RFC6901 pointer. Array-index canonicality is checked at resolution time: `/01` can be an object key but not an array index. */
export function normalizeDataPointer(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) return null;
  for (const segment of value.slice(1).split("/")) {
    if (/~(?![01])/u.test(segment)) return null;
    const decoded = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (/(?:token|password|passwd|passcode|secret|api[_-]?key|authorization|cookie|credential|private[_-]?key|client[_-]?secret|pin|otp|ssn|social[-_ ]?security|tax[-_ ]?id|card|credit|cvv|cvc|pan|email|phone|mobile|address|birth|dob)/iu.test(decoded)) return null;
  }
  return value;
}

/** Project the only bounded JSON-readback descriptor this executor can perform. */
export function normalizeDataRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, ["method", "path", "expectedStatus", "expectedJson"])) return null;
  const base = normalizeApiRequest({ method: value.method, path: value.path, expectedStatus: value.expectedStatus });
  if (!base || !Array.isArray(value.expectedJson) || value.expectedJson.length < 1 || value.expectedJson.length > 12) return null;
  const pointers = new Set();
  const expectedJson = [];
  for (const raw of value.expectedJson) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !exactKeys(raw, ["pointer", "equals"])) return null;
    const pointer = normalizeDataPointer(raw.pointer);
    if (!pointer || pointers.has(pointer) || !dataScalar(raw.equals) || sensitiveExpected(raw.equals)) return null;
    pointers.add(pointer);
    expectedJson.push({ pointer, equals: raw.equals });
  }
  return { ...base, expectedJson };
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
    const flow = uiText(raw.flow) ?? "";
    const notTestableReason = uiText(raw.notTestableReason) ?? "";
    if (!criterionId || ids.has(criterionId) || !["ui", "api", "job", "data"].includes(modality)) return null;
    ids.add(criterionId);
    if (status === "planned") {
      if (!flow || notTestableReason) return null;
      if (modality === "ui") {
        if (!exactKeys(raw, ["criterionId", "modality", "status", "flow", "uiSteps"])) return null;
        const uiSteps = normalizeUiSteps(raw.uiSteps);
        if (!uiSteps) return null;
        plans.push({ criterionId, modality, status, flow, uiSteps });
      } else if (modality === "api") {
        if (!exactKeys(raw, ["criterionId", "modality", "status", "flow", "apiRequest"])) return null;
        const apiRequest = normalizeApiRequest(raw.apiRequest);
        if (!apiRequest) return null;
        plans.push({ criterionId, modality, status, flow, apiRequest });
      } else if (modality === "data") {
        if (!exactKeys(raw, ["criterionId", "modality", "status", "flow", "dataRequest"])) return null;
        const dataRequest = normalizeDataRequest(raw.dataRequest);
        if (!dataRequest) return null;
        plans.push({ criterionId, modality, status, flow, dataRequest });
      } else return null;
    } else if (status === "not_testable") {
      if (
        !exactKeys(raw, ["criterionId", "modality", "status", "notTestableReason"]) ||
        !notTestableReason ||
        flow
      ) return null;
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
