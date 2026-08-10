import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ExactReviewJobProof } from "./review-job-proof-attestation";
import { REDACTION_PLACEHOLDER } from "./secret-scan";
import {
  type DataScalarKind,
  type JobVerificationRequest,
  type StoredCriterionVerificationPlan,
  parseStoredJobVerificationRequest,
  reviewJobDigestContext,
} from "./review-job-verification-plan";

export const REVIEW_JOB_EXECUTION_ATTEMPT_KIND = "review_job_execution_attempt";
export const REVIEW_JOB_EXECUTION_RESULT_KIND = "review_job_execution_result";
export const REVIEW_JOB_CARD_RESERVATION_KIND =
  "review_job_card_upload_reservation";
export const REVIEW_JOB_EXECUTION_STAGE = "verification";
export const REVIEW_JOB_EXECUTION_ACTOR = "jace:review-job-executor";
export const REVIEW_JOB_EVIDENCE_PREFIX = "review-job-execution:";
export const REVIEW_JOB_MATCH_PLACEHOLDER = "[MATCH]";
export const REVIEW_JOB_MISMATCH_PLACEHOLDER = "[REDACTED_MISMATCH]";
export type JobExecutionObservation =
  | { pointer: string; found: false }
  | {
      pointer: string;
      found: true;
      observedType: DataScalarKind;
      observedHmacSha256: string;
    };
export type JobAssertionReceipt = {
  pointer: string;
  found: boolean;
  passed: boolean;
  observed:
    | typeof REVIEW_JOB_MATCH_PLACEHOLDER
    | typeof REVIEW_JOB_MISMATCH_PLACEHOLDER
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
  jobRequest: JobVerificationRequest;
};
export type ReviewJobExecutionAttempt = Coordinates & {
  kind: typeof REVIEW_JOB_EXECUTION_ATTEMPT_KIND;
} & Record<string, unknown>;
export type ReviewJobExecutionResult = Coordinates & {
  kind: typeof REVIEW_JOB_EXECUTION_RESULT_KIND;
  state: "proven" | "not_proven";
  expected: string;
  observed: string;
  observedTriggerStatus: number;
  observedReadbackStatus: number | null;
  assertions: JobAssertionReceipt[];
  evidenceRef: string;
  artifactKey: string;
  contentSha256: string;
  contentType: "application/json";
} & Record<string, unknown>;
export type ReviewJobCardReservation = {
  kind: typeof REVIEW_JOB_CARD_RESERVATION_KIND;
  result: ReviewJobExecutionResult;
} & Record<string, unknown>;
export type ReviewJobResultResolution =
  | { status: "absent" | "pending" | "invalid"; result: null }
  | { status: "valid"; result: ReviewJobExecutionResult };
export interface JobExecutionBoot {
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
  "executionId",
  "headSha",
  "jobId",
  "jobRequest",
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
  "observedReadbackStatus",
  "observedTriggerStatus",
  "state",
].sort();
const object = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === keys[index])
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
): (Plan & { jobRequest: JobVerificationRequest }) | null {
  const jobRequest = parseStoredJobVerificationRequest(plan.jobRequest);
  return plan.status === "planned" &&
    plan.modality === "job" &&
    plan.environmentKind === "isolated_preview" &&
    jobRequest
    ? { ...plan, jobRequest }
    : null;
}
export const parseJobRequestDescriptor = parseStoredJobVerificationRequest;
export function plannedJobCriterion(
  proof: ExactReviewJobProof,
  criterionId: string,
) {
  const candidate = proof.verificationPlan.plans.find(
    (plan) => plan.criterionId === criterionId,
  ) as Plan | undefined;
  const plan = candidate && executable(candidate);
  if (!plan) return null;
  const request = plan.jobRequest;
  return request.readback.digestContext ===
    reviewJobDigestContext({
      workspaceId: proof.job.workspaceId,
      recordId: proof.timeline.record.id,
      jobId: proof.job.id,
      headSha: proof.job.headSha,
      contractId: proof.contract.id,
      contractVersion: proof.contract.version,
      criterionId,
      triggerPath: request.trigger.path,
      triggerExpectedStatus: request.trigger.expectedStatus,
      readbackPath: request.readback.path,
      readbackExpectedStatus: request.readback.expectedStatus,
    })
    ? plan
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
    jobRequest: parseJobRequestDescriptor(plan.jobRequest),
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
  return `job-${hash({ coordinate: coordinate(proof, plan), planDigest: digest(plan), previewBootId }).slice(0, 48)}`;
}
export const reviewJobAttemptEventKey = (input: {
  proof: ExactReviewJobProof;
  plan: Plan;
}) =>
  `verification:job-attempt:${input.proof.job.id}:${coordinate(input.proof, input.plan).slice(0, 24)}`;
