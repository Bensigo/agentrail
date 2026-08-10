import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { previewBootId } from "@agentrail/db-postgres";
import type { ExactReviewJobProof } from "./review-job-proof-attestation";
import type {
  StoredCriterionVerificationPlan,
  UiVerificationStep,
} from "./review-job-verification-plan";

export const REVIEW_JOB_UI_ATTEMPT_KIND = "review_job_ui_execution_attempt";
export const REVIEW_JOB_UI_RESULT_KIND = "review_job_ui_execution_result";
export const REVIEW_JOB_UI_SCREENSHOT_RESERVATION_KIND =
  "review_job_ui_screenshot_upload_reservation";
export const REVIEW_JOB_UI_STAGE = "verification";
export const REVIEW_JOB_UI_ACTOR = "jace:review-ui-executor";
export const REVIEW_JOB_UI_EVIDENCE_PREFIX = "review-ui-execution:";

export type AttestedUiState = "proven" | "failed";

interface ReviewJobUiExecutionCoordinates {
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
  uiSteps: UiVerificationStep[];
}

export type ReviewJobUiExecutionAttempt = ReviewJobUiExecutionCoordinates & {
  kind: typeof REVIEW_JOB_UI_ATTEMPT_KIND;
} & Record<string, unknown>;

export type ReviewJobUiExecutionResult = ReviewJobUiExecutionCoordinates & {
  kind: typeof REVIEW_JOB_UI_RESULT_KIND;
  state: AttestedUiState;
  expected: string;
  observed: string;
  evidenceRef: string;
  artifactKey: string;
  contentType: "image/png" | "image/jpeg";
  contentSha256: string;
  observedUrl: string;
} & Record<string, unknown>;

export interface ReviewJobUiScreenshotReservation extends Record<string, unknown> {
  kind: typeof REVIEW_JOB_UI_SCREENSHOT_RESERVATION_KIND;
  result: ReviewJobUiExecutionResult;
}

export type ReviewJobUiResultResolution =
  | { status: "absent" | "pending" | "invalid"; result: null }
  | { status: "valid"; result: ReviewJobUiExecutionResult };

export interface UiExecutionBoot {
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
  "kind",
  "planDigest",
  "prNumber",
  "previewBootId",
  "previewUrl",
  "recordId",
  "repo",
  "uiSteps",
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
  "observedUrl",
  "state",
].sort();

