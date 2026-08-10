// Server-bound orchestration for one deterministic data readback execution.
// Start reserves the exact-head descriptor once; complete records only bounded
// observations, never a response body or model-authored interpretation.

const REVIEW_JOBS_PATH = "/api/v1/runner/review-jobs";
const NOTES = {
  config_missing:
    "The Console data-verification endpoint is not configured for this Jace deployment; no data request was attempted.",
  bad_request:
    "The data-verification request was malformed; no data request was attempted.",
  unavailable:
    "The Console could not reserve an exact-head planned data execution. Use the server-attested preview outcome without inventing criterion proof.",
  unreachable:
    "The Console data-verification endpoint could not be reached. Use the server-attested preview outcome without inventing criterion proof.",
  bad_body:
    "The Console returned an invalid data-verification contract. Use the server-attested preview outcome without inventing criterion proof.",
};

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonBlank(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}
function degraded(reason, state = "not_proven") {
  return {
    ok: false,
    degraded: true,
    state,
    reason,
    note: NOTES[reason] ?? NOTES.unavailable,
  };
}
function pointer(value) {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    value.length <= 512 &&
    !/[\x00-\x1f\x7f]/.test(value) &&
    value
      .slice(1)
      .split("/")
      .every(
        (part) =>
          !/~(?![01])/u.test(part) &&
          !/(?:token|password|passwd|passcode|secret|api[_-]?key|authorization|cookie|credential|private[_-]?key|client[_-]?secret|pin|otp|ssn|social[-_ ]?security|tax[-_ ]?id|card|credit|cvv|cvc|pan|email|phone|mobile|address|birth|dob)/iu.test(
            part.replace(/~1/g, "/").replace(/~0/g, "~"),
          ),
      )
  );
}
function storedDataRequest(value) {
  if (
    !object(value) ||
    !exactKeys(value, ["method", "path", "expectedStatus", "expectedJson", "digestAlgorithm", "digestKeyId", "digestContext"]) ||
    value.method !== "GET" ||
    !nonBlank(value.path) ||
    !Number.isInteger(value.expectedStatus) ||
    value.expectedStatus < 100 ||
    value.expectedStatus > 599 ||
    value.digestAlgorithm !== "hmac-sha256-v1" ||
    typeof value.digestKeyId !== "string" ||
    !/^[A-Za-z0-9._-]{1,64}$/u.test(value.digestKeyId) ||
    typeof value.digestContext !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.digestContext) ||
    !Array.isArray(value.expectedJson) ||
    value.expectedJson.length < 1 ||
    value.expectedJson.length > 12
  )
    return null;
  const seen = new Set();
  const expectedJson = [];
  for (const item of value.expectedJson) {
    if (
      !object(item) ||
      !exactKeys(item, ["pointer", "equalsType", "equalsHmacSha256"]) ||
      !pointer(item.pointer) ||
      seen.has(item.pointer) ||
      !["null", "boolean", "number", "string"].includes(item.equalsType) ||
      typeof item.equalsHmacSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.equalsHmacSha256)
    )
      return null;
    seen.add(item.pointer);
    expectedJson.push({ pointer: item.pointer, equalsType: item.equalsType, equalsHmacSha256: item.equalsHmacSha256 });
  }
  return {
    method: "GET",
    path: value.path,
    expectedStatus: value.expectedStatus,
    digestAlgorithm: value.digestAlgorithm,
    digestKeyId: value.digestKeyId,
    digestContext: value.digestContext,
    expectedJson,
  };
}
function observations(value, expected) {
  if (!Array.isArray(value) || value.length !== expected.length) return null;
  const out = [];
  for (let index = 0; index < expected.length; index += 1) {
    const item = value[index];
    if (
      !object(item) ||
      item.pointer !== expected[index].pointer ||
      typeof item.found !== "boolean"
    )
      return null;
    if (item.found) {
      if (
        !exactKeys(item, ["pointer", "found", "observedType", "observedHmacSha256"]) ||
        !["null", "boolean", "number", "string"].includes(item.observedType) ||
        typeof item.observedHmacSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(item.observedHmacSha256)
      )
        return null;
      out.push({ pointer: item.pointer, found: true, observedType: item.observedType, observedHmacSha256: item.observedHmacSha256 });
    } else {
      if (!exactKeys(item, ["pointer", "found"])) return null;
      out.push({ pointer: item.pointer, found: false });
    }
  }
  return out;
}

