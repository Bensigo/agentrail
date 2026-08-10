import { createHash, createHmac } from "node:crypto";
import { scanForSecrets } from "./secret-scan";

export const REVIEW_JOB_VERIFICATION_PLAN_KIND = "review_job_verification_plan";
export const REVIEW_JOB_VERIFICATION_PLAN_STAGE = "verification";
export const REVIEW_JOB_VERIFICATION_PLAN_ACTOR = "jace:review-verification-planner";

export type VerificationModality = "ui" | "api" | "job" | "data";
export type VerificationPlanStatus = "planned" | "not_testable";

export type UiVerificationStep =
  | { action: "open"; path: string }
  | { action: "click"; selector: string }
  | { action: "fill"; selector: string; value: string }
  | { action: "press"; key: string }
  | { action: "expect_text"; text: string }
  | { action: "screenshot"; label: string };

/** A bounded, same-preview status-only API assertion. */
export interface ApiVerificationRequest {
  method: "GET";
  path: string;
  expectedStatus: number;
}

export type DataScalar = string | number | boolean | null;
export type DataScalarKind = "null" | "boolean" | "number" | "string";
export interface SubmittedDataVerificationAssertion {
  pointer: string;
  equals: DataScalar;
}
export interface SubmittedDataVerificationRequest {
  method: "GET";
  path: string;
  expectedStatus: number;
  expectedJson: SubmittedDataVerificationAssertion[];
}
export interface DataVerificationAssertion {
  pointer: string;
  equalsType: DataScalarKind;
  equalsHmacSha256: string;
}
/** The persisted descriptor contains no raw expected response values. */
export interface DataVerificationRequest {
  method: "GET";
  path: string;
  expectedStatus: number;
  digestAlgorithm: "hmac-sha256-v1";
  digestKeyId: string;
  digestContext: string;
  expectedJson: DataVerificationAssertion[];
}

export interface SubmittedJobVerificationRequest {
  trigger: { method: "POST"; path: string; expectedStatus: number };
  readback: SubmittedDataVerificationRequest;
}
/** The persisted job descriptor has no raw expected scalar values. */
export interface JobVerificationRequest {
  trigger: { method: "POST"; path: string; expectedStatus: number };
  readback: DataVerificationRequest;
}

export interface ReviewDataDigestBinding {
  workspaceId: string;
  recordId: string;
  jobId: string;
  headSha: string;
  contractId: string;
  contractVersion: number;
  criterionId: string;
}

export interface ReviewDataHmacKey {
  keyId: string;
  key: Buffer;
}

export interface ConfirmedVerificationCriterion {
  id: string;
  text: string;
  userVisible: boolean;
}

export interface ConfirmedVerificationContract {
  id: string;
  version: number;
  criteria: ConfirmedVerificationCriterion[];
}

