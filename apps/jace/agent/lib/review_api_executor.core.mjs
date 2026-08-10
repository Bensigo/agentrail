// Deterministic executor for one server-resolved API criterion. The model
// never supplies a URL, method, request payload, credentials, or headers.

const MAX_PATH_LENGTH = 2_000;
const DEFAULT_TIMEOUT_MS = 8_000;

class NotTestableError extends Error {}
class NotProvenError extends Error {}

function degraded(state) {
  return { ok: false, degraded: true, state };
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedText(value) {
  if (typeof value !== "string" || value.length > MAX_PATH_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  const text = value.trim();
  return text || null;
}

function previewOrigin(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new NotTestableError();
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new NotTestableError();
  }
  return url.origin;
}

/**
 * A persisted API request is intentionally only a relative GET path and the
 * expected status. Decode each segment before checking dots so `%2e%2e`
 * cannot turn into traversal during URL parsing or a proxy hop.
 */
function strictRelativeGetPath(value) {
  const path = boundedText(value);
  if (!path || path !== value || !path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("%") || /[?#]/u.test(path)) {
    throw new NotTestableError();
  }
  for (const segment of path.split("/")) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new NotTestableError();
    }
    if (decoded === "." || decoded === ".." || /[\u0000-\u001f\u007f?#\\/]/u.test(decoded)) {
      throw new NotTestableError();
    }
  }
  return path;
}

function validateContext(raw) {
  if (!object(raw) || !exactKeys(raw, [
    "executionId", "jobId", "criterionId", "expected", "previewBootId", "previewUrl", "apiRequest",
  ])) throw new NotTestableError();
  if (!object(raw.apiRequest) || !exactKeys(raw.apiRequest, ["method", "path", "expectedStatus"])) throw new NotTestableError();
  const executionId = boundedText(raw.executionId);
  const jobId = boundedText(raw.jobId);
  const criterionId = boundedText(raw.criterionId);
  const expected = boundedText(raw.expected);
  const previewBootId = boundedText(raw.previewBootId);
  const previewUrl = boundedText(raw.previewUrl);
  if (raw.apiRequest.method !== "GET") throw new NotTestableError();
  const path = strictRelativeGetPath(raw.apiRequest.path);
  const expectedStatus = raw.apiRequest.expectedStatus;
  if (!executionId || !jobId || !criterionId || !expected || !previewBootId || !previewUrl || !Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) {
    throw new NotTestableError();
  }
  return { executionId, jobId, criterionId, expected, previewBootId, previewUrl, path, expectedStatus };
}

function requestUrl(path, origin) {
  let url;
  try {
    url = new URL(path, origin);
  } catch {
    throw new NotTestableError();
  }
  if (url.origin !== origin || url.username || url.password || url.search || url.hash) throw new NotTestableError();
  return url.toString();
}

function validAttestedReceipt(value, { context }) {
  if (
    !object(value) ||
    !exactKeys(value, ["ok", "state", "expected", "observed", "observedStatus", "evidenceRef", "evidenceKey", "evidenceUrl"]) ||
    value.ok !== true ||
    value.state !== (context.observedStatus === context.expectedStatus ? "proven" : "failed") ||
    value.expected !== context.expected ||
    value.observedStatus !== context.observedStatus ||
    value.evidenceRef !== `review-api-execution:${context.executionId}` ||
    value.observed !== (context.observedStatus === context.expectedStatus
      ? `The safe GET ${context.path} returned the planned HTTP ${context.expectedStatus}.`
      : `The safe GET ${context.path} returned HTTP ${context.observedStatus}; the planned status was ${context.expectedStatus}.`) ||
    !boundedText(value.evidenceKey)
  ) return false;
  try {
    const evidenceUrl = new URL(String(value.evidenceUrl));
    return (evidenceUrl.protocol === "http:" || evidenceUrl.protocol === "https:") && !evidenceUrl.username && !evidenceUrl.password;
  } catch { return false; }
}

/**
 * Execute exactly one persisted same-origin GET. It deliberately never calls
 * `text`, `json`, `arrayBuffer`, or `body`: status is the entire API proof.
 */
export function createReviewApiExecutor({ fetchPreview, completeExecution, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (typeof fetchPreview !== "function") throw new TypeError("fetchPreview is required");
  if (typeof completeExecution !== "function") throw new TypeError("completeExecution is required");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new TypeError("timeoutMs must be an integer between 1 and 30000");
  }

  return async function execute(rawContext) {
    try {
      const context = validateContext(rawContext);
      const origin = previewOrigin(context.previewUrl);
      const url = requestUrl(context.path, origin);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchPreview(url, {
          method: "GET",
          redirect: "error",
          credentials: "omit",
          signal: controller.signal,
        });
      } catch {
        throw new NotProvenError();
      } finally {
        clearTimeout(timer);
      }
      const observedStatus = Number(response?.status);
      if (response?.redirected === true || !Number.isInteger(observedStatus) || observedStatus < 100 || observedStatus > 599) throw new NotProvenError();
      const receipt = await completeExecution({
        executionId: context.executionId,
        jobId: context.jobId,
        criterionId: context.criterionId,
        previewBootId: context.previewBootId,
        observedStatus,
      });
      const attestationContext = { ...context, observedStatus };
      return validAttestedReceipt(receipt, { context: attestationContext })
        ? receipt
        : degraded("not_proven");
    } catch (error) {
      return degraded(error instanceof NotTestableError ? "not_testable" : "not_proven");
    }
  };
}
