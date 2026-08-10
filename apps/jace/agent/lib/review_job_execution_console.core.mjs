// Server-bound orchestration for a single non-visible job execution. Start is
// at-most-once; complete may retry because neither retry repeats the trigger.
const REVIEW_JOBS_PATH = "/api/v1/runner/review-jobs";
const NOTES = {
  config_missing:
    "The Console job-verification endpoint is not configured for this Jace deployment; no job was attempted.",
  bad_request:
    "The job-verification request was malformed; no job was attempted.",
  unavailable:
    "The Console could not reserve an exact-head planned job execution. Use the server-attested preview outcome without inventing criterion proof.",
  unreachable:
    "The Console job-verification endpoint could not be reached. Use the server-attested preview outcome without inventing criterion proof.",
  bad_body:
    "The Console returned an invalid job-verification contract. Use the server-attested preview outcome without inventing criterion proof.",
};
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonBlank = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;
function exactKeys(value, expected) {
  const actual = Object.keys(value).sort(),
    wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}
const degraded = (reason, state = "not_proven") => ({
  ok: false,
  degraded: true,
  state,
  reason,
  note: NOTES[reason] ?? NOTES.unavailable,
});
function pointer(value) {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    value.length <= 512 &&
    !/[\x00-\x1f\x7f]/u.test(value) &&
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
function storedReadback(value) {
  if (
    !object(value) ||
    !exactKeys(value, [
      "method",
      "path",
      "expectedStatus",
      "expectedJson",
      "digestAlgorithm",
      "digestKeyId",
      "digestContext",
    ]) ||
    value.method !== "GET" ||
    !nonBlank(value.path) ||
    !Number.isInteger(value.expectedStatus) ||
    value.expectedStatus < 200 ||
    value.expectedStatus > 299 ||
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
  const seen = new Set(),
    expectedJson = [];
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
    expectedJson.push({
      pointer: item.pointer,
      equalsType: item.equalsType,
      equalsHmacSha256: item.equalsHmacSha256,
    });
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
function storedJobRequest(value) {
  if (
    !object(value) ||
    !exactKeys(value, ["trigger", "readback"]) ||
    !object(value.trigger) ||
    !exactKeys(value.trigger, ["method", "path", "expectedStatus"]) ||
    value.trigger.method !== "POST" ||
    !nonBlank(value.trigger.path) ||
    !Number.isInteger(value.trigger.expectedStatus) ||
    value.trigger.expectedStatus < 200 ||
    value.trigger.expectedStatus > 299
  )
    return null;
  const readback = storedReadback(value.readback);
  if (!readback) return null;
  const triggerMatch = value.trigger.path.match(
    /^\/__agentrail\/verification\/jobs\/([A-Za-z0-9._-]{1,64})\/trigger$/u,
  );
  const readbackMatch = readback.path.match(
    /^\/__agentrail\/verification\/jobs\/([A-Za-z0-9._-]{1,64})\/result$/u,
  );
  if (!triggerMatch || !readbackMatch || triggerMatch[1] !== readbackMatch[1])
    return null;
  return {
    trigger: {
      method: "POST",
      path: value.trigger.path,
      expectedStatus: value.trigger.expectedStatus,
    },
    readback,
  };
}
export function resolveConsoleConfig(env = {}) {
  const baseUrl = String(env.JACE_CONSOLE_BASE_URL ?? "")
      .trim()
      .replace(/\/+$/, ""),
    token = String(env.JACE_CONSOLE_TOKEN ?? "").trim();
  return baseUrl && token ? { ok: true, baseUrl, token } : { ok: false };
}
export function buildReviewJobStartUrl(baseUrl, jobId) {
  return `${baseUrl}${REVIEW_JOBS_PATH}/${encodeURIComponent(jobId)}/job-executions/start`;
}
export function buildReviewJobCompleteUrl(baseUrl, jobId, executionId) {
  return `${baseUrl}${REVIEW_JOBS_PATH}/${encodeURIComponent(jobId)}/job-executions/${encodeURIComponent(executionId)}/complete`;
}
const responseJson = (response) =>
  Promise.resolve()
    .then(() => response.json())
    .catch(() => null);
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
      "jobRequest",
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
  const jobRequest = storedJobRequest(value.jobRequest);
  if (!jobRequest) return null;
  return {
    executionId: value.executionId.trim(),
    jobId: input.jobId,
    criterionId: input.criterionId,
    expected: value.expected.trim(),
    previewBootId: input.previewBootId,
    previewUrl: value.previewUrl.trim(),
    jobRequest,
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
        !exactKeys(item, [
          "pointer",
          "found",
          "observedType",
          "observedHmacSha256",
        ]) ||
        !["null", "boolean", "number", "string"].includes(item.observedType) ||
        typeof item.observedHmacSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(item.observedHmacSha256)
      )
        return null;
      out.push({
        pointer: item.pointer,
        found: true,
        observedType: item.observedType,
        observedHmacSha256: item.observedHmacSha256,
      });
    } else {
      if (!exactKeys(item, ["pointer", "found"])) return null;
      out.push({ pointer: item.pointer, found: false });
    }
  }
  return out;
}
export async function runReviewJobExecution({
  eveSessionId,
  jobId,
  criterionId,
  previewBootId,
  env = {},
  keyring,
  transport,
  execute,
}) {
  const session = nonBlank(eveSessionId),
    job = nonBlank(jobId),
    criterion = nonBlank(criterionId),
    boot = nonBlank(previewBootId);
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
  if (
    !config.ok ||
    !(keyring?.keys instanceof Map) ||
    keyring.keys.size < 1 ||
    keyring.keys.size > 16
  )
    return degraded("config_missing", "not_testable");
  const digestKeyIds = [...keyring.keys.keys()].sort();
  if (digestKeyIds.some((keyId) => !/^[A-Za-z0-9._-]{1,64}$/u.test(keyId)))
    return degraded("config_missing", "not_testable");
  let startResponse;
  try {
    startResponse = await transport(
      buildReviewJobStartUrl(config.baseUrl, job),
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
    const triggerMismatch =
      object(value) &&
      value.observedTriggerStatus !== context.jobRequest.trigger.expectedStatus;
    const projected =
      !triggerMismatch &&
      value?.observedReadbackStatus ===
        context.jobRequest.readback.expectedStatus
        ? observations(
            value?.observations,
            context.jobRequest.readback.expectedJson,
          )
        : Array.isArray(value?.observations) && value.observations.length === 0
          ? []
          : null;
    const valid =
      object(value) &&
      exactKeys(value, [
        "executionId",
        "jobId",
        "criterionId",
        "previewBootId",
        "observedTriggerStatus",
        "observedReadbackStatus",
        "observations",
      ]) &&
      value.executionId === context.executionId &&
      value.jobId === job &&
      value.criterionId === criterion &&
      value.previewBootId === boot &&
      Number.isInteger(value.observedTriggerStatus) &&
      value.observedTriggerStatus >= 100 &&
      value.observedTriggerStatus <= 599 &&
      ((triggerMismatch && value.observedReadbackStatus === null) ||
        (!triggerMismatch &&
          Number.isInteger(value.observedReadbackStatus) &&
          value.observedReadbackStatus >= 100 &&
          value.observedReadbackStatus <= 599)) &&
      projected !== null;
    if (completionCalled || !valid) throw new Error("invalid job completion");
    completionCalled = true;
    const url = buildReviewJobCompleteUrl(
      config.baseUrl,
      job,
      context.executionId,
    );
    const init = requestInit(config.token, {
      eveSessionId: session,
      observedTriggerStatus: value.observedTriggerStatus,
      observedReadbackStatus: value.observedReadbackStatus,
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
        if (!object(body)) throw new Error("invalid job completion receipt");
        return body;
      }
      if (!(attempt === 0 && status >= 500))
        throw new Error("job completion rejected");
    }
    throw new Error("job completion rejected");
  };
  try {
    const result = await execute({ context, completeExecution });
    return object(result) ? result : degraded("bad_body");
  } catch {
    return degraded("unavailable");
  }
}