export interface ReviewJobVerificationIdentity {
  id: string;
  workspaceId: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

export interface StoredCriterionVerificationPlan {
  criterionId: string;
  criterionTextSnapshot: string;
  modality: VerificationModality;
  environmentKind: "isolated_preview" | null;
  flow: string | null;
  uiSteps: UiVerificationStep[] | null;
  apiRequest: ApiVerificationRequest | null;
  dataRequest: DataVerificationRequest | null;
  jobRequest?: JobVerificationRequest | null;
  status: VerificationPlanStatus;
  notTestableReason: string | null;
}

export interface StoredReviewJobVerificationPlan extends Record<string, unknown> {
  kind: typeof REVIEW_JOB_VERIFICATION_PLAN_KIND;
  jobId: string;
  workspaceId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  recordId: string;
  acceptanceContractId: string;
  acceptanceContractVersion: number;
  plannedBy: string;
  plans: StoredCriterionVerificationPlan[];
}

type BuildPlanResult =
  | { ok: true; value: StoredReviewJobVerificationPlan }
  | { ok: false; error: string };

const MODALITIES = new Set<VerificationModality>(["ui", "api", "job", "data"]);
const MAX_PLAN_TEXT = 2_000;
const MAX_UI_STEPS = 12;
const PRESS_KEYS = new Set([
  "Enter", "Tab", "Escape", "Space", "Backspace",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
]);

function object(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function nonBlankText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function boundedPlanText(value: unknown): string | null {
  const normalized = nonBlankText(value);
  return normalized && normalized.length <= MAX_PLAN_TEXT && !/[\x00-\x1f\x7f]/.test(normalized)
    ? normalized
    : null;
}

function boundedUiText(value: unknown, allowEmpty = false): string | null {
  if (typeof value !== "string" || value.length > MAX_PLAN_TEXT || /[\x00-\x1f\x7f]/.test(value)) {
    return null;
  }
  const normalized = value.trim();
  if (!allowEmpty && !normalized) return null;
  return normalized;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

/**
 * Parse the one bounded browser flow the UI executor can run for a criterion.
 * The final assertion and screenshot make the decisive proof point explicit.
 */
export function parseUiVerificationSteps(value: unknown): UiVerificationStep[] | null {
  if (!Array.isArray(value) || value.length < 3 || value.length > MAX_UI_STEPS) return null;

  const steps: UiVerificationStep[] = [];
  for (const raw of value) {
    if (!object(raw) || typeof raw.action !== "string") return null;
    switch (raw.action) {
      case "open": {
        if (!exactKeys(raw, ["action", "path"]) || typeof raw.path !== "string") return null;
        const path = boundedUiText(raw.path);
        if (!path || path !== raw.path || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
        steps.push({ action: "open", path });
        break;
      }
      case "click": {
        if (!exactKeys(raw, ["action", "selector"])) return null;
        const selector = boundedUiText(raw.selector);
        if (!selector) return null;
        steps.push({ action: "click", selector });
        break;
      }
      case "fill": {
        if (!exactKeys(raw, ["action", "selector", "value"])) return null;
        const selector = boundedUiText(raw.selector);
        const fillValue = boundedUiText(raw.value, true);
        if (!selector || fillValue === null) return null;
        steps.push({ action: "fill", selector, value: fillValue });
        break;
      }
      case "press": {
        if (!exactKeys(raw, ["action", "key"]) || !PRESS_KEYS.has(raw.key as string)) return null;
        steps.push({ action: "press", key: raw.key as string });
        break;
      }
      case "expect_text": {
        if (!exactKeys(raw, ["action", "text"])) return null;
        const text = boundedUiText(raw.text);
        if (!text) return null;
        steps.push({ action: "expect_text", text });
        break;
      }
      case "screenshot": {
        if (!exactKeys(raw, ["action", "label"])) return null;
        const label = boundedUiText(raw.label);
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
    steps[steps.length - 2].action !== "expect_text" ||
    steps[steps.length - 1].action !== "screenshot" ||
    steps.slice(1, -2).some((step) => !["click", "fill", "press"].includes(step.action))
  ) {
    return null;
  }
  return steps;
}

/**
 * Parse the one deliberately small status-only API request. The path is
 * carried separately from a preview origin, so it can never select a different
 * host or smuggle query/fragment routing into the immutable plan. Requests
 * needing headers, auth, a body, or mutation remain `not_testable`.
 */
export function parseApiVerificationRequest(value: unknown): ApiVerificationRequest | null {
  if (!object(value) || !exactKeys(value, ["method", "path", "expectedStatus"])) return null;
  if (value.method !== "GET" || typeof value.path !== "string") return null;
  const path = boundedUiText(value.path);
  if (
    !path ||
    path !== value.path ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("%") ||
    path.includes("?") ||
    path.includes("#") ||
    typeof value.expectedStatus !== "number" ||
    !Number.isInteger(value.expectedStatus) ||
    value.expectedStatus < 100 ||
    value.expectedStatus > 599
  ) {
    return null;
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (
    /[\x00-\x1f\x7f]/.test(decodedPath) ||
    decodedPath.startsWith("//") ||
    decodedPath.includes("\\") ||
    decodedPath.includes("?") ||
    decodedPath.includes("#") ||
    decodedPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return null;
  }

  return { method: "GET", path, expectedStatus: value.expectedStatus };
}

const MAX_DATA_ASSERTIONS = 12;
const MAX_POINTER = 512;
const MAX_REVIEW_DATA_HMAC_KEYS = 16;
export const REVIEW_DATA_DIGEST_ALGORITHM = "hmac-sha256-v1" as const;
const DATA_SCALAR_KINDS = new Set<DataScalarKind>([
  "null",
  "boolean",
  "number",
  "string",
]);
const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const REVIEW_DATA_HMAC_KEY_ID = /^[A-Za-z0-9._-]{1,64}$/u;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const SSN = /\b\d{3}-?\d{2}-?\d{4}\b/u;

export function dataScalarKind(value: DataScalar): DataScalarKind {
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  return "string";
}

export function reviewDataDigestContext(input: ReviewDataDigestBinding & {
  path: string;
  expectedStatus: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.workspaceId,
        input.recordId,
        input.jobId,
        input.headSha,
        input.contractId,
        input.contractVersion,
        input.criterionId,
        input.path,
        input.expectedStatus,
      ])
    )
    .digest("hex");
}

/** HMAC for one raw scalar; callers must discard the scalar immediately. */
export function reviewDataScalarHmac(input: {
  key: Uint8Array;
  context: string;
  pointer: string;
  value: DataScalar;
}): string {
  return createHmac("sha256", input.key)
    .update(
      JSON.stringify([
        "agentrail.review-data.scalar.v1",
        input.context,
        input.pointer,
        dataScalarKind(input.value),
        input.value,
      ])
    )
    .digest("hex");
}

/** Job and data use the same purpose-scoped key custody, but different HMAC domains. */
export function reviewJobScalarHmac(input: {
  key: Uint8Array;
  context: string;
  pointer: string;
  value: DataScalar;
}): string {
  return createHmac("sha256", input.key)
    .update(
      JSON.stringify([
        "agentrail.review-job.scalar.v1",
        input.context,
        input.pointer,
        dataScalarKind(input.value),
        input.value,
      ])
    )
    .digest("hex");
}

export function isReviewDataHmacKeyId(value: unknown): value is string {
  return typeof value === "string" && REVIEW_DATA_HMAC_KEY_ID.test(value);
}

export function parseReviewDataHmacKeyIds(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_REVIEW_DATA_HMAC_KEYS
  ) {
    return null;
  }
  const ids = new Set<string>();
  for (const keyId of value) {
    if (!isReviewDataHmacKeyId(keyId) || ids.has(keyId)) return null;
    ids.add(keyId);
  }
  const parsed = [...ids];
  const sorted = [...parsed].sort();
  return parsed.every((keyId, index) => keyId === sorted[index])
    ? parsed
    : null;
}

function reviewDataHmacKeyring(env: Record<string, string | undefined>): {
  activeKeyId: string;
  keys: Map<string, Buffer>;
} | null {
  const activeKeyId = env.REVIEW_DATA_HMAC_ACTIVE_KEY_ID;
  const encoded = env.REVIEW_DATA_HMAC_KEYS_JSON;
  if (!isReviewDataHmacKeyId(activeKeyId) || typeof encoded !== "string") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return null;
  }
  if (!object(parsed)) return null;
  const entries = Object.entries(parsed);
  if (entries.length < 1 || entries.length > MAX_REVIEW_DATA_HMAC_KEYS) {
    return null;
  }
  const keys = new Map<string, Buffer>();
  for (const [keyId, value] of entries) {
    if (
      !isReviewDataHmacKeyId(keyId) ||
      typeof value !== "string" ||
      value.includes("=")
    ) {
      return null;
    }
    const key = Buffer.from(value, "base64url");
    if (key.length !== 32 || key.toString("base64url") !== value) return null;
    keys.set(keyId, key);
  }
  return keys.has(activeKeyId) ? { activeKeyId, keys } : null;
}

export function activeReviewDataHmacKey(
  env: Record<string, string | undefined>,
): ReviewDataHmacKey | null {
  const keyring = reviewDataHmacKeyring(env);
  if (!keyring) return null;
  return {
    keyId: keyring.activeKeyId,
    key: keyring.keys.get(keyring.activeKeyId)!,
  };
}

export function reviewDataHmacKeyById(
  env: Record<string, string | undefined>,
  keyId: string,
): ReviewDataHmacKey | null {
  const keyring = reviewDataHmacKeyring(env);
  const key = keyring?.keys.get(keyId);
  return key ? { keyId, key } : null;
}

function piiShapedString(value: string): boolean {
  if (EMAIL.test(value) || SSN.test(value)) return true;
  const digits = value.replace(/\D/gu, "");
  return digits.length >= 10 && digits.length <= 19 && /^[+()\- .\d]+$/u.test(value);
}

function submittedDataScalar(value: unknown): value is DataScalar {
  return (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      (!Number.isInteger(value) || Math.abs(value) < 100_000_000)) ||
    (typeof value === "string" &&
      value.length <= MAX_PLAN_TEXT &&
      !/[\x00-\x1f\x7f]/.test(value) &&
      scanForSecrets(value).clean &&
      !piiShapedString(value))
  );
}

/** RFC6901 pointer with conservative credential and PII field denial. */
export function parseDataPointer(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.length > MAX_POINTER ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    return null;
  }
  const segments = value.slice(1).split("/");
  for (const segment of segments) {
    if (/(?:~(?![01]))/.test(segment)) return null;
    const decoded = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    const normalized = decoded.toLowerCase().replace(/[\s_-]/gu, "");
    if (
      /(?:token|password|passwd|passcode|secret|apikey|authorization|cookie|credential|privatekey|clientsecret|pin|otp|ssn|socialsecurity|taxid|card|credit|cvv|cvc|pan|email|phone|mobile|address|birth|dob)/u.test(
        normalized
      )
    ) {
      return null;
    }
    if (/^(?:0|[1-9][0-9]*)$/.test(decoded) && decoded !== segment) return null;
  }
  return value;
}

export function parseSubmittedDataVerificationRequest(
  value: unknown
): SubmittedDataVerificationRequest | null {
  if (
    !object(value) ||
    !exactKeys(value, ["method", "path", "expectedStatus", "expectedJson"])
  ) {
    return null;
  }
  const base = parseApiVerificationRequest({
    method: value.method,
    path: value.path,
    expectedStatus: value.expectedStatus,
  });
  if (
    !base ||
    !Array.isArray(value.expectedJson) ||
    value.expectedJson.length < 1 ||
    value.expectedJson.length > MAX_DATA_ASSERTIONS
  ) {
    return null;
  }
  const pointers = new Set<string>();
  const expectedJson: SubmittedDataVerificationAssertion[] = [];
  for (const assertion of value.expectedJson) {
    if (!object(assertion) || !exactKeys(assertion, ["pointer", "equals"])) return null;
    const pointer = parseDataPointer(assertion.pointer);
    if (
      !pointer ||
      pointers.has(pointer) ||
      !submittedDataScalar(assertion.equals)
    ) {
      return null;
    }
    pointers.add(pointer);
    expectedJson.push({ pointer, equals: assertion.equals });
  }
  return { ...base, expectedJson };
}

function exactReviewJobPath(
  value: unknown,
  id: string,
  suffix: "trigger" | "result"
): string | null {
  const path = typeof value === "string" ? value : null;
  const expected = `/__agentrail/verification/jobs/${id}/${suffix}`;
  return path === expected ? path : null;
}

function parseJobEndpoint<M extends "POST" | "GET">(
  value: unknown,
  method: M
): { method: M; path: string; expectedStatus: number } | null {
  if (
    !object(value) ||
    !exactKeys(value, ["method", "path", "expectedStatus"]) ||
    value.method !== method ||
    typeof value.path !== "string" ||
    !Number.isInteger(value.expectedStatus) ||
    (value.expectedStatus as number) < 200 ||
    (value.expectedStatus as number) > 299
  ) return null;
  return { method, path: value.path, expectedStatus: value.expectedStatus as number };
}

export function parseSubmittedJobVerificationRequest(
  value: unknown
): SubmittedJobVerificationRequest | null {
  if (!object(value) || !exactKeys(value, ["readback", "trigger"])) return null;
  const trigger = parseJobEndpoint(value.trigger, "POST");
  if (!trigger) return null;
  const prefix = "/__agentrail/verification/jobs/";
  if (!trigger.path.startsWith(prefix) || !trigger.path.endsWith("/trigger")) return null;
  const id = trigger.path.slice(prefix.length, -"/trigger".length);
  if (
    !/^[A-Za-z0-9._-]{1,64}$/u.test(id) ||
    !exactReviewJobPath(trigger.path, id, "trigger")
  ) return null;
  const rawReadback = value.readback;
  if (
    !object(rawReadback) ||
    !exactKeys(rawReadback, ["method", "path", "expectedStatus", "expectedJson"])
  ) return null;
  const endpoint = parseJobEndpoint({
    method: rawReadback.method,
    path: rawReadback.path,
    expectedStatus: rawReadback.expectedStatus,
  }, "GET");
  if (!endpoint || !exactReviewJobPath(endpoint.path, id, "result")) return null;
  const readback = parseSubmittedDataVerificationRequest(rawReadback);
  if (
    !readback ||
    readback.method !== "GET" ||
    readback.path !== endpoint.path ||
    readback.expectedStatus !== endpoint.expectedStatus
  ) return null;
  return { trigger, readback };
}

/** Validate raw model input and return the no-raw-value persisted descriptor. */
export function buildStoredDataVerificationRequest(input: {
  value: unknown;
  binding: ReviewDataDigestBinding;
  hmacKey: ReviewDataHmacKey;
}): DataVerificationRequest | null {
  const submitted = parseSubmittedDataVerificationRequest(input.value);
  if (
    !submitted ||
    !isReviewDataHmacKeyId(input.hmacKey.keyId) ||
    input.hmacKey.key.length !== 32
  ) {
    return null;
  }
  const digestContext = reviewDataDigestContext({
    ...input.binding,
    path: submitted.path,
    expectedStatus: submitted.expectedStatus,
  });
  return {
    method: submitted.method,
    path: submitted.path,
    expectedStatus: submitted.expectedStatus,
    digestAlgorithm: REVIEW_DATA_DIGEST_ALGORITHM,
    digestKeyId: input.hmacKey.keyId,
    digestContext,
    expectedJson: submitted.expectedJson.map(({ pointer, equals }) => ({
      pointer,
      equalsType: dataScalarKind(equals),
      equalsHmacSha256: reviewDataScalarHmac({
        key: input.hmacKey.key,
        context: digestContext,
        pointer,
        value: equals,
      }),
    })),
  };
}

export function reviewJobDigestContext(input: ReviewDataDigestBinding & {
  triggerPath: string;
  triggerExpectedStatus: number;
  readbackPath: string;
  readbackExpectedStatus: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.workspaceId,
        input.recordId,
        input.jobId,
        input.headSha,
        input.contractId,
        input.contractVersion,
        input.criterionId,
        input.triggerPath,
        input.triggerExpectedStatus,
        input.readbackPath,
        input.readbackExpectedStatus,
      ])
    )
    .digest("hex");
}

