// Deterministic, plan-bound API execution. This deliberately performs one
// persisted same-origin GET/status check; it does not use a QA model, inspect
// response bodies, follow redirects, or discover endpoints.

class NotTestableError extends Error {}
class NotProvenError extends Error {}

function result(status, observedBehavior = null, artifactIds = [], reason = null) {
  return { status, observedBehavior, artifactIds, reason };
}

function errorResult(error) {
  const reason = error instanceof Error ? error.message : String(error);
  return error instanceof NotTestableError
    ? result("not_testable", null, [], reason)
    : result("not_proven", null, [], reason);
}

function exactPreviewOrigin(previewUrl) {
  let preview;
  try {
    preview = new URL(String(previewUrl));
  } catch {
    throw new NotTestableError("No safe exact PR-head preview URL is available");
  }

  if ((preview.protocol !== "https:" && preview.protocol !== "http:") || preview.username || preview.password) {
    throw new NotTestableError("Exact PR-head preview URL is unsafe");
  }

  return preview.origin;
}

function safeRequestUrl(path, origin) {
  const value = String(path ?? "").trim();
  if (
    !value ||
    value.length > 2_048 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    /[\u0000-\u001f]/.test(value)
  ) {
    throw new NotTestableError("Planned API request path is not a safe same-origin relative path");
  }

  const segments = value.split("/").slice(1);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new NotTestableError("Planned API request path is not a safe same-origin relative path");
  }

  let url;
  try {
    url = new URL(value, origin);
  } catch {
    throw new NotTestableError("Planned API request path is invalid");
  }

  if (url.origin !== origin || url.search || url.hash) {
    throw new NotTestableError("Planned API request leaves the exact PR-head preview origin");
  }

  return url;
}

function planFor(item) {
  const plan = item?.plan ?? item;

  if (plan?.modality !== "api") {
    throw new NotTestableError("Direct API executor accepts planned API criteria only");
  }

  const executionId = String(item?.execution?.id ?? item?.executionId ?? "").trim();
  const workspaceId = String(item?.workspaceId ?? "").trim();
  const recordId = String(plan.recordId ?? "").trim();
  const prRevisionId = String(plan.prRevisionId ?? "").trim();
  const criterionId = String(plan.criterionId ?? "").trim();
  const verificationPlanId = String(item?.execution?.verificationPlanId ?? item?.verificationPlanId ?? "").trim();

  if (!executionId || !workspaceId || !recordId || !prRevisionId || !criterionId || !verificationPlanId) {
    throw new NotTestableError("Claimed API execution has incomplete plan identity");
  }

  for (const [key, expected] of [
    ["recordId", recordId],
    ["prRevisionId", prRevisionId],
    ["verificationPlanId", verificationPlanId],
  ]) {
    const supplied = String(item?.[key] ?? "").trim();
    if (supplied && supplied !== expected) {
      throw new NotTestableError(`Claimed API execution has conflicting ${key}`);
    }
  }

  if (!String(plan.expectedBehavior ?? "").trim()) {
    throw new NotTestableError("Planned API criterion has no expected behavior");
  }

  const request = plan.apiRequest;
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).length !== 3 ||
    request.method !== "GET" ||
    !Number.isInteger(request.expectedStatus) ||
    request.expectedStatus < 100 ||
    request.expectedStatus > 599
  ) {
    throw new NotTestableError("Planned API criterion has no safe immutable GET request descriptor");
  }

  return { executionId, workspaceId, recordId, prRevisionId, criterionId, verificationPlanId, request };
}

/** Execute only a persisted API descriptor through injected fetch/upload seams. */
export function createVerificationApiExecutor({ fetchImpl, uploadArtifact, timeoutMs = 8_000 }) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  if (typeof uploadArtifact !== "function") throw new TypeError("uploadArtifact is required");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new TypeError("timeoutMs must be an integer between 1 and 30000");
  }

  return async function execute(item) {
    let timeout;

    try {
      const { executionId, workspaceId, recordId, prRevisionId, criterionId, verificationPlanId, request } =
        planFor(item);
      const url = safeRequestUrl(request.path, exactPreviewOrigin(item?.previewUrl ?? item?.plan?.previewUrl));
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), timeoutMs);

      let response;
      try {
        response = await fetchImpl(url.toString(), {
          method: "GET",
          credentials: "omit",
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        throw new NotProvenError("Planned exact-preview API request could not be completed");
      }

      if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599 || response.redirected) {
        throw new NotProvenError("Planned exact-preview API request returned an unsafe response");
      }

      if (response.status !== request.expectedStatus) {
        throw new NotProvenError(`Expected API status ${request.expectedStatus} but observed ${response.status}`);
      }

      const uploaded = await uploadArtifact({
        workspaceId,
        recordId,
        prRevisionId,
        verificationPlanId,
        collectedBy: `verification-executor:${executionId}`,
        index: 1,
        evidence: {
          request: { method: "GET", url: url.toString() },
          response: { status: response.status },
          assertions: [`criterion ${criterionId}: expected status ${request.expectedStatus}; observed status ${response.status}`],
        },
      });

      if (!uploaded || typeof uploaded.artifactId !== "string" || !uploaded.artifactId.trim()) {
        throw new NotProvenError("Criterion API evidence could not be stored as plan-bound evidence");
      }

      return result(
        "proven",
        `Observed exact planned GET ${url.pathname} status ${response.status}`,
        [uploaded.artifactId],
        null,
      );
    } catch (error) {
      return errorResult(error);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
}
