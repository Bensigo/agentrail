// Server-bound orchestration for one deterministic UI criterion execution.
// The model supplies only opaque job/criterion/boot ids. The Console returns
// the persisted plan and exact-head preview coordinates; the injected browser
// executor replays those steps and this module sends only its decisive image
// back to the job-scoped completion route.

const REVIEW_JOBS_PATH = "/api/v1/runner/review-jobs";

const NOTES = {
  config_missing:
    "The Console UI-verification endpoint is not configured for this Jace deployment; no browser execution was attempted.",
  bad_request:
    "The UI-verification request was malformed; no browser execution was attempted.",
  unavailable:
    "The Console could not reserve an exact-head planned UI execution. Use the server-attested preview outcome without inventing criterion proof.",
  unreachable:
    "The Console UI-verification endpoint could not be reached. Use the server-attested preview outcome without inventing criterion proof.",
  bad_body:
    "The Console returned an invalid UI-verification contract. Use the server-attested preview outcome without inventing criterion proof.",
};

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonBlank(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
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

export function resolveConsoleConfig(env = {}) {
  const baseUrl = String(env.JACE_CONSOLE_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env.JACE_CONSOLE_TOKEN ?? "").trim();
  return baseUrl && token ? { ok: true, baseUrl, token } : { ok: false };
}

export function buildReviewUiStartUrl(baseUrl, jobId) {
  return `${baseUrl}${REVIEW_JOBS_PATH}/${encodeURIComponent(jobId)}/ui-executions/start`;
}

export function buildReviewUiCompleteUrl(baseUrl, jobId, executionId) {
  return `${baseUrl}${REVIEW_JOBS_PATH}/${encodeURIComponent(jobId)}/ui-executions/${encodeURIComponent(executionId)}/complete`;
}

function projectStartContext(value, input) {
  if (
    !object(value) ||
    !exactKeys(value, [
      "ok", "executionId", "jobId", "criterionId", "expected",
      "previewBootId", "previewUrl", "uiSteps",
    ]) ||
    value.ok !== true ||
    value.jobId !== input.jobId ||
    value.criterionId !== input.criterionId ||
    value.previewBootId !== input.previewBootId ||
    !nonBlank(value.executionId) ||
    !nonBlank(value.expected) ||
    !nonBlank(value.previewUrl) ||
    !Array.isArray(value.uiSteps)
  ) {
    return null;
  }
  return {
    executionId: value.executionId.trim(),
    jobId: input.jobId,
    criterionId: input.criterionId,
    expected: value.expected.trim(),
    previewBootId: input.previewBootId,
    previewUrl: value.previewUrl.trim(),
    uiSteps: value.uiSteps,
  };
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
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

/** Reserve, execute, and receipt one server-owned planned UI criterion. */
export async function runReviewUiExecution({
  eveSessionId,
  jobId,
  criterionId,
  previewBootId,
  env = {},
  transport,
  execute,
}) {
  const session = nonBlank(eveSessionId);
  const job = nonBlank(jobId);
  const criterion = nonBlank(criterionId);
  const boot = nonBlank(previewBootId);
  if (!session || !job || !criterion || !boot || typeof transport !== "function" || typeof execute !== "function") {
    return degraded("bad_request", "not_testable");
  }
  const config = resolveConsoleConfig(env);
  if (!config.ok) return degraded("config_missing", "not_testable");

  let startResponse;
  try {
    startResponse = await transport(
      buildReviewUiStartUrl(config.baseUrl, job),
      requestInit(config.token, {
        eveSessionId: session,
        criterionId: criterion,
        previewBootId: boot,
      }),
    );
  } catch {
    return degraded("unreachable");
  }
  const startStatus = Number(startResponse?.status);
  if (!(startStatus >= 200 && startStatus < 300)) return degraded("unavailable");
  const context = projectStartContext(await responseJson(startResponse), {
    jobId: job,
    criterionId: criterion,
    previewBootId: boot,
  });
  if (!context) return degraded("bad_body");

  let completionCalled = false;
  const completeExecution = async (value) => {
    if (
      completionCalled ||
      !object(value) ||
      !exactKeys(value, [
        "executionId", "jobId", "criterionId", "previewBootId",
        "assertionPassed", "observedUrl", "imageBase64", "contentType",
      ]) ||
      value.executionId !== context.executionId ||
      value.jobId !== job ||
      value.criterionId !== criterion ||
      value.previewBootId !== boot ||
      typeof value.assertionPassed !== "boolean" ||
      !nonBlank(value.observedUrl) ||
      !nonBlank(value.imageBase64) ||
      (value.contentType !== "image/png" && value.contentType !== "image/jpeg")
    ) {
      throw new Error("invalid UI completion");
    }
    completionCalled = true;
    const url = buildReviewUiCompleteUrl(config.baseUrl, job, context.executionId);
    const init = requestInit(config.token, {
      eveSessionId: session,
      assertionPassed: value.assertionPassed,
      observedUrl: value.observedUrl.trim(),
      imageBase64: value.imageBase64.trim(),
      contentType: value.contentType,
    });
    // Completion is content-addressed and append-only. One exact retry is
    // safe after an ambiguous transport error or 5xx: the route either
    // records this same screenshot receipt or replays it, never rerunning
    // the browser flow. Reservation/start is intentionally never retried.
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
        if (!object(body)) throw new Error("invalid UI completion receipt");
        return body;
      }
      if (!(attempt === 0 && status >= 500)) {
        throw new Error("UI completion rejected");
      }
    }
    throw new Error("UI completion rejected");
  };

  try {
    const result = await execute({ context, completeExecution });
    return object(result) ? result : degraded("bad_body");
  } catch {
    return degraded("unavailable");
  }
}