export function buildStoredJobVerificationRequest(input: {
  value: unknown;
  binding: ReviewDataDigestBinding;
  hmacKey: ReviewDataHmacKey;
}): JobVerificationRequest | null {
  const submitted = parseSubmittedJobVerificationRequest(input.value);
  if (
    !submitted ||
    !isReviewDataHmacKeyId(input.hmacKey.keyId) ||
    input.hmacKey.key.length !== 32
  ) return null;
  const digestContext = reviewJobDigestContext({
    ...input.binding,
    triggerPath: submitted.trigger.path,
    triggerExpectedStatus: submitted.trigger.expectedStatus,
    readbackPath: submitted.readback.path,
    readbackExpectedStatus: submitted.readback.expectedStatus,
  });
  return {
    trigger: submitted.trigger,
    readback: {
      method: "GET",
      path: submitted.readback.path,
      expectedStatus: submitted.readback.expectedStatus,
      digestAlgorithm: REVIEW_DATA_DIGEST_ALGORITHM,
      digestKeyId: input.hmacKey.keyId,
      digestContext,
      expectedJson: submitted.readback.expectedJson.map(({ pointer, equals }) => ({
        pointer,
        equalsType: dataScalarKind(equals),
        equalsHmacSha256: reviewJobScalarHmac({
          key: input.hmacKey.key,
          context: digestContext,
          pointer,
          value: equals,
        }),
      })),
    },
  };
}

