export const REVIEW_JOB_VERIFICATION_PLAN_KIND = "review_job_verification_plan";
export const REVIEW_JOB_VERIFICATION_PLAN_STAGE = "verification";
export const REVIEW_JOB_VERIFICATION_PLAN_ACTOR = "jace:review-verification-planner";

export type VerificationModality = "ui" | "api" | "job" | "data";
export type VerificationPlanStatus = "planned" | "not_testable";

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
  return normalized && normalized.length <= MAX_PLAN_TEXT ? normalized : null;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
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
 * snapshot. This R7.1 slice can safely execute UI only; API/job/data remain
 * explicit `not_testable` until their criterion executors land under R7.2.
 */
export function buildReviewJobVerificationPlan(input: {
  job: ReviewJobVerificationIdentity;
  recordId: string;
  contract: ConfirmedVerificationContract;
  plannedBy: string;
  plans: unknown;
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
      if (!exactKeys(raw, ["criterionId", "modality", "status", "flow"])) {
        return { ok: false, error: `planned criterion ${criterion.id} has an invalid shape` };
      }
      const flow = boundedPlanText(raw.flow);
      if (!flow) return { ok: false, error: `planned criterion ${criterion.id} needs a bounded flow` };
      if (modality !== "ui") {
        return { ok: false, error: `${modality as string} execution is not available until R7.2` };
      }
      plans.push({
        criterionId: criterion.id,
        criterionTextSnapshot: criterion.text,
        modality: "ui",
        environmentKind: "isolated_preview",
        flow,
        status: "planned",
        notTestableReason: null,
      });
      continue;
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
      raw.notTestableReason === null
    ) {
      byId.set(criterionId, {
        criterionId,
        criterionTextSnapshot,
        modality: "ui",
        environmentKind: "isolated_preview",
        flow: boundedPlanText(raw.flow),
        status: "planned",
        notTestableReason: null,
      });
      continue;
    }

    if (
      status === "not_testable" &&
      raw.environmentKind === null &&
      raw.flow === null &&
      boundedPlanText(raw.notTestableReason)
    ) {
      byId.set(criterionId, {
        criterionId,
        criterionTextSnapshot,
        modality: modality as VerificationModality,
        environmentKind: null,
        flow: null,
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
