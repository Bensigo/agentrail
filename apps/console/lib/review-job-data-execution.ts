import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { previewBootId } from "@agentrail/db-postgres";
import type { ExactReviewJobProof } from "./review-job-proof-attestation";
import { REDACTION_PLACEHOLDER } from "./secret-scan";
import {
  type DataScalarKind,
  type DataVerificationRequest,
  type StoredCriterionVerificationPlan,
  parseStoredDataVerificationRequest,
  reviewDataDigestContext,
} from "./review-job-verification-plan";

export const REVIEW_JOB_DATA_ATTEMPT_KIND = "review_job_data_execution_attempt";
export const REVIEW_JOB_DATA_RESULT_KIND = "review_job_data_execution_result";
export const REVIEW_JOB_DATA_CARD_RESERVATION_KIND =
  "review_job_data_card_upload_reservation";
export const REVIEW_JOB_DATA_STAGE = "verification";
export const REVIEW_JOB_DATA_ACTOR = "jace:review-data-executor";
export const REVIEW_JOB_DATA_EVIDENCE_PREFIX = "review-data-execution:";
export const REVIEW_JOB_DATA_MATCH_PLACEHOLDER = "[MATCH]";
export const REVIEW_JOB_DATA_MISMATCH_PLACEHOLDER = "[REDACTED_MISMATCH]";
export type DataRequestDescriptor = DataVerificationRequest;
export type DataExecutionObservation =
  | { pointer: string; found: false }
  | {
      pointer: string;
      found: true;
      observedType: DataScalarKind;
      observedHmacSha256: string;
    };
/** Sanitized receipt only: unredacted caller observations never enter the ledger. */
export type DataAssertionReceipt = {
  pointer: string;
  found: boolean;
  passed: boolean;
  observed:
    | typeof REVIEW_JOB_DATA_MATCH_PLACEHOLDER
    | typeof REVIEW_JOB_DATA_MISMATCH_PLACEHOLDER
    | typeof REDACTION_PLACEHOLDER
    | null;
  observedHmacSha256: string | null;
};
type Plan = StoredCriterionVerificationPlan;
type Coordinates = {
  executionId: string;
  jobId: string;
  workspaceId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  recordId: string;
  acceptanceContractId: string;
  acceptanceContractVersion: number;
  criterionId: string;
  criterionTextSnapshot: string;
  planDigest: string;
  previewBootId: string;
  previewUrl: string;
  dataRequest: DataRequestDescriptor;
};
export type ReviewJobDataExecutionAttempt = Coordinates & {
  kind: typeof REVIEW_JOB_DATA_ATTEMPT_KIND;
} & Record<string, unknown>;
export type ReviewJobDataExecutionResult = Coordinates & {
  kind: typeof REVIEW_JOB_DATA_RESULT_KIND;
  state: "proven" | "failed";
  expected: string;
  observed: string;
  observedStatus: number;
  assertions: DataAssertionReceipt[];
  evidenceRef: string;
  artifactKey: string;
  contentSha256: string;
  contentType: "application/json";
} & Record<string, unknown>;
export interface ReviewJobDataCardReservation extends Record<string, unknown> {
  kind: typeof REVIEW_JOB_DATA_CARD_RESERVATION_KIND;
  result: ReviewJobDataExecutionResult;
}
export type ReviewJobDataResultResolution =
  | { status: "absent" | "pending" | "invalid"; result: null }
  | { status: "valid"; result: ReviewJobDataExecutionResult };
export interface DataExecutionBoot {
  id: string;
  workspaceId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  status: string;
  url: string | null;
  expiresAt?: Date | string | null;
}