export function parseStoredDataVerificationRequest(
  value: unknown
): DataVerificationRequest | null {
  if (
    !object(value) ||
    !exactKeys(value, [
      "method",
      "path",
      "expectedStatus",
      "digestAlgorithm",
      "digestKeyId",
      "digestContext",
      "expectedJson",
    ])
  ) {
    return null;
  }
  const base = parseApiVerificationRequest({
    method: value.method,
    path: value.path,
    expectedStatus: value.expectedStatus,
  });
  if (
    !base ||
    value.digestAlgorithm !== REVIEW_DATA_DIGEST_ALGORITHM ||
    !isReviewDataHmacKeyId(value.digestKeyId) ||
    typeof value.digestContext !== "string" ||
    !HEX_SHA256.test(value.digestContext) ||
    !Array.isArray(value.expectedJson) ||
    value.expectedJson.length < 1 ||
    value.expectedJson.length > MAX_DATA_ASSERTIONS
  ) {
    return null;
  }
  const pointers = new Set<string>();
  const expectedJson: DataVerificationAssertion[] = [];
  for (const assertion of value.expectedJson) {
    if (!object(assertion) || !exactKeys(assertion, ["pointer", "equalsType", "equalsHmacSha256"])) return null;
    const pointer = parseDataPointer(assertion.pointer);
    if (
      !pointer ||
      pointers.has(pointer) ||
      !DATA_SCALAR_KINDS.has(assertion.equalsType as DataScalarKind) ||
      !HEX_SHA256.test(String(assertion.equalsHmacSha256))
    ) {
      return null;
    }
    pointers.add(pointer);
    expectedJson.push({
      pointer,
      equalsType: assertion.equalsType as DataScalarKind,
      equalsHmacSha256: assertion.equalsHmacSha256 as string,
    });
  }
  return {
    ...base,
    digestAlgorithm: REVIEW_DATA_DIGEST_ALGORITHM,
    digestKeyId: value.digestKeyId,
    digestContext: value.digestContext,
    expectedJson,
  };
}