function object(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function nonBlank(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeHttpUrl(value: unknown): string | null {
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

export function sameHttpOrigin(left: unknown, right: unknown): boolean {
  const leftUrl = safeHttpUrl(left);
  const rightUrl = safeHttpUrl(right);
  if (!leftUrl || !rightUrl) return false;
  return new URL(leftUrl).origin === new URL(rightUrl).origin;
}

export function plannedUiCriterion(
  proof: ExactReviewJobProof,
  criterionId: string
): StoredCriterionVerificationPlan | null {
  const plan = proof.verificationPlan.plans.find(
    (candidate) => candidate.criterionId === criterionId
  );
  return plan?.status === "planned" &&
    plan.modality === "ui" &&
    Array.isArray(plan.uiSteps) &&
    plan.uiSteps.length > 0
    ? plan
    : null;
}

function planDigest(plan: StoredCriterionVerificationPlan): string {
  return sha256({
    criterionId: plan.criterionId,
    criterionTextSnapshot: plan.criterionTextSnapshot,
    modality: plan.modality,
    environmentKind: plan.environmentKind,
    flow: plan.flow,
    status: plan.status,
    uiSteps: plan.uiSteps,
  });
}

function coordinateDigest(input: {
  proof: ExactReviewJobProof;
  plan: StoredCriterionVerificationPlan;
}): string {
  return sha256({
    jobId: input.proof.job.id,
    recordId: input.proof.timeline.record.id,
    headSha: input.proof.job.headSha,
    acceptanceContractId: input.proof.contract.id,
    acceptanceContractVersion: input.proof.contract.version,
    criterionId: input.plan.criterionId,
  });
}

function uiExecutionId(input: {
  proof: ExactReviewJobProof;
  plan: StoredCriterionVerificationPlan;
  previewBootId: string;
}): string {
  return `ui-${sha256({
    coordinate: coordinateDigest(input),
    planDigest: planDigest(input.plan),
    previewBootId: input.previewBootId,
  }).slice(0, 48)}`;
}

export function reviewJobUiAttemptEventKey(input: {
  proof: ExactReviewJobProof;
  plan: StoredCriterionVerificationPlan;
}): string {
  return `verification:ui-attempt:${input.proof.job.id}:${coordinateDigest(input).slice(0, 24)}`;
}

export function reviewJobUiResultEventKey(input: {
  proof: ExactReviewJobProof;
  plan: StoredCriterionVerificationPlan;
}): string {
  return `verification:ui-result:${input.proof.job.id}:${coordinateDigest(input).slice(0, 24)}`;
}

export function reviewJobUiScreenshotReservationEventKey(input: {
  proof: ExactReviewJobProof;
  plan: StoredCriterionVerificationPlan;
}): string {
  return `verification:ui-screenshot:${input.proof.job.id}:${coordinateDigest(input).slice(0, 24)}`;
}

export function reviewJobUiEvidenceRef(executionId: string): string {
  return `${REVIEW_JOB_UI_EVIDENCE_PREFIX}${executionId}`;
}

export function buildReviewJobUiAttempt(input: {
  proof: ExactReviewJobProof;
  plan: StoredCriterionVerificationPlan;
  boot: UiExecutionBoot;
}): ReviewJobUiExecutionAttempt | null {
  const { proof, plan, boot } = input;
  const currentPlan = plannedUiCriterion(proof, plan.criterionId);
  const previewUrl = safeHttpUrl(boot.url);
  if (
    !currentPlan ||
    !isDeepStrictEqual(currentPlan, plan) ||
    boot.workspaceId !== proof.job.workspaceId ||
    boot.repo !== proof.job.repo ||
    boot.prNumber !== proof.job.prNumber ||
    boot.headSha !== proof.job.headSha ||
    boot.id !== previewBootId({
      workspaceId: proof.job.workspaceId,
      repo: proof.job.repo,
      prNumber: proof.job.prNumber,
      headSha: proof.job.headSha,
      cycleId: proof.job.id,
    }) ||
    boot.status !== "ready" ||
    !previewUrl
  ) {
    return null;
  }
  const digest = planDigest(plan);
  const executionId = uiExecutionId({ proof, plan, previewBootId: boot.id });
  return {
    kind: REVIEW_JOB_UI_ATTEMPT_KIND,
    executionId,
    jobId: proof.job.id,
    workspaceId: proof.job.workspaceId,
    repo: proof.job.repo,
    prNumber: proof.job.prNumber,
    headSha: proof.job.headSha,
    recordId: proof.timeline.record.id,
    acceptanceContractId: proof.contract.id,
    acceptanceContractVersion: proof.contract.version,
    criterionId: plan.criterionId,
    criterionTextSnapshot: plan.criterionTextSnapshot,
    planDigest: digest,
    previewBootId: boot.id,
    previewUrl,
    uiSteps: plan.uiSteps as UiVerificationStep[],
  };
}

function matchesCurrentIdentity(input: {
  payload: Record<string, unknown>;
  kind: string;
  proof: ExactReviewJobProof;
  plan: StoredCriterionVerificationPlan;
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
    isDeepStrictEqual(payload.uiSteps, plan.uiSteps)
  );
}

export function parseReviewJobUiAttempt(input: {
  payload: unknown;
  proof: ExactReviewJobProof;
  plan: StoredCriterionVerificationPlan;
}): ReviewJobUiExecutionAttempt | null {
  if (!object(input.payload) || !exactKeys(input.payload, ATTEMPT_KEYS)) return null;
  if (
    !matchesCurrentIdentity({
      payload: input.payload,
      kind: REVIEW_JOB_UI_ATTEMPT_KIND,
      proof: input.proof,
      plan: input.plan,
    }) ||
    input.payload.executionId !==
      uiExecutionId({
        proof: input.proof,
        plan: input.plan,
        previewBootId: String(input.payload.previewBootId),
      }) ||
    !nonBlank(input.payload.previewBootId) ||
    !safeHttpUrl(input.payload.previewUrl)
  ) {
    return null;
  }
  return input.payload as ReviewJobUiExecutionAttempt;
}

export function findReviewJobUiAttempt(input: {
  proof: ExactReviewJobProof;
  plan: StoredCriterionVerificationPlan;
}): ReviewJobUiExecutionAttempt | null {
  const event = input.proof.timeline.events.find(
    (candidate) => candidate.eventKey === reviewJobUiAttemptEventKey(input)
  );
  return event
    ? parseReviewJobUiAttempt({ payload: event.payloadRef, ...input })
    : null;
}

export function findReviewJobUiAttemptByExecutionId(input: {
  proof: ExactReviewJobProof;
  executionId: string;
}): { plan: StoredCriterionVerificationPlan; attempt: ReviewJobUiExecutionAttempt } | null {
  for (const candidate of input.proof.verificationPlan.plans) {
    const plan = plannedUiCriterion(input.proof, candidate.criterionId);
    if (!plan) continue;
    const attempt = findReviewJobUiAttempt({ proof: input.proof, plan });
    if (attempt?.executionId === input.executionId) return { plan, attempt };
  }
  return null;
}

function assertionText(plan: StoredCriterionVerificationPlan): string | null {
  const steps = plan.uiSteps;
  if (!Array.isArray(steps) || steps.length < 2) return null;
  const assertion = steps[steps.length - 2];
  return assertion?.action === "expect_text" ? assertion.text : null;
}

export function reviewJobUiObservation(input: {
  plan: StoredCriterionVerificationPlan;
  assertionPassed: boolean;
}): string | null {
  const text = assertionText(input.plan);
  if (!text) return null;
  return input.assertionPassed
    ? `The deterministic browser observed the planned text ${JSON.stringify(text)} on the exact-head preview and retained the decisive screenshot.`
    : `The deterministic browser did not observe the planned text ${JSON.stringify(text)} on the exact-head preview; the failing state was retained as the decisive screenshot.`;
}

export function buildReviewJobUiResult(input: {
  attempt: ReviewJobUiExecutionAttempt;
  plan: StoredCriterionVerificationPlan;
  assertionPassed: boolean;
  artifactKey: string;
  contentType: "image/png" | "image/jpeg";
  contentSha256: string;
  observedUrl: string;
}): ReviewJobUiExecutionResult | null {
  const observed = reviewJobUiObservation({
    plan: input.plan,
    assertionPassed: input.assertionPassed,
  });
  const artifactKey = nonBlank(input.artifactKey);
  const digest = nonBlank(input.contentSha256);
  const observedUrl = safeHttpUrl(input.observedUrl);
  if (
    !observed ||
    !artifactKey ||
    !digest ||
    !/^[a-f0-9]{64}$/u.test(digest) ||
    !observedUrl ||
    !sameHttpOrigin(observedUrl, input.attempt.previewUrl)
  ) {
    return null;
  }
  return {
    ...input.attempt,
    kind: REVIEW_JOB_UI_RESULT_KIND,
    state: input.assertionPassed ? "proven" : "failed",
    expected: input.plan.criterionTextSnapshot,
    observed,
    evidenceRef: reviewJobUiEvidenceRef(input.attempt.executionId),
    artifactKey,
    contentType: input.contentType,
    contentSha256: digest,
    observedUrl,
  };
}

export function buildReviewJobUiScreenshotReservation(
  result: ReviewJobUiExecutionResult
): ReviewJobUiScreenshotReservation {
  return {
    kind: REVIEW_JOB_UI_SCREENSHOT_RESERVATION_KIND,
    result,
  };
}

function parseReviewJobUiResultPayload(input: {
  payload: unknown;
  proof: ExactReviewJobProof;
  plan: StoredCriterionVerificationPlan;
}): ReviewJobUiExecutionResult | null {
  const { payload, proof, plan } = input;
  if (!object(payload) || !exactKeys(payload, RESULT_KEYS)) return null;
  const attempt = findReviewJobUiAttempt({ proof, plan });
  if (
    !attempt ||
    ATTEMPT_KEYS.some(
      (key) =>
        key !== "kind" &&
        !isDeepStrictEqual(payload[key], attempt[key as keyof ReviewJobUiExecutionAttempt])
    ) ||
    !matchesCurrentIdentity({
      payload,
      kind: REVIEW_JOB_UI_RESULT_KIND,
      proof,
      plan,
    }) ||
    (payload.state !== "proven" && payload.state !== "failed") ||
    payload.expected !== plan.criterionTextSnapshot ||
    payload.observed !==
      reviewJobUiObservation({
        plan,
        assertionPassed: payload.state === "proven",
      }) ||
    payload.evidenceRef !== reviewJobUiEvidenceRef(String(payload.executionId)) ||
    !nonBlank(payload.artifactKey) ||
    (payload.contentType !== "image/png" && payload.contentType !== "image/jpeg") ||
    !nonBlank(payload.contentSha256) ||
    !/^[a-f0-9]{64}$/u.test(String(payload.contentSha256)) ||
    !sameHttpOrigin(payload.observedUrl, payload.previewUrl)
  ) {
    return null;
  }
  return payload as ReviewJobUiExecutionResult;
}

export function parseReviewJobUiScreenshotReservation(input: {
  payload: unknown;
  proof: ExactReviewJobProof;
  plan: StoredCriterionVerificationPlan;
}): ReviewJobUiScreenshotReservation | null {
  if (
    !object(input.payload) ||
    !exactKeys(input.payload, ["kind", "result"]) ||
    input.payload.kind !== REVIEW_JOB_UI_SCREENSHOT_RESERVATION_KIND
  ) {
    return null;
  }
  const result = parseReviewJobUiResultPayload({
    payload: input.payload.result,
    proof: input.proof,
    plan: input.plan,
  });
  return result && isDeepStrictEqual(result, input.payload.result)
    ? (input.payload as ReviewJobUiScreenshotReservation)
    : null;
}

export function parseReviewJobUiResult(input: {
  payload: unknown;
  proof: ExactReviewJobProof;
  plan: StoredCriterionVerificationPlan;
}): ReviewJobUiExecutionResult | null {
  const result = parseReviewJobUiResultPayload(input);
  if (!result) return null;
  const reservationEvents = input.proof.timeline.events.filter(
    (candidate) =>
      candidate.eventKey === reviewJobUiScreenshotReservationEventKey(input)
  );
  if (reservationEvents.length !== 1) return null;
  const reservation = parseReviewJobUiScreenshotReservation({
    payload: reservationEvents[0]?.payloadRef,
    proof: input.proof,
    plan: input.plan,
  });
  return reservation && isDeepStrictEqual(reservation.result, result)
    ? result
    : null;
}

/** Distinguish no execution receipt from a present-but-invalid custody chain. */
export function resolveReviewJobUiResult(input: {
  proof: ExactReviewJobProof;
  plan: StoredCriterionVerificationPlan;
}): ReviewJobUiResultResolution {
  const resultEvents = input.proof.timeline.events.filter(
    (candidate) => candidate.eventKey === reviewJobUiResultEventKey(input)
  );
  const reservationEvents = input.proof.timeline.events.filter(
    (candidate) =>
      candidate.eventKey === reviewJobUiScreenshotReservationEventKey(input)
  );
  if (resultEvents.length === 0 && reservationEvents.length === 0) {
    return { status: "absent", result: null };
  }
  if (resultEvents.length === 0 && reservationEvents.length === 1) {
    const reservation = parseReviewJobUiScreenshotReservation({
      payload: reservationEvents[0]?.payloadRef,
      ...input,
    });
    return reservation
      ? { status: "pending", result: null }
      : { status: "invalid", result: null };
  }
  if (resultEvents.length !== 1 || reservationEvents.length !== 1) {
    return { status: "invalid", result: null };
  }
  const result = parseReviewJobUiResult({
    payload: resultEvents[0]?.payloadRef,
    ...input,
  });
  return result
    ? { status: "valid", result }
    : { status: "invalid", result: null };
}

export function findReviewJobUiResult(input: {
  proof: ExactReviewJobProof;
  plan: StoredCriterionVerificationPlan;
}): ReviewJobUiExecutionResult | null {
  return resolveReviewJobUiResult(input).result;
}

export function reviewJobUiResultResponse(
  result: ReviewJobUiExecutionResult,
  evidenceUrl: string
): Record<string, unknown> {
  return {
    ok: true,
    state: result.state,
    expected: result.expected,
    observed: result.observed,
    evidenceRef: result.evidenceRef,
    evidenceKey: result.artifactKey,
    evidenceUrl,
  };
}
