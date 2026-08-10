// Deterministic, bounded JSON scalar readback for a server-resolved data plan.
// Raw response bytes never leave this module: it reports only declared scalar
// observations in their immutable plan order.

import { createHmac } from "node:crypto";

const MAX_TEXT = 2_000;
const MAX_BODY_BYTES = 64 * 1024;
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
      !/[\x00-\x1f\x7f]/.test(value))
  );
}
function scalarType(value) {
  return value === null ? "null" : typeof value;
}
function scalarHmac({ key, context, pointer: scalarPointer, value }) {
  return createHmac("sha256", key)
    .update(JSON.stringify(["agentrail.review-data.scalar.v1", context, scalarPointer, scalarType(value), value]))
    .digest("hex");
}

export function resolveDataHmacKeyring(env = {}) {
  const activeKeyId = String(env.REVIEW_DATA_HMAC_ACTIVE_KEY_ID ?? "").trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(activeKeyId)) return null;
  let raw;
  try { raw = JSON.parse(String(env.REVIEW_DATA_HMAC_KEYS_JSON ?? "")); } catch { return null; }
  if (!object(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null;
  if (Object.keys(raw).length < 1 || Object.keys(raw).length > 16) return null;
  const keys = new Map();
  for (const [keyId, encoded] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/u.test(keyId) || typeof encoded !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(encoded)) return null;
    const key = Buffer.from(encoded, "base64url");
    if (key.length !== 32 || key.toString("base64url") !== encoded) return null;
    keys.set(keyId, key);
  }
  return keys.has(activeKeyId) ? { activeKeyId, keys } : null;
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
    if (
      segment === "." ||
      segment === ".." ||
      /[\u0000-\u001f\u007f?#\\/]/u.test(segment)
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
    /[\x00-\x1f\x7f]/.test(value) ||
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
      "dataRequest",
    ]) ||
    !object(raw.dataRequest) ||
    !exactKeys(raw.dataRequest, [
      "method",
      "path",
      "expectedStatus",
      "expectedJson",
      "digestAlgorithm",
      "digestKeyId",
      "digestContext",
    ])
  )
    throw new NotTestableError();
  const executionId = boundedText(raw.executionId);
  const jobId = boundedText(raw.jobId);
  const criterionId = boundedText(raw.criterionId);
  const expected = boundedText(raw.expected);
  const previewBootId = boundedText(raw.previewBootId);
  const previewUrl = boundedText(raw.previewUrl);
  const request = raw.dataRequest;
  if (
    !executionId ||
    !jobId ||
    !criterionId ||
    !expected ||
    !previewBootId ||
    !previewUrl ||
    request.method !== "GET" ||
    !Number.isInteger(request.expectedStatus) ||
    request.expectedStatus < 100 ||
    request.expectedStatus > 599 ||
    request.digestAlgorithm !== "hmac-sha256-v1" ||
    typeof request.digestKeyId !== "string" ||
    !/^[A-Za-z0-9._-]{1,64}$/u.test(request.digestKeyId) ||
    typeof request.digestContext !== "string" ||
    !/^[a-f0-9]{64}$/u.test(request.digestContext) ||
    !keyring?.keys?.has(request.digestKeyId) ||
    !Array.isArray(request.expectedJson) ||
    request.expectedJson.length < 1 ||
    request.expectedJson.length > 12
  )
    throw new NotTestableError();
  const seen = new Set();
  const expectedJson = request.expectedJson.map((entry) => {
    if (!object(entry) || !exactKeys(entry, ["pointer", "equalsType", "equalsHmacSha256"]))
      throw new NotTestableError();
    const key = pointer(entry.pointer);
    if (
      seen.has(key) ||
      !["null", "boolean", "number", "string"].includes(entry.equalsType) ||
      typeof entry.equalsHmacSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.equalsHmacSha256)
    ) throw new NotTestableError();
    seen.add(key);
    return { pointer: key, equalsType: entry.equalsType, equalsHmacSha256: entry.equalsHmacSha256 };
  });
  return {
    executionId,
    jobId,
    criterionId,
    expected,
    previewBootId,
    previewUrl,
    path: strictRelativePath(request.path),
    expectedStatus: request.expectedStatus,
    digestContext: request.digestContext,
    digestKey: keyring.keys.get(request.digestKeyId),
    expectedJson,
  };
}
function resolvePointer(value, rawPointer) {
  let current = value;
  for (const raw of rawPointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (
        !/^(?:0|[1-9][0-9]*)$/.test(key) ||
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
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;|\s*$)/iu.test(contentType)
  )
    throw new NotProvenError();
  const declared = header(response, "content-length");
  if (
    declared !== null &&
    (!/^[0-9]+$/.test(declared.trim()) || Number(declared) > MAX_BODY_BYTES)
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
function stableObserved(context, observations) {
  if (context.observedStatus !== context.expectedStatus)
    return `The safe data GET ${context.path} returned HTTP ${context.observedStatus}; the planned status was ${context.expectedStatus}.`;
  const failures = observations.filter(
    (item, index) =>
      !item.found ||
      item.observedType !== context.expectedJson[index].equalsType ||
      item.observedHmacSha256 !== context.expectedJson[index].equalsHmacSha256,
  ).length;
  return failures === 0
    ? `The safe data GET ${context.path} returned HTTP ${context.expectedStatus}; all ${context.expectedJson.length} planned JSON scalar assertions matched.`
    : `The safe data GET ${context.path} returned HTTP ${context.expectedStatus}; ${failures} of ${context.expectedJson.length} planned JSON scalar assertions did not match.`;
}
function validReceipt(value, context) {
  const matches = context.observations.every(
    (item, index) =>
      item.pointer === context.expectedJson[index].pointer &&
      item.found === resolvePointer(context.json, item.pointer).found &&
      (!item.found ||
        (item.observedType === scalarType(resolvePointer(context.json, item.pointer).value) &&
          item.observedHmacSha256 === scalarHmac({ key: context.digestKey, context: context.digestContext, pointer: item.pointer, value: resolvePointer(context.json, item.pointer).value }))),
  );
  const passed =
    context.observedStatus === context.expectedStatus &&
    matches &&
    context.observations.every(
      (item, index) =>
        item.found &&
        item.observedType === context.expectedJson[index].equalsType &&
        item.observedHmacSha256 === context.expectedJson[index].equalsHmacSha256,
    );
  return (
    object(value) &&
    exactKeys(value, [
      "ok",
      "state",
      "expected",
      "observed",
      "observedStatus",
      "assertionCount",
      "evidenceRef",
      "evidenceKey",
      "evidenceUrl",
    ]) &&
    value.ok === true &&
    value.state === (passed ? "proven" : "failed") &&
    value.expected === context.expected &&
    value.observed === stableObserved(context, context.observations) &&
    value.observedStatus === context.observedStatus &&
    value.assertionCount === context.expectedJson.length &&
    value.evidenceRef === `review-data-execution:${context.executionId}` &&
    !!boundedText(value.evidenceKey) &&
    (() => {
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
    })()
  );
}

export function createReviewDataExecutor({
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
      const context = validateContext(rawContext, keyring);
      const origin = previewOrigin(context.previewUrl);
      const url = requestUrl(context.path, origin);
      const controller = new AbortController();
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new NotProvenError());
        }, timeoutMs);
      });
      let response;
      try {
        response = await Promise.race([
          fetchPreview(url, {
            method: "GET",
            redirect: "error",
            credentials: "omit",
            signal: controller.signal,
          }),
          deadline,
        ]);
        if (
          response?.redirected === true ||
          !Number.isInteger(Number(response?.status)) ||
          Number(response.status) < 100 ||
          Number(response.status) > 599
        )
          throw new NotProvenError();
        const observedStatus = Number(response.status);
        let observed = [];
        if (observedStatus === context.expectedStatus) {
          const json = await Promise.race([
            readBoundedJson(response),
            deadline,
          ]);
          observed = context.expectedJson.map(({ pointer: itemPointer }) => {
            const resolved = resolvePointer(json, itemPointer);
            return resolved.found
              ? { pointer: itemPointer, found: true, observedType: scalarType(resolved.value), observedHmacSha256: scalarHmac({ key: context.digestKey, context: context.digestContext, pointer: itemPointer, value: resolved.value }) }
              : { pointer: itemPointer, found: false };
          });
          const receipt = await completeExecution({
            executionId: context.executionId,
            jobId: context.jobId,
            criterionId: context.criterionId,
            previewBootId: context.previewBootId,
            observedStatus,
            observations: observed,
          });
          return validReceipt(receipt, {
            ...context,
            observedStatus,
            observations: observed,
            json,
          })
            ? receipt
            : degraded("not_proven");
        }
        const receipt = await completeExecution({
          executionId: context.executionId,
          jobId: context.jobId,
          criterionId: context.criterionId,
          previewBootId: context.previewBootId,
          observedStatus,
          observations: observed,
        });
        return validReceipt(receipt, {
          ...context,
          observedStatus,
          observations: observed,
          json: null,
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