export function parseStoredJobVerificationRequest(
  value: unknown
): JobVerificationRequest | null {
  if (!object(value) || !exactKeys(value, ["readback", "trigger"])) return null;
  const trigger = parseJobEndpoint(value.trigger, "POST");
  if (!trigger) return null;
  const prefix = "/__agentrail/verification/jobs/";
  if (!trigger.path.startsWith(prefix) || !trigger.path.endsWith("/trigger")) return null;
  const id = trigger.path.slice(prefix.length, -"/trigger".length);
  if (
    !/^[A-Za-z0-9._-]{1,64}$/u.test(id) ||
    !exactReviewJobPath(trigger.path, id, "trigger")
  ) return null;
  if (!object(value.readback)) return null;
  const endpoint = parseJobEndpoint({
    method: value.readback.method,
    path: value.readback.path,
    expectedStatus: value.readback.expectedStatus,
  }, "GET");
  const readback = parseStoredDataVerificationRequest(value.readback);
  if (
    !endpoint ||
    !readback ||
    readback.path !== endpoint.path ||
    readback.expectedStatus !== endpoint.expectedStatus ||
    !exactReviewJobPath(readback.path, id, "result") ||
    readback.expectedStatus < 200 ||
    readback.expectedStatus > 299
  ) return null;
  return { trigger, readback };
}

/** Exactly one confirmed Contract is authoritative for a review job. */
export function confirmedVerificationContract(
  contracts: unknown
): ConfirmedVerificationContract | null {
  if (!Array.isArray(contracts)) return null;
  const confirmed = contracts.filter(
    (candidate) => object(candidate) && candidate.status === "confirmed"
  );
  if (confirmed.length !== 1) return null;

  const row = confirmed[0] as Record<string, unknown>;
  const id = nonBlankText(row.id);
  const version = row.version;
  const contract = object(row.contract) ? row.contract : null;
  const rawCriteria = contract?.acceptanceCriteria;
  if (!id || !Number.isInteger(version) || (version as number) <= 0 || !Array.isArray(rawCriteria) || rawCriteria.length === 0) {
    return null;
  }

  const ids = new Set<string>();
  const criteria: ConfirmedVerificationCriterion[] = [];
  for (const raw of rawCriteria) {
    if (!object(raw)) return null;
    const criterionId = nonBlankText(raw.id);
    const criterionText = nonBlankText(raw.text);
    if (
      !criterionId ||
      !criterionText ||
      ids.has(criterionId) ||
      typeof raw.userVisible !== "boolean"
    ) {
      return null;
    }
    ids.add(criterionId);
    criteria.push({
      id: criterionId,
      text: criterionText,
      userVisible: raw.userVisible,
    });
  }
  return { id, version: version as number, criteria };
}

export function reviewJobVerificationPlanEventKey(jobId: string): string {
  return `verification:plan:${jobId}`;
}

/**
 * Normalize model-supplied planning choices into a server-owned exact-job
 * snapshot. UI, API, and data criteria have separately bounded descriptors;
 * job remains explicit `not_testable`.
 */
