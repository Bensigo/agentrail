// Server-bound orchestration for a deterministic API review execution. Start
// owns exact-head coordinates and the immutable request descriptor; complete
// owns status comparison and attestation.

const REVIEW_JOBS_PATH = "/api/v1/runner/review-jobs";

const NOTES = {
  config_missing: "The Console API-verification endpoint is not configured for this Jace deployment; no API request was attempted.",
  bad_request: "The API-verification request was malformed; no API request was attempted.",
  unavailable: "The Console could not reserve an exact-head planned API execution. Use the server-attested preview outcome without inventing criterion proof.",
  unreachable: "The Console API-verification endpoint could not be reached. Use the server-attested preview outcome without inventing criterion proof.",
  bad_body: "The Console returned an invalid API-verification contract. Use the server-attested preview outcome without inventing criterion proof.",
};

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonBlank(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function exactKeys(value, expected) {
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
function degraded(reason, state = "not_proven") { return { ok: false, degraded: true, state, reason, note: NOTES[reason] ?? NOTES.unavailable }; }

export function resolveConsoleConfig(env = {}) {
  const baseUrl = String(env.JACE_CONSOLE_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env.JACE_CONSOLE_TOKEN ?? "").trim();
  return baseUrl && token ? { ok: true, baseUrl, token } : { ok: false };
}
export function buildReviewApiStartUrl(baseUrl, jobId) { return `${baseUrl}${REVIEW_JOBS_PATH}/${encodeURIComponent(jobId)}/api-executions/start`; }
export function buildReviewApiCompleteUrl(baseUrl, jobId, executionId) { return `${baseUrl}${REVIEW_JOBS_PATH}/${encodeURIComponent(jobId)}/api-executions/${encodeURIComponent(executionId)}/complete`; }

function projectStartContext(value, input) {
  if (!object(value) || !exactKeys(value, ["ok", "executionId", "jobId", "criterionId", "expected", "previewBootId", "previewUrl", "apiRequest"]) ||
    value.ok !== true || value.jobId !== input.jobId || value.criterionId !== input.criterionId || value.previewBootId !== input.previewBootId ||
    !nonBlank(value.executionId) || !nonBlank(value.expected) || !nonBlank(value.previewUrl) || !object(value.apiRequest) ||
    !exactKeys(value.apiRequest, ["method", "path", "expectedStatus"]) || value.apiRequest.method !== "GET" ||
    !nonBlank(value.apiRequest.path) || !Number.isInteger(value.apiRequest.expectedStatus) || value.apiRequest.expectedStatus < 100 || value.apiRequest.expectedStatus > 599) return null;
  return { executionId: value.executionId.trim(), jobId: input.jobId, criterionId: input.criterionId, expected: value.expected.trim(), previewBootId: input.previewBootId, previewUrl: value.previewUrl.trim(), apiRequest: value.apiRequest };
}
async function responseJson(response) { try { return await response.json(); } catch { return null; } }
function requestInit(token, body) { return { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) }; }

export async function runReviewApiExecution({ eveSessionId, jobId, criterionId, previewBootId, env = {}, transport, execute }) {
  const session = nonBlank(eveSessionId); const job = nonBlank(jobId); const criterion = nonBlank(criterionId); const boot = nonBlank(previewBootId);
  if (!session || !job || !criterion || !boot || typeof transport !== "function" || typeof execute !== "function") return degraded("bad_request", "not_testable");
  const config = resolveConsoleConfig(env);
  if (!config.ok) return degraded("config_missing", "not_testable");
  let startResponse;
  try {
    startResponse = await transport(buildReviewApiStartUrl(config.baseUrl, job), requestInit(config.token, { eveSessionId: session, criterionId: criterion, previewBootId: boot }));
  } catch { return degraded("unreachable"); }
  if (!(Number(startResponse?.status) >= 200 && Number(startResponse?.status) < 300)) return degraded("unavailable");
  const context = projectStartContext(await responseJson(startResponse), { jobId: job, criterionId: criterion, previewBootId: boot });
  if (!context) return degraded("bad_body");
  let completionCalled = false;
  const completeExecution = async (value) => {
    if (completionCalled || !object(value) || !exactKeys(value, ["executionId", "jobId", "criterionId", "previewBootId", "observedStatus"]) ||
      value.executionId !== context.executionId || value.jobId !== job || value.criterionId !== criterion || value.previewBootId !== boot ||
      !Number.isInteger(value.observedStatus) || value.observedStatus < 100 || value.observedStatus > 599) throw new Error("invalid API completion");
    completionCalled = true;
    const url = buildReviewApiCompleteUrl(config.baseUrl, job, context.executionId);
    const init = requestInit(config.token, { eveSessionId: session, observedStatus: value.observedStatus });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response;
      try { response = await transport(url, init); } catch (error) { if (attempt === 0) continue; throw error; }
      const status = Number(response?.status);
      if (status >= 200 && status < 300) { const body = await responseJson(response); if (!object(body)) throw new Error("invalid API completion receipt"); return body; }
      if (!(attempt === 0 && status >= 500)) throw new Error("API completion rejected");
    }
    throw new Error("API completion rejected");
  };
  try { const result = await execute({ context, completeExecution }); return object(result) ? result : degraded("bad_body"); } catch { return degraded("unavailable"); }
}
