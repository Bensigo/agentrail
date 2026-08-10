// One server-reserved preview-local POST job trigger followed by an immediate,
// bounded JSON scalar readback. No response bytes or HMAC keys escape.
import { createHmac } from "node:crypto";
import { resolveDataHmacKeyring } from "./review_data_executor.core.mjs";

const MAX_TEXT = 2_000;
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
class NotTestableError extends Error {}
class NotProvenError extends Error {}
const degraded = (state) => ({ ok: false, degraded: true, state });
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}
function boundedText(value) {
  if (
    typeof value !== "string" ||
    value.length > MAX_TEXT ||
    /[\x00-\x1f\x7f]/u.test(value)
  )
    return null;
  const text = value.trim();
  return text || null;
}
function scalar(value) {
  return (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" &&
      value.length <= MAX_TEXT &&
      !/[\x00-\x1f\x7f]/u.test(value))
  );
}
function scalarType(value) {
  return value === null ? "null" : typeof value;
}
function scalarHmac({ key, context, pointer, value }) {
  return createHmac("sha256", key)
    .update(
      JSON.stringify([
        "agentrail.review-job.scalar.v1",
        context,
        pointer,
        scalarType(value),
        value,
      ]),
    )
    .digest("hex");
}
function strictRelativePath(value) {
  const path = boundedText(value);
  if (
    !path ||
    path !== value ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("%") ||
    /[?#]/u.test(path)
  )
    throw new NotTestableError();
  for (const segment of path.split("/")) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new NotTestableError();
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      /[\x00-\x1f\x7f?#\\/]/u.test(decoded)
    )
      throw new NotTestableError();
  }
  return path;
}
function pointer(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.length > 512 ||
    /[\x00-\x1f\x7f]/u.test(value) ||
    !value
      .slice(1)
      .split("/")
      .every(
        (part) =>
          !/~(?![01])/u.test(part) &&
          !/(?:token|password|passwd|passcode|secret|api[_-]?key|authorization|cookie|credential|private[_-]?key|client[_-]?secret|pin|otp|ssn|social[-_ ]?security|tax[-_ ]?id|card|credit|cvv|cvc|pan|email|phone|mobile|address|birth|dob)/iu.test(
            part.replace(/~1/g, "/").replace(/~0/g, "~"),
          ),
      )
  )
    throw new NotTestableError();
  return value;
}
function previewOrigin(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new NotTestableError();
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new NotTestableError();
  return url.origin;
}
function requestUrl(path, origin) {
  let url;
  try {
    url = new URL(path, origin);
  } catch {
    throw new NotTestableError();
  }
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new NotTestableError();
  return url.toString();
}
function pairedJobPaths(triggerPath, readbackPath) {
  const trigger = triggerPath.match(
    /^\/__agentrail\/verification\/jobs\/([A-Za-z0-9._-]{1,64})\/trigger$/u,
  );
  const readback = readbackPath.match(
    /^\/__agentrail\/verification\/jobs\/([A-Za-z0-9._-]{1,64})\/result$/u,
  );
  if (!trigger || !readback || trigger[1] !== readback[1])
    throw new NotTestableError();
}
function storedReadback(value, keyring) {
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
    !Number.isInteger(value.expectedStatus) ||
    value.expectedStatus < 200 ||
    value.expectedStatus > 299 ||
    value.digestAlgorithm !== "hmac-sha256-v1" ||
    typeof value.digestKeyId !== "string" ||
    !/^[A-Za-z0-9._-]{1,64}$/u.test(value.digestKeyId) ||
    typeof value.digestContext !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.digestContext) ||
    !keyring?.keys?.has(value.digestKeyId) ||
    !Array.isArray(value.expectedJson) ||
    value.expectedJson.length < 1 ||
    value.expectedJson.length > 12
  )
    throw new NotTestableError();
  const seen = new Set();
  const expectedJson = value.expectedJson.map((item) => {
    if (
      !object(item) ||
      !exactKeys(item, ["pointer", "equalsType", "equalsHmacSha256"])
    )
      throw new NotTestableError();
    const itemPointer = pointer(item.pointer);
    if (
      seen.has(itemPointer) ||
      !["null", "boolean", "number", "string"].includes(item.equalsType) ||
      typeof item.equalsHmacSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.equalsHmacSha256)
    )
      throw new NotTestableError();
    seen.add(itemPointer);
    return {
      pointer: itemPointer,
      equalsType: item.equalsType,
      equalsHmacSha256: item.equalsHmacSha256,
    };
  });
  return {
    path: strictRelativePath(value.path),
    expectedStatus: value.expectedStatus,
    digestContext: value.digestContext,
    digestKey: keyring.keys.get(value.digestKeyId),
    expectedJson,
  };
}
function validateContext(raw, keyring) {
  if (
    !object(raw) ||
    !exactKeys(raw, [
      "executionId",
      "jobId",
      "criterionId",
      "expected",
      "previewBootId",
      "previewUrl",
      "jobRequest",
    ]) ||
    !object(raw.jobRequest) ||
    !exactKeys(raw.jobRequest, ["trigger", "readback"]) ||
    !object(raw.jobRequest.trigger) ||
    !exactKeys(raw.jobRequest.trigger, ["method", "path", "expectedStatus"])
  )
    throw new NotTestableError();
  const executionId = boundedText(raw.executionId),
    jobId = boundedText(raw.jobId),
    criterionId = boundedText(raw.criterionId),
    expected = boundedText(raw.expected),
    previewBootId = boundedText(raw.previewBootId),
    previewUrl = boundedText(raw.previewUrl),
    trigger = raw.jobRequest.trigger;
  if (
    !executionId ||
    !jobId ||
    !criterionId ||
    !expected ||
    !previewBootId ||
    !previewUrl ||
    trigger.method !== "POST" ||
    !Number.isInteger(trigger.expectedStatus) ||
    trigger.expectedStatus < 200 ||
    trigger.expectedStatus > 299
  )
    throw new NotTestableError();
  const triggerPath = strictRelativePath(trigger.path),
    readback = storedReadback(raw.jobRequest.readback, keyring);
  pairedJobPaths(triggerPath, readback.path);
  return {
    executionId,
    jobId,
    criterionId,
    expected,
    previewBootId,
    previewUrl,
    triggerPath,
    triggerStatus: trigger.expectedStatus,
    readback,
  };
}
function resolvePointer(value, rawPointer) {
  let current = value;
  for (const raw of rawPointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (
        !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
        !Number.isSafeInteger(Number(key)) ||
        Number(key) >= current.length
      )
        return { found: false };
      current = current[Number(key)];
    } else if (
      object(current) &&
      Object.prototype.hasOwnProperty.call(current, key)
    )
      current = current[key];
    else return { found: false };
  }
  return scalar(current) ? { found: true, value: current } : { found: false };
}
function header(response, name) {
  try {
    return response?.headers?.get?.(name) ?? null;
  } catch {
    return null;
  }
}
async function readBoundedJson(response) {
  const contentType = header(response, "content-type");
  const declared = header(response, "content-length");
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;|\s*$)/iu.test(contentType) ||
    (declared !== null &&
      (!/^[0-9]+$/u.test(declared.trim()) || Number(declared) > MAX_BODY_BYTES))
  )
    throw new NotProvenError();
  const reader = response?.body?.getReader?.();
  if (!reader || typeof reader.read !== "function") throw new NotProvenError();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (!part || typeof part.done !== "boolean") throw new NotProvenError();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw new NotProvenError();
      total += part.value.byteLength;
      if (total > MAX_BODY_BYTES) throw new NotProvenError();
      chunks.push(part.value);
    }
  } catch (error) {
    try {
      await reader.cancel?.();
    } catch {}
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new NotProvenError();
  }
}
function stableObserved(context) {
  if (context.observedTriggerStatus !== context.triggerStatus)
    return `The safe job trigger ${context.triggerPath} returned HTTP ${context.observedTriggerStatus}; the planned status was ${context.triggerStatus}.`;
  if (context.observedReadbackStatus !== context.readback.expectedStatus)
    return `The safe job readback ${context.readback.path} returned HTTP ${context.observedReadbackStatus}; the planned status was ${context.readback.expectedStatus}.`;
  const failures = context.observations.filter(
    (item, index) =>
      !item.found ||
      item.observedType !== context.readback.expectedJson[index].equalsType ||
      item.observedHmacSha256 !==
        context.readback.expectedJson[index].equalsHmacSha256,
  ).length;
  return failures === 0
    ? `The safe job trigger and readback returned planned HTTP statuses; all ${context.readback.expectedJson.length} planned JSON scalar assertions matched.`
    : `The safe job readback ${context.readback.path} returned HTTP ${context.observedReadbackStatus}; ${failures} of ${context.readback.expectedJson.length} planned JSON scalar assertions did not match.`;
}
function validReceipt(value, context) {
  const exact =
    object(value) &&
    exactKeys(value, [
      "ok",
      "state",
      "expected",
      "observed",
      "observedTriggerStatus",
      "observedReadbackStatus",
      "assertionCount",
      "evidenceRef",
      "evidenceKey",
      "evidenceUrl",
    ]);
  const observationsMatch =
    context.observedReadbackStatus === context.readback.expectedStatus &&
    context.observations.length === context.readback.expectedJson.length &&
    context.observations.every((item, index) => {
      const resolved = resolvePointer(context.json, item.pointer);
      return (
        item.pointer === context.readback.expectedJson[index].pointer &&
        item.found === resolved.found &&
        (!item.found ||
          (item.observedType === scalarType(resolved.value) &&
            item.observedHmacSha256 ===
              scalarHmac({
                key: context.readback.digestKey,
                context: context.readback.digestContext,
                pointer: item.pointer,
                value: resolved.value,
              })))
      );
    });
  if (
    context.observedTriggerStatus === context.triggerStatus &&
    context.observedReadbackStatus === context.readback.expectedStatus &&
    !observationsMatch
  )
    return false;
  const expectedState =
    context.observedTriggerStatus === context.triggerStatus &&
    context.observedReadbackStatus === context.readback.expectedStatus &&
    context.observations.every(
      (item, index) =>
        item.found &&
        item.observedType === context.readback.expectedJson[index].equalsType &&
        item.observedHmacSha256 ===
          context.readback.expectedJson[index].equalsHmacSha256,
    )
      ? "proven"
      : "not_proven";
  if (
    !exact ||
    value.ok !== true ||
    value.state !== expectedState ||
    value.expected !== context.expected ||
    value.observed !== stableObserved(context) ||
    value.observedTriggerStatus !== context.observedTriggerStatus ||
    value.observedReadbackStatus !== context.observedReadbackStatus ||
    value.assertionCount !== context.readback.expectedJson.length ||
    value.evidenceRef !== `review-job-execution:${context.executionId}` ||
    !boundedText(value.evidenceKey)
  )
    return false;
  try {
    const url = new URL(String(value.evidenceUrl));
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
export { resolveDataHmacKeyring as resolveJobHmacKeyring };
export function createReviewJobExecutor({
  fetchPreview,
  completeExecution,
  keyring,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (typeof fetchPreview !== "function")
    throw new TypeError("fetchPreview is required");
  if (typeof completeExecution !== "function")
    throw new TypeError("completeExecution is required");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new TypeError("timeoutMs must be an integer between 1 and 30000");
  return async function execute(rawContext) {
    try {
      const context = validateContext(rawContext, keyring),
        origin = previewOrigin(context.previewUrl),
        triggerUrl = requestUrl(context.triggerPath, origin),
        readbackUrl = requestUrl(context.readback.path, origin);
      const controller = new AbortController();
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new NotProvenError());
        }, timeoutMs);
      });
      try {
        let trigger;
        try {
          trigger = await Promise.race([
            fetchPreview(triggerUrl, {
              method: "POST",
              redirect: "error",
              credentials: "omit",
              signal: controller.signal,
            }),
            deadline,
          ]);
        } catch {
          throw new NotProvenError();
        }
        const observedTriggerStatus = Number(trigger?.status);
        if (
          trigger?.redirected === true ||
          !Number.isInteger(observedTriggerStatus) ||
          observedTriggerStatus < 100 ||
          observedTriggerStatus > 599
        )
          throw new NotProvenError();
        if (observedTriggerStatus !== context.triggerStatus) {
          const receipt = await completeExecution({
            executionId: context.executionId,
            jobId: context.jobId,
            criterionId: context.criterionId,
            previewBootId: context.previewBootId,
            observedTriggerStatus,
            observedReadbackStatus: null,
            observations: [],
          });
          return validReceipt(receipt, {
            ...context,
            observedTriggerStatus,
            observedReadbackStatus: null,
            observations: [],
          })
            ? receipt
            : degraded("not_proven");
        }
        let readback;
        try {
          readback = await Promise.race([
            fetchPreview(readbackUrl, {
              method: "GET",
              redirect: "error",
              credentials: "omit",
              signal: controller.signal,
            }),
            deadline,
          ]);
        } catch {
          throw new NotProvenError();
        }
        const observedReadbackStatus = Number(readback?.status);
        if (
          readback?.redirected === true ||
          !Number.isInteger(observedReadbackStatus) ||
          observedReadbackStatus < 100 ||
          observedReadbackStatus > 599
        )
          throw new NotProvenError();
        let observations = [],
          json = null;
        if (observedReadbackStatus === context.readback.expectedStatus) {
          json = await Promise.race([readBoundedJson(readback), deadline]);
          observations = context.readback.expectedJson.map(({ pointer }) => {
            const resolved = resolvePointer(json, pointer);
            return resolved.found
              ? {
                  pointer,
                  found: true,
                  observedType: scalarType(resolved.value),
                  observedHmacSha256: scalarHmac({
                    key: context.readback.digestKey,
                    context: context.readback.digestContext,
                    pointer,
                    value: resolved.value,
                  }),
                }
              : { pointer, found: false };
          });
        }
        const receipt = await completeExecution({
          executionId: context.executionId,
          jobId: context.jobId,
          criterionId: context.criterionId,
          previewBootId: context.previewBootId,
          observedTriggerStatus,
          observedReadbackStatus,
          observations,
        });
        return validReceipt(receipt, {
          ...context,
          observedTriggerStatus,
          observedReadbackStatus,
          observations,
          json,
        })
          ? receipt
          : degraded("not_proven");
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      return degraded(
        error instanceof NotTestableError ? "not_testable" : "not_proven",
      );
    }
  };
}
