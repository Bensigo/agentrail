// Deterministic, read-only data verification. A plan may perform one exact-preview
// GET and compare only bounded scalar JSON-pointer assertions.
import { createVerificationApiExecutor } from "./verification_api_executor.core.mjs";

function pointerValue(value, pointer) {
  let current = value;
  for (const token of pointer.slice(1).split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || typeof current !== "object" || Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/** Execute a bounded data readback using the existing exact-origin GET discipline. */
export function createVerificationDataExecutor({ fetchImpl, uploadArtifact, timeoutMs } = {}) {
  return async (item) => {
    const plan = item?.plan ?? item;
    if (plan?.modality !== "data" || !plan?.dataRequest) return { status: "not_testable", observedBehavior: null, artifactIds: [], reason: "Direct data executor accepts planned data criteria only" };
    const request = plan.dataRequest;
    const proxy = { ...item, plan: { ...plan, modality: "api", apiRequest: { method: request.method, path: request.path, expectedStatus: request.expectedStatus } } };
    let captured;
    const wrappedFetch = async (url, init) => {
      const response = await fetchImpl(url, init);
      if (!response || typeof response.json !== "function") return response;
      try { captured = await response.json(); } catch { return response; }
      return { status: response.status, redirected: response.redirected, json: async () => captured };
    };
    const validate = await createVerificationApiExecutor({
      fetchImpl: wrappedFetch,
      timeoutMs,
      uploadArtifact: async (input) => {
        for (const assertion of request.expectedJson ?? []) {
          if (pointerValue(captured, assertion.pointer) !== assertion.equals) return null;
        }
        return uploadArtifact({ ...input, evidence: { ...input.evidence, assertions: (request.expectedJson ?? []).map((a) => `JSON ${a.pointer} equals declared scalar`) } });
      },
    })(proxy);
    return validate;
  };
}
