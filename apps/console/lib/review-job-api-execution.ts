import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { previewBootId } from "@agentrail/db-postgres";
import type { ExactReviewJobProof } from "./review-job-proof-attestation";
import {
  type ApiVerificationRequest,
  type StoredCriterionVerificationPlan,
  parseApiVerificationRequest,
} from "./review-job-verification-plan";

export const REVIEW_JOB_API_ATTEMPT_KIND = "review_job_api_execution_attempt";
export const REVIEW_JOB_API_RESULT_KIND = "review_job_api_execution_result";
export const REVIEW_JOB_API_CARD_RESERVATION_KIND =
  "review_job_api_card_upload_reservation";
export const REVIEW_JOB_API_STAGE = "verification";
export const REVIEW_JOB_API_ACTOR = "jace:review-api-executor";
export const REVIEW_JOB_API_EVIDENCE_PREFIX = "review-api-execution:";

export type ApiRequestDescriptor = ApiVerificationRequest;
type ApiPlan = StoredCriterionVerificationPlan;
interface Coordinates {
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
  apiRequest: ApiRequestDescriptor;
}
export type ReviewJobApiExecutionAttempt = Coordinates & {
  kind: typeof REVIEW_JOB_API_ATTEMPT_KIND;
} & Record<string, unknown>;
export type ReviewJobApiExecutionResult = Coordinates & {
  kind: typeof REVIEW_JOB_API_RESULT_KIND;
  state: "proven" | "failed";
  expected: string;
  observed: string;
  observedStatus: number;
  evidenceRef: string;
  artifactKey: string;
  contentSha256: string;
  contentType: "application/json";
} & Record<string, unknown>;
export interface ReviewJobApiCardReservation extends Record<string, unknown> {
  kind: typeof REVIEW_JOB_API_CARD_RESERVATION_KIND;
  result: ReviewJobApiExecutionResult;
}
export type ReviewJobApiResultResolution =
  | { status: "absent" | "pending" | "invalid"; result: null }
  | { status: "valid"; result: ReviewJobApiExecutionResult };

export interface ApiExecutionBoot {
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
  "apiRequest",
  "criterionId",
  "criterionTextSnapshot",
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
  "contentSha256",
  "contentType",
  "evidenceRef",
  "expected",
  "kind",
  "observed",
  "observedStatus",
  "state",
].sort();

function object(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
function nonBlank(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, i) => key === keys[i])
  );
}
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

/** A persisted descriptor may request only a bounded relative GET from the exact preview. */
export function parseApiRequestDescriptor(
  value: unknown,
): ApiRequestDescriptor | null {
  return parseApiVerificationRequest(value);
}

function executableApiPlan(
  plan: StoredCriterionVerificationPlan,
):
  | (StoredCriterionVerificationPlan & { apiRequest: ApiRequestDescriptor })
  | null {
  const apiRequest = parseApiVerificationRequest(plan.apiRequest);
  return plan.status === "planned" &&
    plan.modality === "api" &&
    plan.environmentKind === "isolated_preview" &&
    apiRequest
    ? { ...plan, apiRequest }
    : null;
}

export function plannedApiCriterion(
  proof: ExactReviewJobProof,
  criterionId: string,
):
  | (StoredCriterionVerificationPlan & { apiRequest: ApiRequestDescriptor })
  | null {
  const plan = proof.verificationPlan.plans.find(
    (candidate) => candidate.criterionId === criterionId,
  ) as ApiPlan | undefined;
  return plan ? executableApiPlan(plan) : null;
}
function planDigest(plan: ApiPlan): string {
  return hash({
    criterionId: plan.criterionId,
    criterionTextSnapshot: plan.criterionTextSnapshot,
    modality: plan.modality,
    environmentKind: plan.environmentKind,
    flow: plan.flow,
    status: plan.status,
    apiRequest: parseApiRequestDescriptor(plan.apiRequest),
  });
}
function coordinate(proof: ExactReviewJobProof, plan: ApiPlan): string {
  return hash({
    jobId: proof.job.id,
    recordId: proof.timeline.record.id,
    headSha: proof.job.headSha,
    acceptanceContractId: proof.contract.id,
    acceptanceContractVersion: proof.contract.version,
    criterionId: plan.criterionId,
  });
}
function executionId(
  proof: ExactReviewJobProof,
  plan: ApiPlan,
  previewBootId: string,
): string {
  return `api-${hash({ coordinate: coordinate(proof, plan), planDigest: planDigest(plan), previewBootId }).slice(0, 48)}`;
}
export function reviewJobApiAttemptEventKey(input: {
  proof: ExactReviewJobProof;
  plan: ApiPlan;
}): string {
  return `verification:api-attempt:${input.proof.job.id}:${coordinate(input.proof, input.plan).slice(0, 24)}`;
}
export function reviewJobApiResultEventKey(input: {
  proof: ExactReviewJobProof;
  plan: ApiPlan;
}): string {
  return `verification:api-result:${input.proof.job.id}:${coordinate(input.proof, input.plan).slice(0, 24)}`;
}
export function reviewJobApiCardReservationEventKey(input: {
  proof: ExactReviewJobProof;
  plan: ApiPlan;
}): string {
  return `verification:api-card:${input.proof.job.id}:${coordinate(input.proof, input.plan).slice(0, 24)}`;
}
export function reviewJobApiEvidenceRef(executionId: string): string {
  return `${REVIEW_JOB_API_EVIDENCE_PREFIX}${executionId}`;
}