export const reviewJobResultEventKey = (input: {
  proof: ExactReviewJobProof;
  plan: Plan;
}) =>
  `verification:job-result:${input.proof.job.id}:${coordinate(input.proof, input.plan).slice(0, 24)}`;
export const reviewJobCardReservationEventKey = (input: {
  proof: ExactReviewJobProof;
  plan: Plan;
}) =>
  `verification:job-card:${input.proof.job.id}:${coordinate(input.proof, input.plan).slice(0, 24)}`;
export const reviewJobEvidenceRef = (executionId: string) =>
  `${REVIEW_JOB_EVIDENCE_PREFIX}${executionId}`;
export function buildReviewJobAttempt(input: {
  proof: ExactReviewJobProof;
  plan: Plan;
  boot: JobExecutionBoot;
}): ReviewJobExecutionAttempt | null {
  const plan = plannedJobCriterion(input.proof, input.plan.criterionId);
  const previewUrl = safePreview(input.boot.url);
  if (
    !plan ||
    !isDeepStrictEqual(plan, input.plan) ||
    input.boot.workspaceId !== input.proof.job.workspaceId ||
    input.boot.repo !== input.proof.job.repo ||
    input.boot.prNumber !== input.proof.job.prNumber ||
    input.boot.headSha !== input.proof.job.headSha ||
    input.boot.status !== "ready" ||
    !previewUrl
  )
    return null;
  return {
    kind: REVIEW_JOB_EXECUTION_ATTEMPT_KIND,
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
    jobRequest: plan.jobRequest,
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
    isDeepStrictEqual(payload.jobRequest, executable(plan)?.jobRequest)
  );
}
export function parseReviewJobAttempt(input: {
  payload: unknown;
  proof: ExactReviewJobProof;
  plan: Plan;
}): ReviewJobExecutionAttempt | null {
  const plan = plannedJobCriterion(input.proof, input.plan.criterionId);
  if (
    !plan ||
    !object(input.payload) ||
    !exactKeys(input.payload, ATTEMPT_KEYS) ||
    !matches(
      input.payload,
      REVIEW_JOB_EXECUTION_ATTEMPT_KIND,
      input.proof,
      plan,
    ) ||
    !nonBlank(input.payload.previewBootId) ||
    !safePreview(input.payload.previewUrl) ||
    input.payload.executionId !==
      id(input.proof, plan, String(input.payload.previewBootId))
  )
    return null;
  return input.payload as ReviewJobExecutionAttempt;
}
export function findReviewJobAttempt(input: {
  proof: ExactReviewJobProof;
  plan: Plan;
}) {
  const event = input.proof.timeline.events.find(
    (item) => item.eventKey === reviewJobAttemptEventKey(input),
  );
  return event
    ? parseReviewJobAttempt({ ...input, payload: event.payloadRef })
    : null;
}
export function findReviewJobAttemptByExecutionId(input: {
  proof: ExactReviewJobProof;
  executionId: string;
}) {
  for (const plan of input.proof.verificationPlan.plans) {
    if (!plannedJobCriterion(input.proof, plan.criterionId)) continue;
    const attempt = findReviewJobAttempt({ proof: input.proof, plan });
    if (attempt?.executionId === input.executionId) return { plan, attempt };
  }
  return null;
}
function parseObservations(
  value: unknown,
  request: JobVerificationRequest,
  triggerStatus: number,
  readbackStatus: number | null,
): JobExecutionObservation[] | null {
  if (!Array.isArray(value)) return null;
  if (
    triggerStatus !== request.trigger.expectedStatus ||
    readbackStatus !== request.readback.expectedStatus
  )
    return value.length === 0 ? [] : null;
  if (value.length !== request.readback.expectedJson.length) return null;
  const out: JobExecutionObservation[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    const expected = request.readback.expectedJson[i]!;
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
  request: JobVerificationRequest,
  triggerStatus: number,
  readbackStatus: number | null,
  values: JobExecutionObservation[],
): JobAssertionReceipt[] {
  return request.readback.expectedJson.map((expected, index) => {
    const value = values[index];
    if (
      triggerStatus !== request.trigger.expectedStatus ||
      readbackStatus !== request.readback.expectedStatus ||
      !value?.found
    )
      return {
        pointer: expected.pointer,
        found: false,
        passed: false,
        observed: null,
        observedHmacSha256: null,
      };
    const passed =
      value.observedType === expected.equalsType &&
      value.observedHmacSha256 === expected.equalsHmacSha256;
    return {
      pointer: expected.pointer,
      found: true,
      passed,
      observed: passed
        ? REVIEW_JOB_MATCH_PLACEHOLDER
        : REVIEW_JOB_MISMATCH_PLACEHOLDER,
      observedHmacSha256: passed ? expected.equalsHmacSha256 : null,
    };
  });
}
function validReceipts(
  value: unknown,
  request: JobVerificationRequest,
  triggerStatus: number,
  readbackStatus: number | null,
): JobAssertionReceipt[] | null {
  if (
    !Array.isArray(value) ||
    value.length !== request.readback.expectedJson.length
  )
    return null;
  const out: JobAssertionReceipt[] = [];
  for (let i = 0; i < value.length; i++) {
    const receipt = value[i],
      expected = request.readback.expectedJson[i]!;
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
        REVIEW_JOB_MATCH_PLACEHOLDER,
        REVIEW_JOB_MISMATCH_PLACEHOLDER,
        REDACTION_PLACEHOLDER,
        null,
      ].includes(receipt.observed as never)
    )
      return null;
    if (
      triggerStatus !== request.trigger.expectedStatus ||
      readbackStatus !== request.readback.expectedStatus ||
      !receipt.found
    ) {
      if (
        receipt.found ||
        receipt.observed !== null ||
        receipt.observedHmacSha256 !== null ||
        receipt.passed
      )
        return null;
      out.push(receipt as JobAssertionReceipt);
      continue;
    }
    if (
      receipt.observed === REDACTION_PLACEHOLDER ||
      receipt.observed === REVIEW_JOB_MISMATCH_PLACEHOLDER
    ) {
      if (receipt.observedHmacSha256 !== null || receipt.passed) return null;
      out.push(receipt as JobAssertionReceipt);
      continue;
    }
    if (
      receipt.observed !== REVIEW_JOB_MATCH_PLACEHOLDER ||
      receipt.observedHmacSha256 !== expected.equalsHmacSha256 ||
      !receipt.passed ||
      !/^[a-f0-9]{64}$/u.test(receipt.observedHmacSha256)
    )
      return null;
    out.push(receipt as JobAssertionReceipt);
  }
  return out;
}
function summary(
  request: JobVerificationRequest,
  triggerStatus: number,
  readbackStatus: number | null,
  assertions: JobAssertionReceipt[],
) {
  if (triggerStatus !== request.trigger.expectedStatus)
    return `The safe job trigger ${request.trigger.path} returned HTTP ${triggerStatus}; the planned status was ${request.trigger.expectedStatus}.`;
  if (readbackStatus !== request.readback.expectedStatus)
    return `The safe job readback ${request.readback.path} returned HTTP ${readbackStatus}; the planned status was ${request.readback.expectedStatus}.`;
  const failed = assertions.filter((item) => !item.passed).length;
  return failed
    ? `The safe job readback ${request.readback.path} returned HTTP ${readbackStatus}; ${failed} of ${assertions.length} planned JSON scalar assertions did not match.`
    : `The safe job trigger and readback returned planned HTTP statuses; all ${assertions.length} planned JSON scalar assertions matched.`;
}
export function buildReviewJobResult(input: {
  attempt: ReviewJobExecutionAttempt;
  plan: Plan;
  observedTriggerStatus: number;
  observedReadbackStatus: number | null;
  observations: unknown;
  artifactKey: string;
  contentSha256: string;
}): ReviewJobExecutionResult | null {
  const plan = executable(input.plan),
    key = nonBlank(input.artifactKey);
  if (
    !plan ||
    !Number.isInteger(input.observedTriggerStatus) ||
    input.observedTriggerStatus < 100 ||
    input.observedTriggerStatus > 599 ||
    (input.observedReadbackStatus !== null &&
      (!Number.isInteger(input.observedReadbackStatus) ||
        input.observedReadbackStatus < 100 ||
        input.observedReadbackStatus > 599)) ||
    (input.observedTriggerStatus !== plan.jobRequest.trigger.expectedStatus &&
      input.observedReadbackStatus !== null) ||
    (input.observedTriggerStatus === plan.jobRequest.trigger.expectedStatus &&
      input.observedReadbackStatus === null) ||
    !key ||
    !/^[a-f0-9]{64}$/u.test(input.contentSha256)
  )
    return null;
  const values = parseObservations(
    input.observations,
    plan.jobRequest,
    input.observedTriggerStatus,
    input.observedReadbackStatus,
  );
  if (!values) return null;
  const assertions = receipts(
    plan.jobRequest,
    input.observedTriggerStatus,
    input.observedReadbackStatus,
    values,
  );
  const proven =
    input.observedTriggerStatus === plan.jobRequest.trigger.expectedStatus &&
    input.observedReadbackStatus === plan.jobRequest.readback.expectedStatus &&
    assertions.every((item) => item.passed);
  return {
    ...input.attempt,
    kind: REVIEW_JOB_EXECUTION_RESULT_KIND,
    state: proven ? "proven" : "not_proven",
    expected: input.plan.criterionTextSnapshot,
    observed: summary(
      plan.jobRequest,
      input.observedTriggerStatus,
      input.observedReadbackStatus,
      assertions,
    ),
    observedTriggerStatus: input.observedTriggerStatus,
    observedReadbackStatus: input.observedReadbackStatus,
    assertions,
    evidenceRef: reviewJobEvidenceRef(input.attempt.executionId),
    artifactKey: key,
    contentSha256: input.contentSha256,
    contentType: "application/json",
  };
}
export const buildReviewJobCardReservation = (
  result: ReviewJobExecutionResult,
): ReviewJobCardReservation => ({
  kind: REVIEW_JOB_CARD_RESERVATION_KIND,
  result,
});
export function parseReviewJobResult(input: {
  payload: unknown;
  proof: ExactReviewJobProof;
  plan: Plan;
}): ReviewJobExecutionResult | null {
  const plan = plannedJobCriterion(input.proof, input.plan.criterionId),
    attempt = findReviewJobAttempt(input);
  if (
    !plan ||
    !attempt ||
    !object(input.payload) ||
    !exactKeys(input.payload, RESULT_KEYS) ||
    !Number.isInteger(input.payload.observedTriggerStatus) ||
    (input.payload.observedReadbackStatus !== null &&
      !Number.isInteger(input.payload.observedReadbackStatus)) ||
    !nonBlank(input.payload.artifactKey) ||
    !/^[a-f0-9]{64}$/u.test(String(input.payload.contentSha256))
  )
    return null;
  const triggerStatus = input.payload.observedTriggerStatus as number,
    readbackStatus = input.payload.observedReadbackStatus as number | null;
  if (
    (triggerStatus !== plan.jobRequest.trigger.expectedStatus &&
      readbackStatus !== null) ||
    (triggerStatus === plan.jobRequest.trigger.expectedStatus &&
      readbackStatus === null)
  )
    return null;
  const assertions = validReceipts(
    input.payload.assertions,
    plan.jobRequest,
    triggerStatus,
    readbackStatus,
  );
  if (!assertions) return null;
  const proven =
    triggerStatus === plan.jobRequest.trigger.expectedStatus &&
    readbackStatus === plan.jobRequest.readback.expectedStatus &&
    assertions.every((item) => item.passed);
  const canonical = {
    ...attempt,
    kind: REVIEW_JOB_EXECUTION_RESULT_KIND,
    state: proven ? "proven" : "not_proven",
    expected: plan.criterionTextSnapshot,
    observed: summary(
      plan.jobRequest,
      triggerStatus,
      readbackStatus,
      assertions,
    ),
    observedTriggerStatus: triggerStatus,
    observedReadbackStatus: readbackStatus,
    assertions,
    evidenceRef: reviewJobEvidenceRef(attempt.executionId),
    artifactKey: input.payload.artifactKey,
    contentSha256: input.payload.contentSha256,
    contentType: "application/json" as const,
  };
  return isDeepStrictEqual(canonical, input.payload)
    ? (canonical as ReviewJobExecutionResult)
    : null;
}
export function parseReviewJobCardReservation(input: {
  payload: unknown;
  proof: ExactReviewJobProof;
  plan: Plan;
}): ReviewJobCardReservation | null {
  if (
    !object(input.payload) ||
    !exactKeys(input.payload, ["kind", "result"]) ||
    input.payload.kind !== REVIEW_JOB_CARD_RESERVATION_KIND
  )
    return null;
  const result = parseReviewJobResult({
    ...input,
    payload: input.payload.result,
  });
  return result && isDeepStrictEqual(result, input.payload.result)
    ? (input.payload as ReviewJobCardReservation)
    : null;
}
export function resolveReviewJobResult(input: {
  proof: ExactReviewJobProof;
  plan: Plan;
}): ReviewJobResultResolution {
  const results = input.proof.timeline.events.filter(
      (event) => event.eventKey === reviewJobResultEventKey(input),
    ),
    reservations = input.proof.timeline.events.filter(
      (event) => event.eventKey === reviewJobCardReservationEventKey(input),
    );
  if (!results.length && !reservations.length)
    return { status: "absent", result: null };
  if (!results.length && reservations.length === 1)
    return parseReviewJobCardReservation({
      ...input,
      payload: reservations[0]?.payloadRef,
    })
      ? { status: "pending", result: null }
      : { status: "invalid", result: null };
  if (results.length !== 1 || reservations.length !== 1)
    return { status: "invalid", result: null };
  const result = parseReviewJobResult({
      ...input,
      payload: results[0]?.payloadRef,
    }),
    reservation = parseReviewJobCardReservation({
      ...input,
      payload: reservations[0]?.payloadRef,
    });
  return result && reservation && isDeepStrictEqual(result, reservation.result)
    ? { status: "valid", result }
    : { status: "invalid", result: null };
}
export function buildReviewJobCard(
  result: ReviewJobExecutionResult,
): Record<string, unknown> {
  return {
    trigger: {
      method: result.jobRequest.trigger.method,
      path: result.jobRequest.trigger.path,
      expectedStatus: result.jobRequest.trigger.expectedStatus,
      observedStatus: result.observedTriggerStatus,
    },
    readback: {
      method: result.jobRequest.readback.method,
      path: result.jobRequest.readback.path,
      expectedStatus: result.jobRequest.readback.expectedStatus,
      observedStatus: result.observedReadbackStatus,
      digestAlgorithm: result.jobRequest.readback.digestAlgorithm,
      digestKeyId: result.jobRequest.readback.digestKeyId,
      digestContext: result.jobRequest.readback.digestContext,
    },
    assertions: result.jobRequest.readback.expectedJson.map(
      (expected, index) => {
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
      },
    ),
  };
}
export function reviewJobResultResponse(
  result: ReviewJobExecutionResult,
  evidenceUrl: string,
): Record<string, unknown> {
  return {
    ok: true,
    state: result.state,
    expected: result.expected,
    observed: result.observed,
    observedTriggerStatus: result.observedTriggerStatus,
    observedReadbackStatus: result.observedReadbackStatus,
    assertionCount: result.assertions.length,
    evidenceRef: result.evidenceRef,
    evidenceKey: result.artifactKey,
    evidenceUrl,
  };
}
