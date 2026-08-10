import { createHash } from "node:crypto";
import {
  getPreviewBoot,
  getReviewJobById,
  readAcceptanceContracts,
  readChangeRecordTimelineByPr,
} from "@agentrail/db-postgres";
import {
  type ConfirmedVerificationContract,
  type StoredReviewJobVerificationPlan,
  confirmedVerificationContract,
  findStoredReviewJobVerificationPlan,
} from "./review-job-verification-plan";

export type CriterionState = "proven" | "failed" | "not_proven" | "not_testable";

export interface CriterionResult {
  criterionId: string;
  state: CriterionState;
  expected: string;
  observed: string;
  evidenceRefs: string[];
}

export interface ReviewOutcomeAttestationInput {
  criterionResults: CriterionResult[];
  verdict?: string;
  summaryLine?: string;
  evidenceKeys?: string[];
}

type ReviewJob = NonNullable<Awaited<ReturnType<typeof getReviewJobById>>>;
type ChangeRecordTimeline = NonNullable<
  Awaited<ReturnType<typeof readChangeRecordTimelineByPr>>
>;

export interface ExactReviewJobProof {
  job: ReviewJob;
  timeline: ChangeRecordTimeline;
  contract: ConfirmedVerificationContract;
  verificationPlan: StoredReviewJobVerificationPlan;
}

export const REVIEW_JOB_POST_ATTEMPT_KIND = "review_job_github_post_attempt";
export const REVIEW_JOB_POSTED_ATTESTATION_KIND = "review_job_github_posted";
export const REVIEW_JOB_POST_STAGE = "review";
export const REVIEW_JOB_POST_ACTOR = "reviewer-of-record";

const CRITERION_STATES = new Set<CriterionState>([
  "proven",
  "failed",
  "not_proven",
  "not_testable",
]);
const PREVIEW_BOOT_EVIDENCE_PREFIX = "preview-boot:";
const MAX_SERVER_CUSTODIED_REASON = 2_000;

export const R7_READY_NOT_PROVEN_OBSERVATION =
  "The isolated exact-head preview became ready, but R7.1 does not yet provide server-custodied criterion execution evidence; this criterion remains not proven until R7.2.";

export function r7UnavailablePreviewObservation(input: {
  status: "failed" | "torn_down";
  reason: string;
}): string {
  const transition =
    input.status === "failed"
      ? "failed before it became ready"
      : "was torn down before it became ready";
  return `The isolated exact-head preview ${transition}: ${input.reason}`;
}