export function buildReviewJobVerificationPlan(input: {
  job: ReviewJobVerificationIdentity;
  recordId: string;
  contract: ConfirmedVerificationContract;
  plannedBy: string;
  plans: unknown;
  dataHmacKey?: ReviewDataHmacKey | null;
}): BuildPlanResult {
  if (!Array.isArray(input.plans) || input.plans.length !== input.contract.criteria.length) {
    return { ok: false, error: "every confirmed criterion needs one verification plan" };
  }

  const submitted = new Map<string, Record<string, unknown>>();
  for (const raw of input.plans) {
    if (!object(raw)) return { ok: false, error: "each verification plan must be an object" };
    const criterionId = nonBlankText(raw.criterionId);
    if (!criterionId || submitted.has(criterionId)) {
      return { ok: false, error: "verification plans need unique criterion ids" };
    }
    submitted.set(criterionId, raw);
  }

  const plans: StoredCriterionVerificationPlan[] = [];
  for (const criterion of input.contract.criteria) {
    const raw = submitted.get(criterion.id);
    if (!raw) return { ok: false, error: "every confirmed criterion needs one verification plan" };
    const modality = raw.modality;
    const status = raw.status;
    if (!MODALITIES.has(modality as VerificationModality)) {
      return { ok: false, error: `criterion ${criterion.id} has an unsupported modality` };
    }
    if (criterion.userVisible && modality !== "ui") {
      return {
        ok: false,
        error: `user-visible criterion ${criterion.id} requires ui verification or an explicit ui not_testable hold`,
      };
    }

    if (status === "planned") {
      if (modality === "ui" && !exactKeys(raw, ["criterionId", "modality", "status", "flow", "uiSteps"])) {
        return { ok: false, error: `planned criterion ${criterion.id} has an invalid shape` };
      }
      if (modality === "api" && !exactKeys(raw, ["criterionId", "modality", "status", "flow", "apiRequest"])) {
        return { ok: false, error: `planned criterion ${criterion.id} has an invalid shape` };
      }
      if (modality === "data" && !exactKeys(raw, ["criterionId", "modality", "status", "flow", "dataRequest"])) {
        return { ok: false, error: `planned criterion ${criterion.id} has an invalid shape` };
      }
      if (modality === "job" && !exactKeys(raw, ["criterionId", "modality", "status", "flow", "jobRequest"])) {
        return { ok: false, error: `planned criterion ${criterion.id} has an invalid shape` };
      }
      const flow = boundedPlanText(raw.flow);
      if (!flow) return { ok: false, error: `planned criterion ${criterion.id} needs a bounded flow` };
      if (modality === "ui") {
        const uiSteps = parseUiVerificationSteps(raw.uiSteps);
        if (!uiSteps) return { ok: false, error: `planned criterion ${criterion.id} needs one bounded UI flow` };
        plans.push({
          criterionId: criterion.id,
          criterionTextSnapshot: criterion.text,
          modality: "ui",
          environmentKind: "isolated_preview",
          flow,
          uiSteps,
          apiRequest: null,
          dataRequest: null,
          status: "planned",
          notTestableReason: null,
        });
        continue;
      }
      if (modality === "api") {
        const apiRequest = parseApiVerificationRequest(raw.apiRequest);
        if (!apiRequest) return { ok: false, error: `planned criterion ${criterion.id} needs one bounded API request` };
        plans.push({
          criterionId: criterion.id,
          criterionTextSnapshot: criterion.text,
          modality: "api",
          environmentKind: "isolated_preview",
          flow,
          uiSteps: null,
          apiRequest,
          dataRequest: null,
          status: "planned",
          notTestableReason: null,
        });
        continue;
      }
      if (modality === "data") {
        if (!input.dataHmacKey) {
          return { ok: false, error: `planned data criterion ${criterion.id} requires configured review-data HMAC custody` };
        }
        const dataRequest = buildStoredDataVerificationRequest({
          value: raw.dataRequest,
          hmacKey: input.dataHmacKey,
          binding: {
            workspaceId: input.job.workspaceId,
            recordId: input.recordId,
            jobId: input.job.id,
            headSha: input.job.headSha,
            contractId: input.contract.id,
            contractVersion: input.contract.version,
            criterionId: criterion.id,
          },
        });
        if (!dataRequest) return { ok: false, error: `planned criterion ${criterion.id} needs one bounded data request` };
        plans.push({
          criterionId: criterion.id, criterionTextSnapshot: criterion.text,
          modality: "data", environmentKind: "isolated_preview", flow,
          uiSteps: null, apiRequest: null, dataRequest, status: "planned", notTestableReason: null,
        });
        continue;
      }
      if (modality === "job") {
        if (!input.dataHmacKey) {
          return { ok: false, error: `planned job criterion ${criterion.id} requires configured review-data HMAC custody` };
        }
        const jobRequest = buildStoredJobVerificationRequest({
          value: raw.jobRequest,
          hmacKey: input.dataHmacKey,
          binding: {
            workspaceId: input.job.workspaceId,
            recordId: input.recordId,
            jobId: input.job.id,
            headSha: input.job.headSha,
            contractId: input.contract.id,
            contractVersion: input.contract.version,
            criterionId: criterion.id,
          },
        });
        if (!jobRequest) return { ok: false, error: `planned criterion ${criterion.id} needs one bounded job request` };
        plans.push({
          criterionId: criterion.id, criterionTextSnapshot: criterion.text,
          modality: "job", environmentKind: "isolated_preview", flow,
          uiSteps: null, apiRequest: null, dataRequest: null, jobRequest,
          status: "planned", notTestableReason: null,
        });
        continue;
      }
      {
        return {
          ok: false,
          error: `${modality as string} execution is not available in this R7.2 slice`,
        };
      }
    }

    if (status === "not_testable") {
      if (!exactKeys(raw, ["criterionId", "modality", "status", "notTestableReason"])) {
        return { ok: false, error: `not_testable criterion ${criterion.id} has an invalid shape` };
      }
      const reason = boundedPlanText(raw.notTestableReason);
      if (!reason) return { ok: false, error: `not_testable criterion ${criterion.id} needs a reason` };
      plans.push({
        criterionId: criterion.id,
        criterionTextSnapshot: criterion.text,
        modality: modality as VerificationModality,
        environmentKind: null,
        flow: null,
        uiSteps: null,
        apiRequest: null,
        dataRequest: null,
        status: "not_testable",
        notTestableReason: reason,
      });
      continue;
    }

    return { ok: false, error: `criterion ${criterion.id} needs planned or not_testable status` };
  }

  if (submitted.size !== input.contract.criteria.length) {
    return { ok: false, error: "verification plans contain a foreign criterion" };
  }

  return {
    ok: true,
    value: {
      kind: REVIEW_JOB_VERIFICATION_PLAN_KIND,
      jobId: input.job.id,
      workspaceId: input.job.workspaceId,
      repo: input.job.repo,
      prNumber: input.job.prNumber,
      headSha: input.job.headSha,
      recordId: input.recordId,
      acceptanceContractId: input.contract.id,
      acceptanceContractVersion: input.contract.version,
      plannedBy: input.plannedBy,
      plans,
    },
  };
}