const ATTEMPT_KEYS = [
  "acceptanceContractId",
  "acceptanceContractVersion",
  "criterionId",
  "criterionTextSnapshot",
  "dataRequest",
  "executionId",
  "headSha",
  "jobId",
  "kind",
  "planDigest",
  "prNumber",
  "previewBootId",
  "previewUrl",
  "recordId",
  "repo",
  "workspaceId",
].sort();
const RESULT_KEYS = [
  ...ATTEMPT_KEYS.filter((key) => key !== "kind"),
  "artifactKey",
  "assertions",
  "contentSha256",
  "contentType",
  "evidenceRef",
  "expected",
  "kind",
  "observed",
  "observedStatus",
  "state",
].sort();
const object = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, i) => key === keys[i])
  );
};
const nonBlank = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function safePreview(value: unknown): string | null {
  const text = nonBlank(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
function executable(
  plan: Plan,
): (Plan & { dataRequest: DataRequestDescriptor }) | null {
  const dataRequest = parseStoredDataVerificationRequest(plan.dataRequest);
  return plan.status === "planned" &&
    plan.modality === "data" &&
    plan.environmentKind === "isolated_preview" &&
    dataRequest
    ? { ...plan, dataRequest }
    : null;
}
export const parseDataRequestDescriptor = parseStoredDataVerificationRequest;
export function plannedDataCriterion(
  proof: ExactReviewJobProof,
  criterionId: string,
) {
  const plan = proof.verificationPlan.plans.find(
    (candidate) => candidate.criterionId === criterionId,
  ) as Plan | undefined;
  const executablePlan = plan ? executable(plan) : null;
  if (!executablePlan) return null;
  const expectedContext = reviewDataDigestContext({
    workspaceId: proof.job.workspaceId,
    recordId: proof.timeline.record.id,
    jobId: proof.job.id,
    headSha: proof.job.headSha,
    contractId: proof.contract.id,
    contractVersion: proof.contract.version,
    criterionId,
    path: executablePlan.dataRequest.path,
    expectedStatus: executablePlan.dataRequest.expectedStatus,
  });
  return executablePlan.dataRequest.digestContext === expectedContext
    ? executablePlan
    : null;
}
function digest(plan: Plan) {
  return hash({
    criterionId: plan.criterionId,
    criterionTextSnapshot: plan.criterionTextSnapshot,
    modality: plan.modality,
    environmentKind: plan.environmentKind,
    flow: plan.flow,
    status: plan.status,
    dataRequest: parseDataRequestDescriptor(plan.dataRequest),
  });
}
function coordinate(proof: ExactReviewJobProof, plan: Plan) {
  return hash({
    jobId: proof.job.id,
    recordId: proof.timeline.record.id,
    headSha: proof.job.headSha,
    acceptanceContractId: proof.contract.id,
    acceptanceContractVersion: proof.contract.version,
    criterionId: plan.criterionId,
  });
}
function id(proof: ExactReviewJobProof, plan: Plan, previewBootId: string) {
  return `data-${hash({ coordinate: coordinate(proof, plan), planDigest: digest(plan), previewBootId }).slice(0, 48)}`;
}
export const reviewJobDataAttemptEventKey = (input: {
  proof: ExactReviewJobProof;
  plan: Plan;
}) =>
  `verification:data-attempt:${input.proof.job.id}:${coordinate(input.proof, input.plan).slice(0, 24)}`;
export const reviewJobDataResultEventKey = (input: {
  proof: ExactReviewJobProof;
  plan: Plan;
}) =>
  `verification:data-result:${input.proof.job.id}:${coordinate(input.proof, input.plan).slice(0, 24)}`;
export const reviewJobDataCardReservationEventKey = (input: {
  proof: ExactReviewJobProof;
  plan: Plan;
}) =>
  `verification:data-card:${input.proof.job.id}:${coordinate(input.proof, input.plan).slice(0, 24)}`;
export const reviewJobDataEvidenceRef = (executionId: string) =>
  `${REVIEW_JOB_DATA_EVIDENCE_PREFIX}${executionId}`;
export function buildReviewJobDataAttempt(input: {
  proof: ExactReviewJobProof;
  plan: Plan;
  boot: DataExecutionBoot;
}): ReviewJobDataExecutionAttempt | null {
  const plan = plannedDataCriterion(input.proof, input.plan.criterionId);
  const previewUrl = safePreview(input.boot.url);
  if (
    !plan ||
    !isDeepStrictEqual(plan, input.plan) ||
    input.boot.workspaceId !== input.proof.job.workspaceId ||
    input.boot.repo !== input.proof.job.repo ||
    input.boot.prNumber !== input.proof.job.prNumber ||
    input.boot.headSha !== input.proof.job.headSha ||
    input.boot.id !== previewBootId({
      workspaceId: input.proof.job.workspaceId,
      repo: input.proof.job.repo,
      prNumber: input.proof.job.prNumber,
      headSha: input.proof.job.headSha,
      cycleId: input.proof.job.id,
    }) ||
    input.boot.status !== "ready" ||
    !previewUrl
  )
    return null;
  return {
    kind: REVIEW_JOB_DATA_ATTEMPT_KIND,
    executionId: id(input.proof, plan, input.boot.id),
    jobId: input.proof.job.id,
    workspaceId: input.proof.job.workspaceId,
    repo: input.proof.job.repo,
    prNumber: input.proof.job.prNumber,
    headSha: input.proof.job.headSha,
    recordId: input.proof.timeline.record.id,
    acceptanceContractId: input.proof.contract.id,
    acceptanceContractVersion: input.proof.contract.version,
    criterionId: plan.criterionId,
    criterionTextSnapshot: plan.criterionTextSnapshot,
    planDigest: digest(plan),
    previewBootId: input.boot.id,
    previewUrl,
    dataRequest: plan.dataRequest,
  };
}
function matches(
  payload: Record<string, unknown>,
  kind: string,
  proof: ExactReviewJobProof,
  plan: Plan,
) {
  return (
    payload.kind === kind &&
    payload.jobId === proof.job.id &&
    payload.workspaceId === proof.job.workspaceId &&
    payload.repo === proof.job.repo &&
    payload.prNumber === proof.job.prNumber &&
    payload.headSha === proof.job.headSha &&
    payload.recordId === proof.timeline.record.id &&
    payload.acceptanceContractId === proof.contract.id &&
    payload.acceptanceContractVersion === proof.contract.version &&
    payload.criterionId === plan.criterionId &&
    payload.criterionTextSnapshot === plan.criterionTextSnapshot &&
    payload.planDigest === digest(plan) &&
    isDeepStrictEqual(payload.dataRequest, executable(plan)?.dataRequest)
  );
}
export function parseReviewJobDataAttempt(input: {
  payload: unknown;
  proof: ExactReviewJobProof;
  plan: Plan;
}): ReviewJobDataExecutionAttempt | null {
  const plan = plannedDataCriterion(input.proof, input.plan.criterionId);
  if (
    !plan ||
    !object(input.payload) ||
    !exactKeys(input.payload, ATTEMPT_KEYS) ||
    !matches(input.payload, REVIEW_JOB_DATA_ATTEMPT_KIND, input.proof, plan) ||
    !nonBlank(input.payload.previewBootId) ||
    !safePreview(input.payload.previewUrl) ||
    input.payload.executionId !==
      id(input.proof, plan, String(input.payload.previewBootId))
  )
    return null;
  return input.payload as ReviewJobDataExecutionAttempt;
}
export function findReviewJobDataAttempt(input: {
  proof: ExactReviewJobProof;
  plan: Plan;
}) {
  const event = input.proof.timeline.events.find(
    (candidate) => candidate.eventKey === reviewJobDataAttemptEventKey(input),
  );
  return event
    ? parseReviewJobDataAttempt({
        proof: input.proof,
        plan: input.plan,
        payload: event.payloadRef,
      })
    : null;
}
export function findReviewJobDataAttemptByExecutionId(input: {
  proof: ExactReviewJobProof;
  executionId: string;
}) {
  for (const plan of input.proof.verificationPlan.plans) {
    if (!plannedDataCriterion(input.proof, plan.criterionId)) continue;
    const attempt = findReviewJobDataAttempt({ proof: input.proof, plan });
    if (attempt?.executionId === input.executionId) return { plan, attempt };
  }
  return null;
}
function parseObservations(
  value: unknown,
  request: DataRequestDescriptor,
  status: number,
): DataExecutionObservation[] | null {
  if (!Array.isArray(value)) return null;
  if (status !== request.expectedStatus) return value.length === 0 ? [] : null;
  if (value.length !== request.expectedJson.length) return null;
  const out: DataExecutionObservation[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    const expected = request.expectedJson[i]!;
    if (
      !object(item) ||
      item.pointer !== expected.pointer ||
      typeof item.found !== "boolean"
    )
      return null;
    if (!item.found) {
      if (!exactKeys(item, ["found", "pointer"])) return null;
      out.push({ pointer: expected.pointer, found: false });
    } else {
      if (
        !exactKeys(item, [
          "found",
          "observedHmacSha256",
          "observedType",
          "pointer",
        ]) ||
        !["null", "boolean", "number", "string"].includes(
          item.observedType as string,
        ) ||
        !/^[a-f0-9]{64}$/u.test(String(item.observedHmacSha256))
      )
        return null;
      out.push({
        pointer: expected.pointer,
        found: true,
        observedType: item.observedType as DataScalarKind,
        observedHmacSha256: item.observedHmacSha256 as string,
      });
    }
  }
  return out;
}
function receipts(
  request: DataRequestDescriptor,
  status: number,
  values: DataExecutionObservation[],
): DataAssertionReceipt[] {
  return request.expectedJson.map((expected, index) => {
    const value = values[index];
    if (status !== request.expectedStatus || !value?.found)
      return {
        pointer: expected.pointer,
        found: false,
        passed: false,
        observed: null,
        observedHmacSha256: null,
      };
    const matches =
      value.observedType === expected.equalsType &&
      value.observedHmacSha256 === expected.equalsHmacSha256;
    return {
      pointer: expected.pointer,
      found: true,
      passed: matches,
      observed: matches
        ? REVIEW_JOB_DATA_MATCH_PLACEHOLDER
        : REVIEW_JOB_DATA_MISMATCH_PLACEHOLDER,
      observedHmacSha256: matches ? expected.equalsHmacSha256 : null,
    };
  });
}
function validReceipts(
  value: unknown,
  request: DataRequestDescriptor,
  status: number,
): DataAssertionReceipt[] | null {
  if (!Array.isArray(value) || value.length !== request.expectedJson.length)
    return null;
  const out: DataAssertionReceipt[] = [];
  for (let i = 0; i < value.length; i++) {
    const receipt = value[i];
    const expected = request.expectedJson[i]!;
    if (
      !object(receipt) ||
      !exactKeys(receipt, [
        "found",
        "observed",
        "observedHmacSha256",
        "passed",
        "pointer",
      ]) ||
      receipt.pointer !== expected.pointer ||
      typeof receipt.found !== "boolean" ||
      typeof receipt.passed !== "boolean" ||
      (typeof receipt.observedHmacSha256 !== "string" &&
        receipt.observedHmacSha256 !== null) ||
      ![
        REVIEW_JOB_DATA_MATCH_PLACEHOLDER,
        REVIEW_JOB_DATA_MISMATCH_PLACEHOLDER,
        REDACTION_PLACEHOLDER,
        null,
      ].includes(receipt.observed as never)
    )
      return null;
    if (status !== request.expectedStatus || !receipt.found) {
      if (
        receipt.found ||
        receipt.observed !== null ||
        receipt.observedHmacSha256 !== null ||
        receipt.passed
      )
        return null;
      out.push(receipt as DataAssertionReceipt);
      continue;
    }
    if (
      receipt.observed === REDACTION_PLACEHOLDER ||
      receipt.observed === REVIEW_JOB_DATA_MISMATCH_PLACEHOLDER
    ) {
      if (receipt.observedHmacSha256 !== null || receipt.passed) return null;
      out.push(receipt as DataAssertionReceipt);
      continue;
    }
    if (
      receipt.observed !== REVIEW_JOB_DATA_MATCH_PLACEHOLDER ||
      receipt.observedHmacSha256 !== expected.equalsHmacSha256 ||
      receipt.passed !== true ||
      !/^[a-f0-9]{64}$/u.test(receipt.observedHmacSha256)
    )
      return null;
    out.push(receipt as DataAssertionReceipt);
  }
  return out;
}
function summary(
  request: DataRequestDescriptor,
  status: number,
  assertions: DataAssertionReceipt[],
) {
  if (status !== request.expectedStatus)
    return `The safe data GET ${request.path} returned HTTP ${status}; the planned status was ${request.expectedStatus}.`;
  const failed = assertions.filter((assertion) => !assertion.passed).length;
  return failed
    ? `The safe data GET ${request.path} returned HTTP ${request.expectedStatus}; ${failed} of ${assertions.length} planned JSON scalar assertions did not match.`
    : `The safe data GET ${request.path} returned HTTP ${request.expectedStatus}; all ${assertions.length} planned JSON scalar assertions matched.`;
}
export function buildReviewJobDataResult(input: {
  attempt: ReviewJobDataExecutionAttempt;
  plan: Plan;
  observedStatus: number;
  observations: unknown;
  artifactKey: string;
  contentSha256: string;
}): ReviewJobDataExecutionResult | null {
  const plan = executable(input.plan);
  const key = nonBlank(input.artifactKey);
  if (
    !plan ||
    !Number.isInteger(input.observedStatus) ||
    input.observedStatus < 100 ||
    input.observedStatus > 599 ||
    !key ||
    !/^[a-f0-9]{64}$/u.test(input.contentSha256)
  )
    return null;
  const values = parseObservations(
    input.observations,
    plan.dataRequest,
    input.observedStatus,
  );
  if (!values) return null;
  const assertions = receipts(plan.dataRequest, input.observedStatus, values);
  return {
    ...input.attempt,
    kind: REVIEW_JOB_DATA_RESULT_KIND,
    state:
      input.observedStatus === plan.dataRequest.expectedStatus &&
      assertions.every((assertion) => assertion.passed)
        ? "proven"
        : "failed",
    expected: input.plan.criterionTextSnapshot,
    observed: summary(plan.dataRequest, input.observedStatus, assertions),
    observedStatus: input.observedStatus,
    assertions,
    evidenceRef: reviewJobDataEvidenceRef(input.attempt.executionId),
    artifactKey: key,
    contentSha256: input.contentSha256,
    contentType: "application/json",
  };
}
export const buildReviewJobDataCardReservation = (
  result: ReviewJobDataExecutionResult,
): ReviewJobDataCardReservation => ({
  kind: REVIEW_JOB_DATA_CARD_RESERVATION_KIND,
  result,
});
export function parseReviewJobDataResult(input: {
  payload: unknown;
  proof: ExactReviewJobProof;
  plan: Plan;
}): ReviewJobDataExecutionResult | null {
  const plan = plannedDataCriterion(input.proof, input.plan.criterionId);
  const attempt = findReviewJobDataAttempt(input);
  if (
    !plan ||
    !attempt ||
    !object(input.payload) ||
    !exactKeys(input.payload, RESULT_KEYS) ||
    !Number.isInteger(input.payload.observedStatus) ||
    !nonBlank(input.payload.artifactKey) ||
    !/^[a-f0-9]{64}$/u.test(String(input.payload.contentSha256))
  )
    return null;
  const assertions = validReceipts(
    input.payload.assertions,
    plan.dataRequest,
    input.payload.observedStatus as number,
  );
  if (!assertions) return null;
  const canonical = {
    ...attempt,
    kind: REVIEW_JOB_DATA_RESULT_KIND,
    state: (input.payload.observedStatus === plan.dataRequest.expectedStatus &&
    assertions.every((assertion) => assertion.passed)
      ? "proven"
      : "failed") as "proven" | "failed",
    expected: plan.criterionTextSnapshot,
    observed: summary(
      plan.dataRequest,
      input.payload.observedStatus as number,
      assertions,
    ),
    observedStatus: input.payload.observedStatus,
    assertions,
    evidenceRef: reviewJobDataEvidenceRef(attempt.executionId),
    artifactKey: input.payload.artifactKey,
    contentSha256: input.payload.contentSha256,
    contentType: "application/json" as const,
  };
  return isDeepStrictEqual(canonical, input.payload)
    ? (canonical as ReviewJobDataExecutionResult)
    : null;
}
export function parseReviewJobDataCardReservation(input: {
  payload: unknown;
  proof: ExactReviewJobProof;
  plan: Plan;
}): ReviewJobDataCardReservation | null {
  if (
    !object(input.payload) ||
    !exactKeys(input.payload, ["kind", "result"]) ||
    input.payload.kind !== REVIEW_JOB_DATA_CARD_RESERVATION_KIND
  )
    return null;
  const result = parseReviewJobDataResult({
    payload: input.payload.result,
    proof: input.proof,
    plan: input.plan,
  });
  return result && isDeepStrictEqual(result, input.payload.result)
    ? (input.payload as ReviewJobDataCardReservation)
    : null;
}
export function resolveReviewJobDataResult(input: {
  proof: ExactReviewJobProof;
  plan: Plan;
}): ReviewJobDataResultResolution {
  const results = input.proof.timeline.events.filter(
    (event) => event.eventKey === reviewJobDataResultEventKey(input),
  );
  const reservations = input.proof.timeline.events.filter(
    (event) => event.eventKey === reviewJobDataCardReservationEventKey(input),
  );
  if (!results.length && !reservations.length)
    return { status: "absent", result: null };
  if (!results.length && reservations.length === 1)
    return parseReviewJobDataCardReservation({
      payload: reservations[0]?.payloadRef,
      ...input,
    })
      ? { status: "pending", result: null }
      : { status: "invalid", result: null };
  if (results.length !== 1 || reservations.length !== 1)
    return { status: "invalid", result: null };
  const result = parseReviewJobDataResult({
    payload: results[0]?.payloadRef,
    ...input,
  });
  const reservation = parseReviewJobDataCardReservation({
    payload: reservations[0]?.payloadRef,
    ...input,
  });
  return result && reservation && isDeepStrictEqual(result, reservation.result)
    ? { status: "valid", result }
    : { status: "invalid", result: null };
}
export function buildReviewJobDataCard(
  result: ReviewJobDataExecutionResult,
): Record<string, unknown> {
  return {
    request: {
      method: result.dataRequest.method,
      path: result.dataRequest.path,
      digestAlgorithm: result.dataRequest.digestAlgorithm,
      digestKeyId: result.dataRequest.digestKeyId,
      digestContext: result.dataRequest.digestContext,
    },
    response: { status: result.observedStatus },
    assertions: result.dataRequest.expectedJson.map((expected, index) => {
      const receipt = result.assertions[index]!;
      return {
        pointer: expected.pointer,
        expected: {
          type: expected.equalsType,
          hmacSha256: expected.equalsHmacSha256,
        },
        observed: receipt.observed,
        observedHmacSha256: receipt.observedHmacSha256,
        passed: receipt.passed,
      };
    }),
  };
}
export function reviewJobDataResultResponse(
  result: ReviewJobDataExecutionResult,
  evidenceUrl: string,
): Record<string, unknown> {
  return {
    ok: true,
    state: result.state,
    expected: result.expected,
    observed: result.observed,
    observedStatus: result.observedStatus,
    assertionCount: result.assertions.length,
    evidenceRef: result.evidenceRef,
    evidenceKey: result.artifactKey,
    evidenceUrl,
  };
}