export function resolveConsoleConfig(env = {}) {
  const baseUrl = String(env.JACE_CONSOLE_BASE_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  const token = String(env.JACE_CONSOLE_TOKEN ?? "").trim();
  return baseUrl && token ? { ok: true, baseUrl, token } : { ok: false };
}
export function buildReviewDataStartUrl(baseUrl, jobId) {
  return `${baseUrl}${REVIEW_JOBS_PATH}/${encodeURIComponent(jobId)}/data-executions/start`;
}
export function buildReviewDataCompleteUrl(baseUrl, jobId, executionId) {
  return `${baseUrl}${REVIEW_JOBS_PATH}/${encodeURIComponent(jobId)}/data-executions/${encodeURIComponent(executionId)}/complete`;
}
function responseJson(response) {
  return Promise.resolve()
    .then(() => response.json())
    .catch(() => null);
}
function requestInit(token, body) {
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  };
}

function projectStartContext(value, input) {
  if (
    !object(value) ||
    !exactKeys(value, [
      "ok",
      "executionId",
      "jobId",
      "criterionId",
      "expected",
      "previewBootId",
      "previewUrl",
      "dataRequest",
    ]) ||
    value.ok !== true ||
    value.jobId !== input.jobId ||
    value.criterionId !== input.criterionId ||
    value.previewBootId !== input.previewBootId ||
    !nonBlank(value.executionId) ||
    !nonBlank(value.expected) ||
    !nonBlank(value.previewUrl)
  )
    return null;
  const request = storedDataRequest(value.dataRequest);
  if (!request) return null;
  return {
    executionId: value.executionId.trim(),
    jobId: input.jobId,
    criterionId: input.criterionId,
    expected: value.expected.trim(),
    previewBootId: input.previewBootId,
    previewUrl: value.previewUrl.trim(),
    dataRequest: request,
  };
}

export async function runReviewDataExecution({
  eveSessionId,
  jobId,
  criterionId,
  previewBootId,
  env = {},
  keyring,
  transport,
  execute,
}) {
  const session = nonBlank(eveSessionId);
  const job = nonBlank(jobId);
  const criterion = nonBlank(criterionId);
  const boot = nonBlank(previewBootId);
  if (
    !session ||
    !job ||
    !criterion ||
    !boot ||
    typeof transport !== "function" ||
    typeof execute !== "function"
  )
    return degraded("bad_request", "not_testable");
  const config = resolveConsoleConfig(env);
  if (!config.ok) return degraded("config_missing", "not_testable");
  if (!(keyring?.keys instanceof Map) || keyring.keys.size < 1 || keyring.keys.size > 16) return degraded("config_missing", "not_testable");
  const digestKeyIds = [...keyring.keys.keys()].sort();
  if (digestKeyIds.some((keyId) => !/^[A-Za-z0-9._-]{1,64}$/u.test(keyId))) return degraded("config_missing", "not_testable");
  let startResponse;
  try {
    startResponse = await transport(
      buildReviewDataStartUrl(config.baseUrl, job),
      requestInit(config.token, {
        eveSessionId: session,
        criterionId: criterion,
        previewBootId: boot,
        digestKeyIds,
      }),
    );
  } catch {
    return degraded("unreachable");
  }
  if (
    !(
      Number(startResponse?.status) >= 200 &&
      Number(startResponse?.status) < 300
    )
  )
    return degraded("unavailable");
  const context = projectStartContext(await responseJson(startResponse), {
    jobId: job,
    criterionId: criterion,
    previewBootId: boot,
  });
  if (!context) return degraded("bad_body");
  let completionCalled = false;
  const completeExecution = async (value) => {
    const projected =
      object(value) &&
      exactKeys(value, [
        "executionId",
        "jobId",
        "criterionId",
        "previewBootId",
        "observedStatus",
        "observations",
      ]) &&
      value.executionId === context.executionId &&
      value.jobId === job &&
      value.criterionId === criterion &&
      value.previewBootId === boot &&
      Number.isInteger(value.observedStatus) &&
      value.observedStatus >= 100 &&
      value.observedStatus <= 599 &&
      (value.observedStatus === context.dataRequest.expectedStatus
        ? observations(value.observations, context.dataRequest.expectedJson)
        : Array.isArray(value.observations) && value.observations.length === 0
          ? []
          : null);
    if (completionCalled || !projected)
      throw new Error("invalid data completion");
    completionCalled = true;
    const url = buildReviewDataCompleteUrl(
      config.baseUrl,
      job,
      context.executionId,
    );
    const init = requestInit(config.token, {
      eveSessionId: session,
      observedStatus: value.observedStatus,
      observations: projected,
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response;
      try {
        response = await transport(url, init);
      } catch (error) {
        if (attempt === 0) continue;
        throw error;
      }
      const status = Number(response?.status);
      if (status >= 200 && status < 300) {
        const body = await responseJson(response);
        if (!object(body)) throw new Error("invalid data completion receipt");
        return body;
      }
      if (!(attempt === 0 && status >= 500))
        throw new Error("data completion rejected");
    }
    throw new Error("data completion rejected");
  };
  try {
    const result = await execute({ context, completeExecution });
    return object(result) ? result : degraded("bad_body");
  } catch {
    return degraded("unavailable");
  }
}