/** Parse an immutable event only when every exact-job/Contract anchor matches. */
export function parseStoredReviewJobVerificationPlan(input: {
  payload: unknown;
  job: ReviewJobVerificationIdentity;
  recordId: string;
  contract: ConfirmedVerificationContract;
}): StoredReviewJobVerificationPlan | null {
  const payload = input.payload;
  if (!object(payload)) return null;
  if (
    payload.kind !== REVIEW_JOB_VERIFICATION_PLAN_KIND ||
    payload.jobId !== input.job.id ||
    payload.workspaceId !== input.job.workspaceId ||
    payload.repo !== input.job.repo ||
    payload.prNumber !== input.job.prNumber ||
    payload.headSha !== input.job.headSha ||
    payload.recordId !== input.recordId ||
    payload.acceptanceContractId !== input.contract.id ||
    payload.acceptanceContractVersion !== input.contract.version ||
    !nonBlankText(payload.plannedBy) ||
    !Array.isArray(payload.plans) ||
    payload.plans.length !== input.contract.criteria.length
  ) {
    return null;
  }

  const byId = new Map<string, StoredCriterionVerificationPlan>();
  for (const raw of payload.plans) {
    if (!object(raw)) return null;
    const criterionId = nonBlankText(raw.criterionId);
    const criterionTextSnapshot = nonBlankText(raw.criterionTextSnapshot);
    const modality = raw.modality;
    const status = raw.status;
    if (
      !criterionId ||
      !criterionTextSnapshot ||
      byId.has(criterionId) ||
      !MODALITIES.has(modality as VerificationModality)
    ) {
      return null;
    }

    if (
      status === "planned" &&
      modality === "ui" &&
      raw.environmentKind === "isolated_preview" &&
      boundedPlanText(raw.flow) &&
      raw.notTestableReason === null &&
      (raw.apiRequest === undefined || raw.apiRequest === null) &&
      (raw.dataRequest === undefined || raw.dataRequest === null) &&
      (raw.jobRequest === undefined || raw.jobRequest === null)
    ) {
      // R7.1 stored flows had no executable steps. They remain readable for
      // audit continuity but are intentionally not executable by later work.
      const uiSteps = raw.uiSteps === undefined ? null : parseUiVerificationSteps(raw.uiSteps);
      if (raw.uiSteps !== undefined && !uiSteps) return null;
      byId.set(criterionId, {
        criterionId,
        criterionTextSnapshot,
        modality: "ui",
        environmentKind: "isolated_preview",
        flow: boundedPlanText(raw.flow),
        uiSteps,
        apiRequest: null,
        dataRequest: null,
        status: "planned",
        notTestableReason: null,
      });
      continue;
    }

    if (
      status === "planned" &&
      modality === "api" &&
      raw.environmentKind === "isolated_preview" &&
      boundedPlanText(raw.flow) &&
      raw.uiSteps === null &&
      raw.notTestableReason === null &&
      (raw.dataRequest === undefined || raw.dataRequest === null) &&
      (raw.jobRequest === undefined || raw.jobRequest === null)
    ) {
      // Plans from before the API descriptor are readable for audit continuity,
      // but `apiRequest: null` keeps them non-executable by later workers.
      const apiRequest = raw.apiRequest === undefined ? null : parseApiVerificationRequest(raw.apiRequest);
      if (raw.apiRequest !== undefined && !apiRequest) return null;
      byId.set(criterionId, {
        criterionId,
        criterionTextSnapshot,
        modality: "api",
        environmentKind: "isolated_preview",
        flow: boundedPlanText(raw.flow),
        uiSteps: null,
        apiRequest,
        dataRequest: null,
        status: "planned",
        notTestableReason: null,
      });
      continue;
    }

    if (
      status === "planned" &&
      modality === "job" &&
      raw.environmentKind === "isolated_preview" &&
      boundedPlanText(raw.flow) &&
      raw.uiSteps === null &&
      raw.apiRequest === null &&
      raw.dataRequest === null &&
      raw.notTestableReason === null
    ) {
      const jobRequest = parseStoredJobVerificationRequest(raw.jobRequest);
      if (
        !jobRequest ||
        jobRequest.readback.digestContext !== reviewJobDigestContext({
          workspaceId: input.job.workspaceId,
          recordId: input.recordId,
          jobId: input.job.id,
          headSha: input.job.headSha,
          contractId: input.contract.id,
          contractVersion: input.contract.version,
          criterionId,
          triggerPath: jobRequest.trigger.path,
          triggerExpectedStatus: jobRequest.trigger.expectedStatus,
          readbackPath: jobRequest.readback.path,
          readbackExpectedStatus: jobRequest.readback.expectedStatus,
        })
      ) return null;
      byId.set(criterionId, {
        criterionId,
        criterionTextSnapshot,
        modality: "job",
        environmentKind: "isolated_preview",
        flow: boundedPlanText(raw.flow),
        uiSteps: null,
        apiRequest: null,
        dataRequest: null,
        jobRequest,
        status: "planned",
        notTestableReason: null,
      });
      continue;
    }

    if (
      status === "planned" &&
      modality === "data" &&
      raw.environmentKind === "isolated_preview" &&
      boundedPlanText(raw.flow) &&
      raw.uiSteps === null &&
      raw.apiRequest === null &&
      raw.notTestableReason === null
    ) {
      const dataRequest = parseStoredDataVerificationRequest(raw.dataRequest);
      if (
        !dataRequest ||
        dataRequest.digestContext !== reviewDataDigestContext({
          workspaceId: input.job.workspaceId,
          recordId: input.recordId,
          jobId: input.job.id,
          headSha: input.job.headSha,
          contractId: input.contract.id,
          contractVersion: input.contract.version,
          criterionId,
          path: dataRequest.path,
          expectedStatus: dataRequest.expectedStatus,
        })
      ) return null;
      byId.set(criterionId, {
        criterionId,
        criterionTextSnapshot,
        modality: "data",
        environmentKind: "isolated_preview",
        flow: boundedPlanText(raw.flow),
        uiSteps: null,
        apiRequest: null,
        dataRequest,
        status: "planned",
        notTestableReason: null,
      });
      continue;
    }

    if (
      status === "not_testable" &&
      raw.environmentKind === null &&
      raw.flow === null &&
      (raw.uiSteps === undefined || raw.uiSteps === null) &&
      (raw.apiRequest === undefined || raw.apiRequest === null) &&
      (raw.dataRequest === undefined || raw.dataRequest === null) &&
      (raw.jobRequest === undefined || raw.jobRequest === null) &&
      boundedPlanText(raw.notTestableReason)
    ) {
      byId.set(criterionId, {
        criterionId,
        criterionTextSnapshot,
        modality: modality as VerificationModality,
        environmentKind: null,
        flow: null,
        uiSteps: null,
        apiRequest: null,
        dataRequest: null,
        status: "not_testable",
        notTestableReason: boundedPlanText(raw.notTestableReason),
      });
      continue;
    }
    return null;
  }

  const plans: StoredCriterionVerificationPlan[] = [];
  for (const criterion of input.contract.criteria) {
    const plan = byId.get(criterion.id);
    if (
      !plan ||
      plan.criterionTextSnapshot !== criterion.text ||
      (criterion.userVisible && plan.modality !== "ui")
    ) {
      return null;
    }
    plans.push(plan);
  }
  if (byId.size !== input.contract.criteria.length) return null;

  return {
    kind: REVIEW_JOB_VERIFICATION_PLAN_KIND,
    jobId: input.job.id,
    workspaceId: input.job.workspaceId,
    repo: input.job.repo,
    prNumber: input.job.prNumber,
    headSha: input.job.headSha,
    recordId: input.recordId,
    acceptanceContractId: input.contract.id,
    acceptanceContractVersion: input.contract.version,
    plannedBy: payload.plannedBy as string,
    plans,
  };
}

export function findStoredReviewJobVerificationPlan(input: {
  events: Array<{ eventKey: string; payloadRef: unknown }>;
  job: ReviewJobVerificationIdentity;
  recordId: string;
  contract: ConfirmedVerificationContract;
}): StoredReviewJobVerificationPlan | null {
  const event = input.events.find(
    (candidate) => candidate.eventKey === reviewJobVerificationPlanEventKey(input.job.id)
  );
  return event
    ? parseStoredReviewJobVerificationPlan({
        payload: event.payloadRef,
        job: input.job,
        recordId: input.recordId,
        contract: input.contract,
      })
    : null;
}