export function buildReviewJobApiAttempt(input: {
  proof: ExactReviewJobProof;
  plan: StoredCriterionVerificationPlan;
  boot: ApiExecutionBoot;
}): ReviewJobApiExecutionAttempt | null {
  const plan = plannedApiCriterion(input.proof, input.plan.criterionId);
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
    kind: REVIEW_JOB_API_ATTEMPT_KIND,
    executionId: executionId(input.proof, plan, input.boot.id),
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
    planDigest: planDigest(plan),
    previewBootId: input.boot.id,
    previewUrl,
    apiRequest: plan.apiRequest,
  };
}

function matches(input: {
  payload: Record<string, unknown>;
  kind: string;
  proof: ExactReviewJobProof;
  plan: ApiPlan;
}): boolean {
  const { payload, proof, plan } = input;
  return (
    payload.kind === input.kind &&
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
    payload.planDigest === planDigest(plan) &&
    isDeepStrictEqual(payload.apiRequest, plan.apiRequest)
  );
}
export function parseReviewJobApiAttempt(input: {
  payload: unknown;
  proof: ExactReviewJobProof;
  plan: StoredCriterionVerificationPlan;
}): ReviewJobApiExecutionAttempt | null {
  const plan = plannedApiCriterion(input.proof, input.plan.criterionId);
  if (
    !plan ||
    !object(input.payload) ||
    !exactKeys(input.payload, ATTEMPT_KEYS) ||
    !matches({
      payload: input.payload,
      kind: REVIEW_JOB_API_ATTEMPT_KIND,
      proof: input.proof,
      plan,
    }) ||
    !nonBlank(input.payload.previewBootId) ||
    !safePreview(input.payload.previewUrl) ||
    input.payload.executionId !==
      executionId(input.proof, plan, String(input.payload.previewBootId))
  )
    return null;
  return input.payload as ReviewJobApiExecutionAttempt;
}
export function findReviewJobApiAttempt(input: {
  proof: ExactReviewJobProof;
  plan: StoredCriterionVerificationPlan;
}): ReviewJobApiExecutionAttempt | null {
  const event = input.proof.timeline.events.find(
    (candidate) =>
      candidate.eventKey ===
      reviewJobApiAttemptEventKey({ proof: input.proof, plan: input.plan }),
  );
  return event
    ? parseReviewJobApiAttempt({
        payload: event.payloadRef,
        proof: input.proof,
        plan: input.plan,
      })
    : null;
}
export function findReviewJobApiAttemptByExecutionId(input: {
  proof: ExactReviewJobProof;
  executionId: string;
}): {
  plan: StoredCriterionVerificationPlan;
  attempt: ReviewJobApiExecutionAttempt;
} | null {
  for (const candidate of input.proof.verificationPlan.plans) {
    if (!plannedApiCriterion(input.proof, candidate.criterionId)) continue;
    const attempt = findReviewJobApiAttempt({
      proof: input.proof,
      plan: candidate,
    });
    if (attempt?.executionId === input.executionId)
      return { plan: candidate, attempt };
  }
  return null;
}
function observation(plan: ApiPlan, status: number): string {
  return status === plan.apiRequest!.expectedStatus
    ? `The safe GET ${plan.apiRequest!.path} returned the planned HTTP ${plan.apiRequest!.expectedStatus}.`
    : `The safe GET ${plan.apiRequest!.path} returned HTTP ${status}; the planned status was ${plan.apiRequest!.expectedStatus}.`;
}
export function buildReviewJobApiResult(input: {
  attempt: ReviewJobApiExecutionAttempt;
  plan: StoredCriterionVerificationPlan;
  observedStatus: number;
  artifactKey: string;
  contentSha256: string;
}): ReviewJobApiExecutionResult | null {
  const plan = executableApiPlan(input.plan);
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
  const state =
    input.observedStatus === plan.apiRequest.expectedStatus
      ? "proven"
      : "failed";
  return {
    ...input.attempt,
    kind: REVIEW_JOB_API_RESULT_KIND,
    state,
    expected: input.plan.criterionTextSnapshot,
    observed: observation(plan, input.observedStatus),
    observedStatus: input.observedStatus,
    evidenceRef: reviewJobApiEvidenceRef(input.attempt.executionId),
    artifactKey: key,
    contentSha256: input.contentSha256,
    contentType: "application/json",
  };
}
export function buildReviewJobApiCardReservation(
  result: ReviewJobApiExecutionResult,
): ReviewJobApiCardReservation {
  return { kind: REVIEW_JOB_API_CARD_RESERVATION_KIND, result };
}
export function parseReviewJobApiResult(input: {
  payload: unknown;
  proof: ExactReviewJobProof;
  plan: StoredCriterionVerificationPlan;
}): ReviewJobApiExecutionResult | null {
  const plan = plannedApiCriterion(input.proof, input.plan.criterionId);
  const attempt = findReviewJobApiAttempt({
    proof: input.proof,
    plan: input.plan,
  });
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
  const canonical = buildReviewJobApiResult({
    attempt,
    plan,
    observedStatus: input.payload.observedStatus as number,
    artifactKey: input.payload.artifactKey as string,
    contentSha256: input.payload.contentSha256 as string,
  });
  return canonical && isDeepStrictEqual(canonical, input.payload)
    ? canonical
    : null;
}
export function parseReviewJobApiCardReservation(input: {
  payload: unknown;
  proof: ExactReviewJobProof;
  plan: StoredCriterionVerificationPlan;
}): ReviewJobApiCardReservation | null {
  if (
    !object(input.payload) ||
    !exactKeys(input.payload, ["kind", "result"]) ||
    input.payload.kind !== REVIEW_JOB_API_CARD_RESERVATION_KIND
  )
    return null;
  const result = parseReviewJobApiResult({
    payload: input.payload.result,
    proof: input.proof,
    plan: input.plan,
  });
  return result && isDeepStrictEqual(result, input.payload.result)
    ? (input.payload as ReviewJobApiCardReservation)
    : null;
}
export function resolveReviewJobApiResult(input: {
  proof: ExactReviewJobProof;
  plan: StoredCriterionVerificationPlan;
}): ReviewJobApiResultResolution {
  const plan = input.plan as ApiPlan;
  const results = input.proof.timeline.events.filter(
    (e) =>
      e.eventKey === reviewJobApiResultEventKey({ proof: input.proof, plan }),
  );
  const reservations = input.proof.timeline.events.filter(
    (e) =>
      e.eventKey ===
      reviewJobApiCardReservationEventKey({ proof: input.proof, plan }),
  );
  if (!results.length && !reservations.length)
    return { status: "absent", result: null };
  if (!results.length && reservations.length === 1)
    return parseReviewJobApiCardReservation({
      payload: reservations[0]?.payloadRef,
      ...input,
    })
      ? { status: "pending", result: null }
      : { status: "invalid", result: null };
  if (results.length !== 1 || reservations.length !== 1)
    return { status: "invalid", result: null };
  const result = parseReviewJobApiResult({
    payload: results[0]?.payloadRef,
    ...input,
  });
  const reservation = parseReviewJobApiCardReservation({
    payload: reservations[0]?.payloadRef,
    ...input,
  });
  return result && reservation && isDeepStrictEqual(result, reservation.result)
    ? { status: "valid", result }
    : { status: "invalid", result: null };
}
export function reviewJobApiResultResponse(
  result: ReviewJobApiExecutionResult,
  evidenceUrl: string,
): Record<string, unknown> {
  return {
    ok: true,
    state: result.state,
    expected: result.expected,
    observed: result.observed,
    observedStatus: result.observedStatus,
    evidenceRef: result.evidenceRef,
    evidenceKey: result.artifactKey,
    evidenceUrl,
  };
}