function nonBlank(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Parse one terminal result per criterion; plan-aware evidence rules run later. */
export function parseCriterionResults(value: unknown): CriterionResult[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const ids = new Set<string>();
  const results: CriterionResult[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const item = entry as Record<string, unknown>;
    const keys = Object.keys(item).sort();
    const expectedKeys = ["criterionId", "evidenceRefs", "expected", "observed", "state"];
    if (
      keys.length !== expectedKeys.length ||
      !keys.every((key, index) => key === expectedKeys[index])
    ) {
      return null;
    }
    const criterionId = nonBlank(item.criterionId);
    const expected = nonBlank(item.expected);
    const observed = nonBlank(item.observed);
    const state = item.state;
    if (
      !criterionId ||
      ids.has(criterionId) ||
      !expected ||
      !observed ||
      !CRITERION_STATES.has(state as CriterionState) ||
      !stringArray(item.evidenceRefs) ||
      item.evidenceRefs.some((reference) => !nonBlank(reference))
    ) {
      return null;
    }
    if (state !== "not_testable" && item.evidenceRefs.length === 0) {
      return null;
    }
    ids.add(criterionId);
    results.push({
      criterionId,
      state: state as CriterionState,
      expected,
      observed,
      evidenceRefs: item.evidenceRefs.map((reference) => reference.trim()),
    });
  }
  return results;
}

function canonicalCriterionResults(results: CriterionResult[]) {
  return results
    .map((result) => ({
      criterionId: result.criterionId.trim(),
      state: result.state,
      expected: result.expected.trim(),
      observed: result.observed.trim(),
      evidenceRefs: [...result.evidenceRefs].map((reference) => reference.trim()).sort(),
    }))
    .sort((left, right) => left.criterionId.localeCompare(right.criterionId));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Stable across harmless criterion/evidence ordering differences. */
export function reviewOutcomeDigest(input: ReviewOutcomeAttestationInput): string {
  return sha256({
    criterionResults: canonicalCriterionResults(input.criterionResults),
    verdict: input.verdict?.trim() ?? null,
    summaryLine: input.summaryLine?.trim() ?? null,
    evidenceKeys: input.evidenceKeys
      ? [...input.evidenceKeys].map((key) => key.trim()).sort()
      : null,
  });
}

export function reviewPostPayloadDigest(input: {
  outcomeDigest: string;
  summary: string;
  comments: Array<{ path: string; line: number; body: string }>;
}): string {
  return sha256({
    outcomeDigest: input.outcomeDigest,
    summary: input.summary,
    comments: input.comments,
  });
}

function exactPreviewBootId(references: string[]): string | null {
  if (references.length !== 1) return null;
  const reference = references[0]!;
  if (!reference.startsWith(PREVIEW_BOOT_EVIDENCE_PREFIX)) return null;
  return nonBlank(reference.slice(PREVIEW_BOOT_EVIDENCE_PREFIX.length));
}

function boundedCustodiedReason(value: unknown): string | null {
  const reason = nonBlank(value);
  return reason &&
    reason.length <= MAX_SERVER_CUSTODIED_REASON &&
    !/[\u0000-\u001f\u007f]/u.test(reason)
    ? reason
    : null;
}

/**
 * R7.1 attests only the exact-head environment decision. It deliberately
 * cannot turn a ready boot into behavioral proof: `proven`/`failed` remain
 * unavailable until R7.2 adds server-custodied criterion execution artifacts.
 */
async function exactPreviewEvidence(
  job: ReviewJob,
  criterionResults: CriterionResult[],
  verificationPlan: StoredReviewJobVerificationPlan,
  evidenceKeys?: string[]
): Promise<boolean> {
  const plansByCriterion = new Map(
    verificationPlan.plans.map((plan) => [plan.criterionId, plan])
  );
  const boots = new Map<string, NonNullable<Awaited<ReturnType<typeof getPreviewBoot>>>>();
  const allowedEvidenceKeys = new Set<string>();
  for (const result of criterionResults) {
    const plan = plansByCriterion.get(result.criterionId);
    if (!plan) return false;
    if (plan.status === "not_testable") {
      if (
        result.state !== "not_testable" ||
        result.observed !== plan.notTestableReason ||
        result.evidenceRefs.length !== 0
      ) {
        return false;
      }
      continue;
    }

    const bootId = exactPreviewBootId(result.evidenceRefs);
    if (!bootId) return false;
    let boot = boots.get(bootId);
    if (!boot) {
      const resolved = await getPreviewBoot(bootId);
      if (!resolved) return false;
      boot = resolved;
      boots.set(bootId, boot);
    }
    if (
      boot.workspaceId !== job.workspaceId ||
      boot.repo !== job.repo ||
      boot.prNumber !== job.prNumber ||
      boot.headSha !== job.headSha
    ) {
      return false;
    }

    const readyUrl = nonBlank(boot.url);
    if (
      (boot.status === "ready" || boot.status === "torn_down") &&
      readyUrl
    ) {
      if (
        result.state !== "not_proven" ||
        result.observed !== R7_READY_NOT_PROVEN_OBSERVATION
      ) {
        return false;
      }
    } else if (
      (boot.status === "failed" || boot.status === "torn_down") &&
      !readyUrl
    ) {
      const reason = boundedCustodiedReason(boot.reason);
      if (
        !reason ||
        result.state !== "not_testable" ||
        result.observed !==
          r7UnavailablePreviewObservation({ status: boot.status, reason })
      ) {
        return false;
      }
    } else {
      // Includes every in-flight state, ready-without-URL, and failed-after-
      // ready. None is a terminal environment claim R7.1 can safely attest.
      return false;
    }

    const bootLogKey = nonBlank(boot.bootLogKey);
    if (bootLogKey) allowedEvidenceKeys.add(bootLogKey);
  }

  const submittedKeys = evidenceKeys ?? [];
  if (new Set(submittedKeys).size !== submittedKeys.length) return false;
  if (submittedKeys.some((key) => !allowedEvidenceKeys.has(key))) return false;
  return true;
}

/** Resolve and attest the current running job, exact Record head, Contract, plan, and boots. */
export async function resolveExactReviewJobProof(input: {
  jobId: string;
  criterionResults: CriterionResult[];
  verdict?: string;
  evidenceKeys?: string[];
}): Promise<ExactReviewJobProof | null> {
  const job = await getReviewJobById(input.jobId);
  if (!job || job.state !== "running") return null;

  const timeline = await readChangeRecordTimelineByPr({
    workspaceId: job.workspaceId,
    repo: job.repo,
    prNumber: job.prNumber,
  });
  if (
    !timeline ||
    timeline.record.workspaceId !== job.workspaceId ||
    timeline.record.repo !== job.repo ||
    timeline.record.prNumber !== job.prNumber ||
    !timeline.record.headShas.includes(job.headSha)
  ) {
    return null;
  }

  const contract = confirmedVerificationContract(
    await readAcceptanceContracts({
      workspaceId: job.workspaceId,
      recordId: timeline.record.id,
    })
  );
  if (!contract) return null;

  const verificationPlan = findStoredReviewJobVerificationPlan({
    events: timeline.events,
    job,
    recordId: timeline.record.id,
    contract,
  });
  if (!verificationPlan || verificationPlan.plans.length !== input.criterionResults.length) {
    return null;
  }

  const plansByCriterion = new Map(
    verificationPlan.plans.map((plan) => [plan.criterionId, plan])
  );
  for (const result of input.criterionResults) {
    const plan = plansByCriterion.get(result.criterionId);
    if (!plan || result.expected !== plan.criterionTextSnapshot) return null;
  }
  const expectedVerdict = input.criterionResults.some(
    (result) => result.state === "not_proven"
  )
    ? "not_proven"
    : "not_testable";
  if (input.verdict !== expectedVerdict) return null;
  if (
    !(await exactPreviewEvidence(
      job,
      input.criterionResults,
      verificationPlan,
      input.evidenceKeys
    ))
  ) {
    return null;
  }

  return { job, timeline, contract, verificationPlan };
}

export function reviewPostAttemptEventKey(jobId: string): string {
  return `review:github-attempt:${jobId}`;
}

export function reviewPostedAttestationEventKey(jobId: string): string {
  return `review:github-posted:${jobId}`;
}

export function reviewPostAttemptPayload(input: {
  proof: ExactReviewJobProof;
  outcomeDigest: string;
  postPayloadDigest: string;
}): Record<string, unknown> {
  const { proof } = input;
  return {
    kind: REVIEW_JOB_POST_ATTEMPT_KIND,
    jobId: proof.job.id,
    workspaceId: proof.job.workspaceId,
    repo: proof.job.repo,
    prNumber: proof.job.prNumber,
    headSha: proof.job.headSha,
    recordId: proof.timeline.record.id,
    acceptanceContractId: proof.contract.id,
    acceptanceContractVersion: proof.contract.version,
    outcomeDigest: input.outcomeDigest,
    postPayloadDigest: input.postPayloadDigest,
  };
}

export function reviewPostedAttestationPayload(input: {
  proof: ExactReviewJobProof;
  outcomeDigest: string;
  postPayloadDigest: string;
  postedReviewUrl: string;
  inlineCommentsPosted?: number;
  commentsFolded?: boolean;
}): Record<string, unknown> {
  return {
    ...reviewPostAttemptPayload(input),
    kind: REVIEW_JOB_POSTED_ATTESTATION_KIND,
    postedReviewUrl: input.postedReviewUrl,
    ...(input.inlineCommentsPosted === undefined
      ? {}
      : { inlineCommentsPosted: input.inlineCommentsPosted }),
    ...(input.commentsFolded === undefined
      ? {}
      : { commentsFolded: input.commentsFolded }),
  };
}

function matchingEventPayload(input: {
  payload: unknown;
  kind: string;
  proof: ExactReviewJobProof;
  outcomeDigest: string;
  postPayloadDigest?: string;
}): Record<string, unknown> | null {
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    return null;
  }
  const payload = input.payload as Record<string, unknown>;
  if (
    payload.kind !== input.kind ||
    payload.jobId !== input.proof.job.id ||
    payload.workspaceId !== input.proof.job.workspaceId ||
    payload.repo !== input.proof.job.repo ||
    payload.prNumber !== input.proof.job.prNumber ||
    payload.headSha !== input.proof.job.headSha ||
    payload.recordId !== input.proof.timeline.record.id ||
    payload.acceptanceContractId !== input.proof.contract.id ||
    payload.acceptanceContractVersion !== input.proof.contract.version ||
    payload.outcomeDigest !== input.outcomeDigest ||
    (input.postPayloadDigest !== undefined &&
      payload.postPayloadDigest !== input.postPayloadDigest)
  ) {
    return null;
  }
  return payload;
}

export function findMatchingPostAttempt(input: {
  proof: ExactReviewJobProof;
  outcomeDigest: string;
  postPayloadDigest: string;
}): Record<string, unknown> | null {
  const event = input.proof.timeline.events.find(
    (candidate) => candidate.eventKey === reviewPostAttemptEventKey(input.proof.job.id)
  );
  return event
    ? matchingEventPayload({
        payload: event.payloadRef,
        kind: REVIEW_JOB_POST_ATTEMPT_KIND,
        ...input,
      })
    : null;
}

export function findMatchingPostedAttestation(input: {
  proof: ExactReviewJobProof;
  outcomeDigest: string;
  postPayloadDigest?: string;
}): (Record<string, unknown> & { postedReviewUrl: string }) | null {
  const event = input.proof.timeline.events.find(
    (candidate) =>
      candidate.eventKey === reviewPostedAttestationEventKey(input.proof.job.id)
  );
  const payload = event
    ? matchingEventPayload({
        payload: event.payloadRef,
        kind: REVIEW_JOB_POSTED_ATTESTATION_KIND,
        ...input,
      })
    : null;
  if (
    !payload ||
    !nonBlank(payload.postedReviewUrl)
  ) {
    return null;
  }
  return {
    ...payload,
    postedReviewUrl: (payload.postedReviewUrl as string).trim(),
  } as Record<string, unknown> & { postedReviewUrl: string };
}
