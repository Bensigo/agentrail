import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import { workspaces } from "../schema/workspaces.js";
import {
  acceptanceContracts,
  acceptanceGatedGithubIssuePublications,
  changeRecordEvents,
  changeRecords,
} from "../schema/change_records.js";
import { previewBoots } from "../schema/preview_boots.js";
import { reviewJobs } from "../schema/review_jobs.js";
import { workspaceMemberships } from "../schema/workspace_memberships.js";
import {
  ACCEPTANCE_CRITERION_OUTCOME_MAX_EVENT_BYTES,
  AcceptanceCriterionOutcomeBundleConflictError,
  AcceptanceGatedGithubIssueConflictError,
  acceptanceCriterionOutcomeBundleId,
  advanceConfirmedAcceptanceRecordPullRequestHead,
  appendChangeRecordEvent,
  appendCurrentReviewJobEventsAtomically,
  changeRecordEventId,
  createDraftAcceptanceRecord,
  readAcceptanceRecordDetail,
  readAcceptancePrReviewMetrics,
  readCurrentAcceptanceCriterionOutcomeBundle,
  readCurrentAcceptanceGatedGithubIssue,
  readCurrentAcceptancePrDecision,
  recordPostedAcceptanceCriterionOutcomeBundle,
  reportAcceptanceGatedGithubIssuePublication,
  reserveCurrentAcceptanceGatedGithubIssue,
  reviewJobCorrectionPacketId,
  resolveAcceptanceCriterionArtifact,
} from "../queries/change_records.js";
import { previewBootId } from "../queries/preview_boots.js";

const DB_AVAILABLE = await (async () => {
  try {
    const rows = Array.from(await db.execute(sql`
      SELECT to_regclass('public.change_record_events') IS NOT NULL
        AND to_regclass('public.acceptance_contracts') IS NOT NULL
        AND to_regclass('public.review_jobs') IS NOT NULL
        AND to_regclass('public.preview_boots') IS NOT NULL AS ready
    `)) as Array<{ ready: boolean }>;
    return rows[0]?.ready === true;
  } catch {
    return false;
  }
})();

const REPO = "acme/widgets";
const CRITERION_TEXT = "A user can save a filter";

function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function contract(criteriaCount: number, modality: "ui" | "api" | "data" | "job" = "ui"): Record<string, unknown> {
  return {
    originalRequest: "Add saved filters",
    normalizedRequirements: ["Users can save and reuse a filter"],
    acceptanceCriteria: Array.from({ length: criteriaCount }, (_, index) => ({
      id: `AC-${index + 1}`,
      text: index === 0 ? CRITERION_TEXT : `Criterion ${index + 1} is explicitly reviewed`,
      userVisible: modality === "ui",
      modality,
    })),
    nonGoals: [],
    risks: [],
    environment: { kind: "existing_preview" },
    stops: [],
    unresolvedQuestions: [],
  };
}

type BundleFixture = {
  workspaceId: string;
  recordId: string;
  contractId: string;
  jobId: string;
  prNumber: number;
  headSha: string;
  postedReviewUrl: string;
  artifactKey: string | null;
  artifactSha256: string | null;
  executionId: string | null;
  planEventKey: string;
  attemptEventKey: string | null;
  resultEventKey: string | null;
  reservationEventKey: string | null;
};

async function createBundleFixture(input: {
  workspaceId: string;
  workKey: string;
  prNumber: number;
  headSha: string;
  criteriaCount?: number;
  notTestable?: boolean;
  openPath?: string;
  contractModality?: "ui" | "api" | "data" | "job";
}): Promise<BundleFixture> {
  const criteriaCount = input.criteriaCount ?? 1;
  const draft = await createDraftAcceptanceRecord({
    workspaceId: input.workspaceId,
    repo: REPO,
    workKey: input.workKey,
    originChannel: "codex_mcp",
    contract: contract(criteriaCount, input.contractModality),
    createdBy: "user:r112b-test",
  });
  await db.update(acceptanceContracts).set({
    status: "confirmed",
    confirmedBy: "console_user:r112b-test",
    confirmedAt: new Date("2026-08-11T00:00:00.000Z"),
  }).where(eq(acceptanceContracts.id, draft.contract.id));
  const advanced = await advanceConfirmedAcceptanceRecordPullRequestHead({
    workspaceId: input.workspaceId,
    recordId: draft.record.id,
    repo: REPO,
    prNumber: input.prNumber,
    headSha: input.headSha,
    event: "opened",
    deliveryId: `${input.workKey}:opened`,
    admitReviewJob: true,
    headTransition: null,
    source: "github_webhook",
  });
  if (advanced.kind !== "advanced") throw new Error("expected exact current head");
  await db.update(reviewJobs).set({
    state: "running",
    claimedBy: "worker:r112b-test",
    claimedAt: new Date("2026-08-11T00:30:00.000Z"),
  }).where(eq(reviewJobs.id, advanced.jobId));
  const job = (await db.select().from(reviewJobs).where(eq(reviewJobs.id, advanced.jobId)))[0]!;
  let chronologyBase = job.createdAt.valueOf() + 1;

  const planEventKey = `verification:plan:${advanced.jobId}`;
  const plans = Array.from({ length: criteriaCount }, (_, index) => {
    const criterionId = `AC-${index + 1}`;
    const criterionTextSnapshot = index === 0
      ? CRITERION_TEXT : `Criterion ${index + 1} is explicitly reviewed`;
    return input.notTestable ? {
      criterionId,
      criterionTextSnapshot,
      modality: "ui",
      environmentKind: null,
      flow: null,
      uiSteps: null,
      apiRequest: null,
      dataRequest: null,
      status: "not_testable",
      notTestableReason: "No bounded exact-head browser flow exists for this criterion.",
    } : {
      criterionId,
      criterionTextSnapshot,
      modality: "ui",
      environmentKind: "isolated_preview",
      flow: "Open saved filters and verify the retained entry.",
      uiSteps: [
        { action: "open", path: input.openPath ?? "/filters/../filters?state=saved#result" },
        { action: "expect_text", text: "Saved filters" },
        { action: "screenshot", label: `saved-filter-${index + 1}` },
      ],
      apiRequest: null,
      dataRequest: null,
      status: "planned",
      notTestableReason: null,
    };
  });
  const planPayload = {
    kind: "review_job_verification_plan",
    jobId: advanced.jobId,
    workspaceId: input.workspaceId,
    repo: REPO,
    prNumber: input.prNumber,
    headSha: input.headSha,
    recordId: draft.record.id,
    acceptanceContractId: draft.contract.id,
    acceptanceContractVersion: draft.contract.version,
    plannedBy: "jace:r112b-test",
    plans,
  };
  const events: Array<{
    eventKey: string;
    stage: string;
    actor: string;
    payloadRef: Record<string, unknown>;
    at: Date;
  }> = [{
    eventKey: planEventKey,
    stage: "verification",
    actor: "jace:review-verification-planner",
    payloadRef: planPayload,
    at: new Date(chronologyBase),
  }];

  let artifactKey: string | null = null;
  let artifactSha256: string | null = null;
  let executionId: string | null = null;
  let attemptEventKey: string | null = null;
  let resultEventKey: string | null = null;
  let reservationEventKey: string | null = null;
  if (!input.notTestable) {
    const bootId = previewBootId({
      workspaceId: input.workspaceId,
      repo: REPO,
      prNumber: input.prNumber,
      headSha: input.headSha,
      cycleId: advanced.jobId,
    });
    const previewUrl = `http://preview-${input.prNumber}.r112b.test/`;
    const boot = (await db.insert(previewBoots).values({
      id: bootId,
      workspaceId: input.workspaceId,
      repo: REPO,
      prNumber: input.prNumber,
      headSha: input.headSha,
      ref: `refs/pull/${input.prNumber}/head`,
      status: "ready",
      url: previewUrl,
      port: 3100,
    }).returning())[0]!;
    chronologyBase = Math.max(chronologyBase, boot.createdAt.valueOf() + 1);
    events[0]!.at = new Date(chronologyBase);
    const plan = plans[0]!;
    const coordinate = sha({
      jobId: advanced.jobId,
      recordId: draft.record.id,
      headSha: input.headSha,
      acceptanceContractId: draft.contract.id,
      acceptanceContractVersion: draft.contract.version,
      criterionId: "AC-1",
    });
    const planDigest = sha({
      criterionId: plan.criterionId,
      criterionTextSnapshot: plan.criterionTextSnapshot,
      modality: plan.modality,
      environmentKind: plan.environmentKind,
      flow: plan.flow,
      status: plan.status,
      uiSteps: plan.uiSteps,
    });
    executionId = `ui-${sha({ coordinate, planDigest, previewBootId: bootId }).slice(0, 48)}`;
    attemptEventKey = `verification:ui-attempt:${advanced.jobId}:${coordinate.slice(0, 24)}`;
    resultEventKey = `verification:ui-result:${advanced.jobId}:${coordinate.slice(0, 24)}`;
    reservationEventKey = `verification:ui-screenshot:${advanced.jobId}:${coordinate.slice(0, 24)}`;
    const attempt = {
      kind: "review_job_ui_execution_attempt",
      executionId,
      jobId: advanced.jobId,
      workspaceId: input.workspaceId,
      repo: REPO,
      prNumber: input.prNumber,
      headSha: input.headSha,
      recordId: draft.record.id,
      acceptanceContractId: draft.contract.id,
      acceptanceContractVersion: draft.contract.version,
      criterionId: "AC-1",
      criterionTextSnapshot: CRITERION_TEXT,
      planDigest,
      previewBootId: bootId,
      previewUrl,
      uiSteps: plan.uiSteps,
    };
    artifactSha256 = "e".repeat(64);
    artifactKey = [
      "review-evidence",
      input.workspaceId,
      "acme__widgets",
      String(input.prNumber),
      input.headSha,
      `${executionId}-${artifactSha256.slice(0, 16)}`,
      "1.png",
    ].join("/");
    const result = {
      ...attempt,
      kind: "review_job_ui_execution_result",
      state: "proven",
      expected: CRITERION_TEXT,
      observed: "The deterministic browser observed the planned text \"Saved filters\" on the exact-head preview and retained the decisive screenshot.",
      evidenceRef: `review-ui-execution:${executionId}`,
      artifactKey,
      contentType: "image/png",
      contentSha256: artifactSha256,
      observedUrl: `${previewUrl}filters?state=saved`,
    };
    events.push(
      {
        eventKey: attemptEventKey,
        stage: "verification",
        actor: "jace:review-ui-executor",
        payloadRef: attempt,
        at: new Date(chronologyBase + 1),
      },
      {
        eventKey: reservationEventKey,
        stage: "verification",
        actor: "jace:review-ui-executor",
        payloadRef: { kind: "review_job_ui_screenshot_upload_reservation", result },
        at: new Date(chronologyBase + 2),
      },
      {
        eventKey: resultEventKey,
        stage: "verification",
        actor: "jace:review-ui-executor",
        payloadRef: result,
        at: new Date(chronologyBase + 3),
      },
    );
  }
  events.push({
    eventKey: `review:github-attempt:${advanced.jobId}`,
    stage: "review",
    actor: "reviewer-of-record",
    payloadRef: {
      kind: "review_job_github_post_attempt",
      jobId: advanced.jobId,
      workspaceId: input.workspaceId,
      repo: REPO,
      prNumber: input.prNumber,
      headSha: input.headSha,
      recordId: draft.record.id,
      acceptanceContractId: draft.contract.id,
      acceptanceContractVersion: draft.contract.version,
      outcomeDigest: "a".repeat(64),
      postPayloadDigest: "b".repeat(64),
    },
    at: new Date(chronologyBase + 4),
  });
  await appendCurrentReviewJobEventsAtomically({
    workspaceId: input.workspaceId,
    recordId: draft.record.id,
    jobId: advanced.jobId,
    repo: REPO,
    prNumber: input.prNumber,
    headSha: input.headSha,
    events,
  });
  return {
    workspaceId: input.workspaceId,
    recordId: draft.record.id,
    contractId: draft.contract.id,
    jobId: advanced.jobId,
    prNumber: input.prNumber,
    headSha: input.headSha,
    postedReviewUrl: `https://github.com/${REPO}/pull/${input.prNumber}#pullrequestreview-${input.prNumber}`,
    artifactKey,
    artifactSha256,
    executionId,
    planEventKey,
    attemptEventKey,
    resultEventKey,
    reservationEventKey,
  };
}

function exactCorrectionPacket(input: {
  fixture: BundleFixture;
  modality: "ui" | "api" | "data" | "job";
  state: "failed" | "not_proven";
  observed: string;
  flow: string;
  reproduction: Record<string, unknown>;
  evidenceRef: string;
  artifactKey?: string;
  executionId?: string;
  previewBootId: string;
}) {
  const packetId = reviewJobCorrectionPacketId({
    jobId: input.fixture.jobId,
    criterionId: "AC-1",
    headSha: input.fixture.headSha,
    recordId: input.fixture.recordId,
    acceptanceContractId: input.fixture.contractId,
    acceptanceContractVersion: 1,
  });
  return {
    kind: "review_job_correction_packet",
    version: 1,
    packetId,
    workspaceId: input.fixture.workspaceId,
    repo: REPO,
    prNumber: input.fixture.prNumber,
    headSha: input.fixture.headSha,
    recordId: input.fixture.recordId,
    jobId: input.fixture.jobId,
    acceptanceContract: { id: input.fixture.contractId, version: 1 },
    criterion: { id: "AC-1", snapshot: CRITERION_TEXT },
    basis: "acceptance_contract",
    state: input.state,
    expected: CRITERION_TEXT,
    observed: input.observed,
    affectedContext: {
      modality: input.modality,
      environmentKind: "isolated_preview",
      flow: input.flow,
      reproduction: input.reproduction,
    },
    evidence: input.artifactKey && input.executionId ? {
      evidenceRef: input.evidenceRef,
      artifactKey: input.artifactKey,
      executionId: input.executionId,
      previewBootId: input.previewBootId,
    } : {
      evidenceRef: input.evidenceRef,
      previewBootId: input.previewBootId,
    },
    scopeBoundary: `Only AC-1 for ${REPO}#${input.fixture.prNumber} at ${input.fixture.headSha}.`,
    impact: "The server-attested receipt does not prove the confirmed criterion on the exact head.",
    requiredCorrection: "Repair the bounded criterion and preserve exact-head evidence.",
    reverification: "Rerun the persisted verification plan against the next exact head.",
  };
}

async function replaceFixtureWithModality(
  fixture: BundleFixture,
  modality: "api" | "data" | "job",
): Promise<BundleFixture> {
  const existing = await db.select().from(changeRecordEvents).where(eq(
    changeRecordEvents.recordId, fixture.recordId,
  ));
  const planAt = existing.find((event) => event.eventKey === fixture.planEventKey)!.at;
  const postAt = existing.find((event) => event.eventKey === `review:github-attempt:${fixture.jobId}`)!.at;
  const boot = (await db.select().from(previewBoots).where(and(
    eq(previewBoots.workspaceId, fixture.workspaceId),
    eq(previewBoots.repo, REPO),
    eq(previewBoots.prNumber, fixture.prNumber),
    eq(previewBoots.headSha, fixture.headSha),
  )))[0]!;
  await db.delete(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, fixture.recordId),
    eq(changeRecordEvents.stage, "verification"),
  ));

  const flow = `Run the exact ${modality} verification descriptor.`;
  const dataRequest = {
    method: "GET",
    path: "/__agentrail/data/state",
    expectedStatus: 200,
    digestAlgorithm: "hmac-sha256-v1",
    digestKeyId: "r112b-key-1",
    digestContext: sha([
      fixture.workspaceId, fixture.recordId, fixture.jobId, fixture.headSha,
      fixture.contractId, 1, "AC-1", "/__agentrail/data/state", 200,
    ]),
    expectedJson: [{ pointer: "/state", equalsType: "string", equalsHmacSha256: "c".repeat(64) }],
  };
  const jobId = "save-filter";
  const jobRequest = {
    trigger: {
      method: "POST",
      path: `/__agentrail/verification/jobs/${jobId}/trigger`,
      expectedStatus: 202,
    },
    readback: {
      ...dataRequest,
      path: `/__agentrail/verification/jobs/${jobId}/result`,
      digestContext: sha([
        fixture.workspaceId, fixture.recordId, fixture.jobId, fixture.headSha,
        fixture.contractId, 1, "AC-1",
        `/__agentrail/verification/jobs/${jobId}/trigger`, 202,
        `/__agentrail/verification/jobs/${jobId}/result`, 200,
      ]),
    },
  };
  const apiRequest = { method: "GET", path: "/health", expectedStatus: 200 };
  const planField = modality === "api" ? "apiRequest" : modality === "data" ? "dataRequest" : "jobRequest";
  const descriptor = modality === "api" ? apiRequest : modality === "data" ? dataRequest : jobRequest;
  const plan: Record<string, unknown> = {
    criterionId: "AC-1",
    criterionTextSnapshot: CRITERION_TEXT,
    modality,
    environmentKind: "isolated_preview",
    flow,
    uiSteps: null,
    apiRequest: modality === "api" ? descriptor : null,
    dataRequest: modality === "data" ? descriptor : null,
    ...(modality === "job" ? { jobRequest: descriptor } : {}),
    status: "planned",
    notTestableReason: null,
  };
  const planPayload = {
    kind: "review_job_verification_plan",
    jobId: fixture.jobId,
    workspaceId: fixture.workspaceId,
    repo: REPO,
    prNumber: fixture.prNumber,
    headSha: fixture.headSha,
    recordId: fixture.recordId,
    acceptanceContractId: fixture.contractId,
    acceptanceContractVersion: 1,
    plannedBy: "jace:r112b-test",
    plans: [plan],
  };
  const planDigest = sha({
    criterionId: "AC-1",
    criterionTextSnapshot: CRITERION_TEXT,
    modality,
    environmentKind: "isolated_preview",
    flow,
    status: "planned",
    [planField]: descriptor,
  });
  const coordinate = sha({
    jobId: fixture.jobId,
    recordId: fixture.recordId,
    headSha: fixture.headSha,
    acceptanceContractId: fixture.contractId,
    acceptanceContractVersion: 1,
    criterionId: "AC-1",
  });
  const executionId = `${modality}-${sha({
    coordinate, planDigest, previewBootId: boot.id,
  }).slice(0, 48)}`;
  const attemptEventKey = `verification:${modality}-attempt:${fixture.jobId}:${coordinate.slice(0, 24)}`;
  const resultEventKey = `verification:${modality}-result:${fixture.jobId}:${coordinate.slice(0, 24)}`;
  const reservationEventKey = `verification:${modality}-card:${fixture.jobId}:${coordinate.slice(0, 24)}`;
  const attempt = {
    kind: modality === "api" ? "review_job_api_execution_attempt"
      : modality === "data" ? "review_job_data_execution_attempt" : "review_job_execution_attempt",
    executionId,
    jobId: fixture.jobId,
    workspaceId: fixture.workspaceId,
    repo: REPO,
    prNumber: fixture.prNumber,
    headSha: fixture.headSha,
    recordId: fixture.recordId,
    acceptanceContractId: fixture.contractId,
    acceptanceContractVersion: 1,
    criterionId: "AC-1",
    criterionTextSnapshot: CRITERION_TEXT,
    planDigest,
    previewBootId: boot.id,
    previewUrl: boot.url,
    [planField]: descriptor,
  };
  const contentSha256 = modality === "api" ? "a".repeat(64)
    : modality === "data" ? "d".repeat(64) : "f".repeat(64);
  const artifactKey = [
    "review-evidence", fixture.workspaceId, "acme__widgets", String(fixture.prNumber), fixture.headSha,
    `${executionId}-${contentSha256.slice(0, 16)}`, "1.json",
  ].join("/");
  const jobNotProven = modality === "job";
  const observed = modality === "api"
    ? "The safe GET /health returned the planned HTTP 200."
    : modality === "data"
      ? "The safe data GET /__agentrail/data/state returned HTTP 200; all 1 planned JSON scalar assertions matched."
      : `The safe job readback /__agentrail/verification/jobs/${jobId}/result returned HTTP 500; the planned status was 200.`;
  const result = {
    ...attempt,
    kind: modality === "api" ? "review_job_api_execution_result"
      : modality === "data" ? "review_job_data_execution_result" : "review_job_execution_result",
    state: jobNotProven ? "not_proven" : "proven",
    expected: CRITERION_TEXT,
    observed,
    ...(modality === "api" ? { observedStatus: 200 }
      : modality === "data" ? {
          observedStatus: 200,
          assertions: [{
            pointer: "/state", found: true, passed: true,
            observed: "[MATCH]", observedHmacSha256: "c".repeat(64),
          }],
        } : {
          observedTriggerStatus: 202,
          observedReadbackStatus: 500,
          assertions: [{
            pointer: "/state", found: false, passed: false,
            observed: null, observedHmacSha256: null,
          }],
        }),
    evidenceRef: `review-${modality}-execution:${executionId}`,
    artifactKey,
    contentSha256,
    contentType: "application/json",
  };
  const reservationKind = modality === "api" ? "review_job_api_card_upload_reservation"
    : modality === "data" ? "review_job_data_card_upload_reservation"
      : "review_job_card_upload_reservation";
  const verificationEvents = [
    {
      eventKey: fixture.planEventKey,
      stage: "verification",
      actor: "jace:review-verification-planner",
      payloadRef: planPayload,
      at: planAt,
    },
    {
      eventKey: attemptEventKey,
      stage: "verification",
      actor: `jace:review-${modality}-executor`,
      payloadRef: attempt,
      at: new Date(postAt.valueOf() - 3),
    },
    {
      eventKey: reservationEventKey,
      stage: "verification",
      actor: `jace:review-${modality}-executor`,
      payloadRef: { kind: reservationKind, result },
      at: new Date(postAt.valueOf() - 2),
    },
    {
      eventKey: resultEventKey,
      stage: "verification",
      actor: `jace:review-${modality}-executor`,
      payloadRef: result,
      at: new Date(postAt.valueOf() - 1),
    },
  ];
  if (jobNotProven) {
    verificationEvents.push({
      eventKey: `review:correction:${fixture.jobId}:AC-1`,
      stage: "review",
      actor: "reviewer-of-record",
      payloadRef: exactCorrectionPacket({
        fixture,
        modality,
        state: "not_proven",
        observed,
        flow,
        reproduction: { modality, request: jobRequest },
        evidenceRef: result.evidenceRef,
        artifactKey,
        executionId,
        previewBootId: boot.id,
      }),
      at: postAt,
    });
  }
  await appendCurrentReviewJobEventsAtomically({
    workspaceId: fixture.workspaceId,
    recordId: fixture.recordId,
    jobId: fixture.jobId,
    repo: REPO,
    prNumber: fixture.prNumber,
    headSha: fixture.headSha,
    events: verificationEvents,
  });
  fixture.artifactKey = artifactKey;
  fixture.artifactSha256 = contentSha256;
  fixture.executionId = executionId;
  fixture.attemptEventKey = attemptEventKey;
  fixture.resultEventKey = resultEventKey;
  fixture.reservationEventKey = reservationEventKey;
  return fixture;
}

async function makeUiFailure(fixture: BundleFixture): Promise<void> {
  const resultEvent = (await db.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, fixture.recordId),
    eq(changeRecordEvents.eventKey, fixture.resultEventKey!),
  )))[0]!;
  const observed = "The deterministic browser did not observe the planned text \"Saved filters\" on the exact-head preview; the failing state was retained as the decisive screenshot.";
  const result = { ...resultEvent.payloadRef, state: "failed", observed };
  await db.update(changeRecordEvents).set({ payloadRef: result }).where(eq(changeRecordEvents.id, resultEvent.id));
  const reservation = (await db.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, fixture.recordId),
    eq(changeRecordEvents.eventKey, fixture.reservationEventKey!),
  )))[0]!;
  await db.update(changeRecordEvents).set({
    payloadRef: { kind: "review_job_ui_screenshot_upload_reservation", result },
  }).where(eq(changeRecordEvents.id, reservation.id));
  const post = (await db.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, fixture.recordId),
    eq(changeRecordEvents.eventKey, `review:github-attempt:${fixture.jobId}`),
  )))[0]!;
  await appendChangeRecordEvent({
    recordId: fixture.recordId,
    eventKey: `review:correction:${fixture.jobId}:AC-1`,
    stage: "review",
    actor: "reviewer-of-record",
    at: post.at,
    payloadRef: exactCorrectionPacket({
      fixture,
      modality: "ui",
      state: "failed",
      observed,
      flow: "Open saved filters and verify the retained entry.",
      reproduction: {
        modality: "ui",
        steps: result["uiSteps"] as Record<string, unknown>[],
      },
      evidenceRef: result["evidenceRef"] as string,
      artifactKey: result["artifactKey"] as string,
      executionId: result["executionId"] as string,
      previewBootId: result["previewBootId"] as string,
    }),
  });
}

async function makePreviewFallback(fixture: BundleFixture, input: {
  modality?: "ui" | "api";
  flow?: string;
  reproduction?: Record<string, unknown>;
} = {}): Promise<void> {
  await db.delete(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, fixture.recordId),
    sql`${changeRecordEvents.eventKey} IN (
      ${fixture.attemptEventKey!}, ${fixture.reservationEventKey!}, ${fixture.resultEventKey!}
    )`,
  ));
  const post = (await db.select().from(changeRecordEvents).where(and(
    eq(changeRecordEvents.recordId, fixture.recordId),
    eq(changeRecordEvents.eventKey, `review:github-attempt:${fixture.jobId}`),
  )))[0]!;
  const boot = (await db.select().from(previewBoots).where(and(
    eq(previewBoots.workspaceId, fixture.workspaceId),
    eq(previewBoots.repo, REPO),
    eq(previewBoots.prNumber, fixture.prNumber),
    eq(previewBoots.headSha, fixture.headSha),
  )))[0]!;
  const modality = input.modality ?? "ui";
  const flow = input.flow ?? "Open saved filters and verify the retained entry.";
  const reproduction = input.reproduction ?? {
    modality: "ui",
    steps: [
      { action: "open", path: "/filters/../filters?state=saved#result" },
      { action: "expect_text", text: "Saved filters" },
      { action: "screenshot", label: "saved-filter-1" },
    ],
  };
  const observed = "The isolated exact-head preview became ready, but no server-custodied criterion execution receipt was recorded for this run; this criterion remains not proven.";
  await appendChangeRecordEvent({
    recordId: fixture.recordId,
    eventKey: `review:correction:${fixture.jobId}:AC-1`,
    stage: "review",
    actor: "reviewer-of-record",
    at: post.at,
    payloadRef: exactCorrectionPacket({
      fixture,
      modality,
      state: "not_proven",
      observed,
      flow,
      reproduction,
      evidenceRef: `preview-boot:${boot.id}`,
      previewBootId: boot.id,
    }),
  });
}

function writerInput(fixture: BundleFixture) {
  return {
    workspaceId: fixture.workspaceId,
    recordId: fixture.recordId,
    reviewJobId: fixture.jobId,
    postedReviewUrl: fixture.postedReviewUrl,
    inlineCommentsPosted: 0,
    commentsFolded: false,
  };
}

async function projectPostedJob(
  fixture: BundleFixture,
  verdict: "proven" | "not_testable" | "failed" | "not_proven" = "proven",
) {
  await db.update(reviewJobs).set({
    state: "posted",
    verdict,
    postedReviewUrl: fixture.postedReviewUrl,
  }).where(eq(reviewJobs.id, fixture.jobId));
}

describe.skipIf(!DB_AVAILABLE)("R11.2b criterion outcome bundle custody", () => {
  let workspaceId: string;

  beforeEach(async () => {
    workspaceId = (await db.insert(workspaces).values({
      name: "R11.2b criterion outcome bundle",
      slug: `r112b-${randomUUID()}`,
    }).returning({ id: workspaces.id }))[0]!.id;
  });

  afterEach(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  });

  it("requires the posted criterion bundle before deciding whether a gated issue applies", async () => {
    const fixture = await createBundleFixture({
      workspaceId,
      workKey: "gated-bundle-first",
      prNumber: 230,
      headSha: "a".repeat(40),
    });

    await expect(readCurrentAcceptanceGatedGithubIssue({ workspaceId, recordId: fixture.recordId }))
      .resolves.toEqual({ kind: "not_ready", reason: "criterion_outcome_bundle_not_recorded" });
    await expect(readAcceptanceRecordDetail({ workspaceId, recordId: fixture.recordId }))
      .resolves.toMatchObject({
        kind: "record",
        detail: {
          gatedIssue: { kind: "unavailable", reason: "criterion_outcome_bundle_not_recorded" },
        },
      });

    await recordPostedAcceptanceCriterionOutcomeBundle(writerInput(fixture));
    await projectPostedJob(fixture, "proven");
    await expect(readCurrentAcceptanceGatedGithubIssue({ workspaceId, recordId: fixture.recordId }))
      .resolves.toEqual({ kind: "not_ready", reason: "no_correction_packets" });
    await expect(readAcceptanceRecordDetail({ workspaceId, recordId: fixture.recordId }))
      .resolves.toMatchObject({
        kind: "record",
        detail: { gatedIssue: { kind: "not_applicable", reason: "no_correction_packets" } },
      });
  });

  it("reserves one no-label POST capability, withholds it on replay, and records an exact GitHub 201", async () => {
    const fixture = await createBundleFixture({
      workspaceId,
      workKey: "gated-published-failure",
      prNumber: 231,
      headSha: "b".repeat(40),
    });
    await makeUiFailure(fixture);
    await recordPostedAcceptanceCriterionOutcomeBundle(writerInput(fixture));
    await projectPostedJob(fixture, "failed");

    const current = await readCurrentAcceptanceGatedGithubIssue({ workspaceId, recordId: fixture.recordId });
    if (current.kind !== "current") throw new Error(`expected gated binding, got ${JSON.stringify(current)}`);
    expect(current.issue).toBeNull();
    await expect(readCurrentAcceptanceGatedGithubIssue({
      workspaceId: randomUUID(),
      recordId: fixture.recordId,
    })).resolves.toEqual({ kind: "not_found" });
    const memberId = randomUUID();
    await db.insert(workspaceMemberships).values({ workspaceId, userId: memberId, role: "member" });
    await expect(reserveCurrentAcceptanceGatedGithubIssue({
      workspaceId,
      recordId: fixture.recordId,
      bindingId: current.binding.bindingId,
      reservedBy: `user:${memberId}`,
    })).resolves.toEqual({ kind: "not_authorized" });
    expect(await db.select().from(acceptanceGatedGithubIssuePublications).where(eq(
      acceptanceGatedGithubIssuePublications.recordId,
      fixture.recordId,
    ))).toHaveLength(0);

    const ownerId = randomUUID();
    const adminId = randomUUID();
    await db.insert(workspaceMemberships).values([
      { workspaceId, userId: ownerId, role: "owner" },
      { workspaceId, userId: adminId, role: "admin" },
    ]);
    await db.update(workspaceMemberships).set({ role: "member" }).where(and(
      eq(workspaceMemberships.workspaceId, workspaceId),
      eq(workspaceMemberships.userId, ownerId),
    ));
    await expect(reserveCurrentAcceptanceGatedGithubIssue({
      workspaceId,
      recordId: fixture.recordId,
      bindingId: current.binding.bindingId,
      reservedBy: `user:${ownerId}`,
    })).resolves.toEqual({ kind: "not_authorized" });
    await db.update(workspaceMemberships).set({ role: "owner" }).where(and(
      eq(workspaceMemberships.workspaceId, workspaceId),
      eq(workspaceMemberships.userId, ownerId),
    ));
    const reserved = await reserveCurrentAcceptanceGatedGithubIssue({
      workspaceId,
      recordId: fixture.recordId,
      bindingId: current.binding.bindingId,
      reservedBy: `user:${ownerId}`,
    });
    if (reserved.kind !== "reserved") throw new Error(`expected reservation, got ${JSON.stringify(reserved)}`);
    expect(Object.keys(reserved.request).sort()).toEqual(["body", "title"]);
    expect(reserved.request).not.toHaveProperty("labels");
    expect(reserved.request.body).toContain("Required correction");
    expect(reserved.request.body).toContain("Evidence reference");
    expect(reserved.request.body).not.toContain("artifactKey");
    expect(reserved.request.body).not.toContain("executionId");
    expect(reserved.request.body).not.toContain("@");
    const packetEvent = (await db.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, fixture.recordId),
      eq(changeRecordEvents.eventKey, `review:correction:${fixture.jobId}:AC-1`),
    )))[0]!;
    const packetEvidence = packetEvent.payloadRef["evidence"] as Record<string, unknown>;
    const rawEvidenceRef = packetEvidence["evidenceRef"] as string;
    expect(reserved.request.body).toContain(createHash("sha256").update(rawEvidenceRef).digest("hex"));
    expect(reserved.request.body).not.toContain(rawEvidenceRef);
    expect(reserved.request.body).not.toContain(fixture.artifactKey!);
    expect(reserved.request.body).not.toContain(fixture.executionId!);
    expect(reserved.request.body).not.toContain(packetEvidence["previewBootId"] as string);

    await expect(reserveCurrentAcceptanceGatedGithubIssue({
      workspaceId,
      recordId: fixture.recordId,
      bindingId: current.binding.bindingId,
      reservedBy: `user:${adminId}`,
    })).resolves.toMatchObject({ kind: "held", issue: { id: reserved.issue.id, status: "reserved" } });

    const receipt = {
      kind: "github_201" as const,
      httpStatus: 201 as const,
      githubIssueId: "9001",
      githubIssueNumber: 77,
      githubApiUrl: `${"https://api.github.com/repos"}/${REPO}/issues/77`,
      githubIssueUrl: `${"https://github.com"}/${REPO}/issues/77`,
      githubRequestId: "req:exact-77",
      responseTitleSha256: createHash("sha256").update(reserved.request.title).digest("hex"),
      responseBodySha256: createHash("sha256").update(reserved.request.body).digest("hex"),
      state: "open" as const,
    };
    await expect(reportAcceptanceGatedGithubIssuePublication({
      workspaceId: randomUUID(),
      publicationId: reserved.issue.id,
      outcome: receipt,
    })).resolves.toEqual({ kind: "not_found" });
    await expect(reportAcceptanceGatedGithubIssuePublication({
      workspaceId,
      publicationId: reserved.issue.id,
      outcome: receipt,
    })).resolves.toMatchObject({
      kind: "reported",
      current: true,
      issue: { id: reserved.issue.id, status: "published", receipt },
    });
    await expect(reportAcceptanceGatedGithubIssuePublication({
      workspaceId,
      publicationId: reserved.issue.id,
      outcome: receipt,
    })).resolves.toMatchObject({ kind: "replayed", current: true });
    await expect(reportAcceptanceGatedGithubIssuePublication({
      workspaceId,
      publicationId: reserved.issue.id,
      outcome: { ...receipt, githubRequestId: "req:conflict" },
    })).rejects.toBeInstanceOf(AcceptanceGatedGithubIssueConflictError);
    await expect(reserveCurrentAcceptanceGatedGithubIssue({
      workspaceId,
      recordId: fixture.recordId,
      bindingId: current.binding.bindingId,
      reservedBy: `user:${ownerId}`,
    })).resolves.toMatchObject({ kind: "terminal", issue: { status: "published" } });

    const events = await db.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, fixture.recordId),
      eq(changeRecordEvents.stage, "gated_issue"),
    ));
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.actor).sort()).toEqual([
      "server:github-gated-issue",
      `user:${ownerId}`,
    ].sort());
    expect(JSON.stringify(events.map((event) => event.payloadRef))).not.toContain(reserved.request.title);
    expect(JSON.stringify(events.map((event) => event.payloadRef))).not.toContain(reserved.request.body);
  });

  it("retains a post-advance 201 only as historical audit custody and never revives A1 after A→B→A", async () => {
    const fixture = await createBundleFixture({
      workspaceId,
      workKey: "gated-a-b-a",
      prNumber: 232,
      headSha: "c".repeat(40),
    });
    await makeUiFailure(fixture);
    await recordPostedAcceptanceCriterionOutcomeBundle(writerInput(fixture));
    await projectPostedJob(fixture, "failed");
    const ownerId = randomUUID();
    await db.insert(workspaceMemberships).values({ workspaceId, userId: ownerId, role: "owner" });
    const currentA1 = await readCurrentAcceptanceGatedGithubIssue({ workspaceId, recordId: fixture.recordId });
    if (currentA1.kind !== "current") throw new Error("expected A1 binding");
    const reserved = await reserveCurrentAcceptanceGatedGithubIssue({
      workspaceId,
      recordId: fixture.recordId,
      bindingId: currentA1.binding.bindingId,
      reservedBy: `user:${ownerId}`,
    });
    if (reserved.kind !== "reserved") throw new Error("expected A1 reservation");

    const headB = "d".repeat(40);
    const advancedB = await advanceConfirmedAcceptanceRecordPullRequestHead({
      workspaceId,
      recordId: fixture.recordId,
      repo: REPO,
      prNumber: fixture.prNumber,
      headSha: headB,
      event: "synchronize",
      deliveryId: "gated-a-b-a:b",
      admitReviewJob: true,
      headTransition: { beforeHeadSha: fixture.headSha, afterHeadSha: headB },
      source: "github_webhook",
    });
    if (advancedB.kind !== "advanced") throw new Error("expected B");
    await expect(reserveCurrentAcceptanceGatedGithubIssue({
      workspaceId,
      recordId: fixture.recordId,
      bindingId: currentA1.binding.bindingId,
      reservedBy: `user:${ownerId}`,
    })).resolves.toEqual({ kind: "not_current" });

    const receipt = {
      kind: "github_201" as const,
      httpStatus: 201 as const,
      githubIssueId: "9002",
      githubIssueNumber: 78,
      githubApiUrl: `${"https://api.github.com/repos"}/${REPO}/issues/78`,
      githubIssueUrl: `${"https://github.com"}/${REPO}/issues/78`,
      githubRequestId: "req:historical-78",
      responseTitleSha256: createHash("sha256").update(reserved.request.title).digest("hex"),
      responseBodySha256: createHash("sha256").update(reserved.request.body).digest("hex"),
      state: "open" as const,
    };
    await expect(reportAcceptanceGatedGithubIssuePublication({
      workspaceId,
      publicationId: reserved.issue.id,
      outcome: receipt,
    })).resolves.toMatchObject({ kind: "reported", current: false, issue: { status: "published" } });

    const advancedA2 = await advanceConfirmedAcceptanceRecordPullRequestHead({
      workspaceId,
      recordId: fixture.recordId,
      repo: REPO,
      prNumber: fixture.prNumber,
      headSha: fixture.headSha,
      event: "synchronize",
      deliveryId: "gated-a-b-a:a2",
      admitReviewJob: true,
      headTransition: { beforeHeadSha: headB, afterHeadSha: fixture.headSha },
      source: "github_webhook",
    });
    if (advancedA2.kind !== "advanced") throw new Error("expected A2");
    expect(advancedA2.jobId).not.toBe(fixture.jobId);
    await expect(readCurrentAcceptanceGatedGithubIssue({ workspaceId, recordId: fixture.recordId }))
      .resolves.toEqual({ kind: "not_ready", reason: "criterion_outcome_bundle_not_recorded" });
    await expect(reserveCurrentAcceptanceGatedGithubIssue({
      workspaceId,
      recordId: fixture.recordId,
      bindingId: currentA1.binding.bindingId,
      reservedBy: `user:${ownerId}`,
    })).resolves.toEqual({ kind: "not_current" });
    expect(await db.select().from(acceptanceGatedGithubIssuePublications).where(eq(
      acceptanceGatedGithubIssuePublications.recordId,
      fixture.recordId,
    ))).toEqual([expect.objectContaining({
      id: reserved.issue.id,
      headCycleId: fixture.jobId,
      status: "published",
    })]);
  });

  it("terminalizes an ambiguous publication without exposing a second POST capability", async () => {
    const fixture = await createBundleFixture({
      workspaceId,
      workKey: "gated-ambiguous-hold",
      prNumber: 233,
      headSha: "e".repeat(40),
    });
    await makeUiFailure(fixture);
    await recordPostedAcceptanceCriterionOutcomeBundle(writerInput(fixture));
    await projectPostedJob(fixture, "failed");
    const ownerId = randomUUID();
    await db.insert(workspaceMemberships).values({ workspaceId, userId: ownerId, role: "owner" });
    const current = await readCurrentAcceptanceGatedGithubIssue({ workspaceId, recordId: fixture.recordId });
    if (current.kind !== "current") throw new Error("expected current gated issue binding");
    const reserved = await reserveCurrentAcceptanceGatedGithubIssue({
      workspaceId,
      recordId: fixture.recordId,
      bindingId: current.binding.bindingId,
      reservedBy: `user:${ownerId}`,
    });
    if (reserved.kind !== "reserved") throw new Error("expected reservation");
    const outcome = { kind: "ambiguous_hold" as const, reason: "ambiguous_response" as const };
    await expect(reportAcceptanceGatedGithubIssuePublication({
      workspaceId,
      publicationId: reserved.issue.id,
      outcome,
    })).resolves.toMatchObject({ kind: "reported", issue: { status: "ambiguous_hold", receipt: outcome } });
    await expect(reportAcceptanceGatedGithubIssuePublication({
      workspaceId,
      publicationId: reserved.issue.id,
      outcome,
    })).resolves.toMatchObject({ kind: "replayed", issue: { status: "ambiguous_hold" } });
    const terminal = await reserveCurrentAcceptanceGatedGithubIssue({
      workspaceId,
      recordId: fixture.recordId,
      bindingId: current.binding.bindingId,
      reservedBy: `user:${ownerId}`,
    });
    expect(terminal).toMatchObject({ kind: "terminal", issue: { id: reserved.issue.id } });
    expect(terminal).not.toHaveProperty("request");
    expect(await db.select().from(acceptanceGatedGithubIssuePublications).where(eq(
      acceptanceGatedGithubIssuePublications.recordId,
      fixture.recordId,
    ))).toHaveLength(1);
  });

  it("records one bounded GitHub rejection as terminal custody", async () => {
    const fixture = await createBundleFixture({
      workspaceId,
      workKey: "gated-bounded-failure",
      prNumber: 238,
      headSha: "9".repeat(40),
    });
    await makeUiFailure(fixture);
    await recordPostedAcceptanceCriterionOutcomeBundle(writerInput(fixture));
    await projectPostedJob(fixture, "failed");
    const ownerId = randomUUID();
    await db.insert(workspaceMemberships).values({ workspaceId, userId: ownerId, role: "owner" });
    const current = await readCurrentAcceptanceGatedGithubIssue({ workspaceId, recordId: fixture.recordId });
    if (current.kind !== "current") throw new Error("expected current binding");
    const reserved = await reserveCurrentAcceptanceGatedGithubIssue({
      workspaceId,
      recordId: fixture.recordId,
      bindingId: current.binding.bindingId,
      reservedBy: `user:${ownerId}`,
    });
    if (reserved.kind !== "reserved") throw new Error("expected reservation");
    const outcome = { kind: "bounded_failed" as const, reason: "github_rejected" as const };
    await expect(reportAcceptanceGatedGithubIssuePublication({
      workspaceId,
      publicationId: reserved.issue.id,
      outcome,
    })).resolves.toMatchObject({
      kind: "reported",
      current: true,
      issue: { status: "bounded_failed", receipt: outcome },
    });
    await expect(reserveCurrentAcceptanceGatedGithubIssue({
      workspaceId,
      recordId: fixture.recordId,
      bindingId: current.binding.bindingId,
      reservedBy: `user:${ownerId}`,
    })).resolves.toMatchObject({ kind: "terminal", issue: { id: reserved.issue.id } });
  });

  it("fails closed when immutable reservation or result events outlive a deleted publication row", async () => {
    for (const [index, terminal] of [false, true].entries()) {
      const fixture = await createBundleFixture({
        workspaceId,
        workKey: `gated-orphan-${terminal ? "result" : "reservation"}`,
        prNumber: 239 + index,
        headSha: (terminal ? "f" : "a").repeat(40),
      });
      await makeUiFailure(fixture);
      await recordPostedAcceptanceCriterionOutcomeBundle(writerInput(fixture));
      await projectPostedJob(fixture, "failed");
      const ownerId = randomUUID();
      await db.insert(workspaceMemberships).values({ workspaceId, userId: ownerId, role: "owner" });
      const current = await readCurrentAcceptanceGatedGithubIssue({ workspaceId, recordId: fixture.recordId });
      if (current.kind !== "current") throw new Error("expected current binding");
      const reserved = await reserveCurrentAcceptanceGatedGithubIssue({
        workspaceId,
        recordId: fixture.recordId,
        bindingId: current.binding.bindingId,
        reservedBy: `user:${ownerId}`,
      });
      if (reserved.kind !== "reserved") throw new Error("expected reservation");
      if (terminal) {
        await reportAcceptanceGatedGithubIssuePublication({
          workspaceId,
          publicationId: reserved.issue.id,
          outcome: { kind: "ambiguous_hold", reason: "github_unavailable" },
        });
      }
      expect(await db.select().from(changeRecordEvents).where(and(
        eq(changeRecordEvents.recordId, fixture.recordId),
        eq(changeRecordEvents.stage, "gated_issue"),
      ))).toHaveLength(terminal ? 2 : 1);
      await db.delete(acceptanceGatedGithubIssuePublications).where(eq(
        acceptanceGatedGithubIssuePublications.id,
        reserved.issue.id,
      ));
      await expect(readCurrentAcceptanceGatedGithubIssue({ workspaceId, recordId: fixture.recordId }))
        .resolves.toEqual({ kind: "not_ready", reason: "invalid_gated_issue_custody" });
    }
  });

  it("fails closed before reservation when packet or bundle custody is deleted or changed", async () => {
    for (const [index, corruption] of (["packet", "partial", "digest"] as const).entries()) {
      const fixture = await createBundleFixture({
        workspaceId,
        workKey: `gated-corruption-${corruption}`,
        prNumber: 234 + index,
        headSha: String(index + 1).repeat(40),
      });
      await makeUiFailure(fixture);
      await recordPostedAcceptanceCriterionOutcomeBundle(writerInput(fixture));
      await projectPostedJob(fixture, "failed");
      const before = await readCurrentAcceptanceGatedGithubIssue({ workspaceId, recordId: fixture.recordId });
      if (before.kind !== "current") throw new Error(`expected binding before ${corruption}`);

      if (corruption === "partial") {
        await db.delete(changeRecordEvents).where(and(
          eq(changeRecordEvents.recordId, fixture.recordId),
          eq(changeRecordEvents.eventKey, `review:correction:${fixture.jobId}:AC-1`),
        ));
      } else {
        const eventKey = corruption === "packet"
          ? `review:correction:${fixture.jobId}:AC-1`
          : `review:github-posted:${fixture.jobId}`;
        const event = (await db.select().from(changeRecordEvents).where(and(
          eq(changeRecordEvents.recordId, fixture.recordId),
          eq(changeRecordEvents.eventKey, eventKey),
        )))[0]!;
        await db.update(changeRecordEvents).set({
          payloadRef: corruption === "packet"
            ? { ...event.payloadRef, observed: "Changed after immutable publication." }
            : { ...event.payloadRef, criterionOutcomeBundleSha256: "f".repeat(64) },
        }).where(eq(changeRecordEvents.id, event.id));
      }

      await expect(readCurrentAcceptanceGatedGithubIssue({ workspaceId, recordId: fixture.recordId }))
        .resolves.toMatchObject({ kind: "not_ready" });
      const ownerId = randomUUID();
      await db.insert(workspaceMemberships).values({ workspaceId, userId: ownerId, role: "owner" });
      await expect(reserveCurrentAcceptanceGatedGithubIssue({
        workspaceId,
        recordId: fixture.recordId,
        bindingId: before.binding.bindingId,
        reservedBy: `user:${ownerId}`,
      })).resolves.toMatchObject({ kind: "not_ready" });
      expect(await db.select().from(acceptanceGatedGithubIssuePublications).where(eq(
        acceptanceGatedGithubIssuePublications.recordId,
        fixture.recordId,
      ))).toHaveLength(0);
    }
  });

  it("linearizes reservation against head advance without binding A custody to B", async () => {
    const fixture = await createBundleFixture({
      workspaceId,
      workKey: "gated-head-race",
      prNumber: 237,
      headSha: "7".repeat(40),
    });
    await makeUiFailure(fixture);
    await recordPostedAcceptanceCriterionOutcomeBundle(writerInput(fixture));
    await projectPostedJob(fixture, "failed");
    const ownerId = randomUUID();
    await db.insert(workspaceMemberships).values({ workspaceId, userId: ownerId, role: "owner" });
    const current = await readCurrentAcceptanceGatedGithubIssue({ workspaceId, recordId: fixture.recordId });
    if (current.kind !== "current") throw new Error("expected current binding");
    const headB = "8".repeat(40);
    const [reservation, advance] = await Promise.all([
      reserveCurrentAcceptanceGatedGithubIssue({
        workspaceId,
        recordId: fixture.recordId,
        bindingId: current.binding.bindingId,
        reservedBy: `user:${ownerId}`,
      }),
      advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId,
        recordId: fixture.recordId,
        repo: REPO,
        prNumber: fixture.prNumber,
        headSha: headB,
        event: "synchronize",
        deliveryId: "gated-head-race:b",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: fixture.headSha, afterHeadSha: headB },
        source: "github_webhook",
      }),
    ]);
    expect(advance).toMatchObject({ kind: "advanced" });
    expect(["reserved", "not_current"]).toContain(reservation.kind);
    const rows = await db.select().from(acceptanceGatedGithubIssuePublications).where(eq(
      acceptanceGatedGithubIssuePublications.recordId,
      fixture.recordId,
    ));
    if (reservation.kind === "reserved") {
      expect(rows).toEqual([expect.objectContaining({
        id: reservation.issue.id,
        headSha: fixture.headSha,
        headCycleId: fixture.jobId,
      })]);
    } else {
      expect(rows).toHaveLength(0);
    }
    expect(rows.some((row) => row.headSha === headB)).toBe(false);
    await expect(readCurrentAcceptanceGatedGithubIssue({ workspaceId, recordId: fixture.recordId }))
      .resolves.toEqual({ kind: "not_ready", reason: "criterion_outcome_bundle_not_recorded" });
  });

  it("atomically records, replays, and resolves one exact current bundle without exposing its object key", async () => {
    const fixture = await createBundleFixture({
      workspaceId,
      workKey: "atomic-current",
      prNumber: 201,
      headSha: "1".repeat(40),
    });
    const first = await recordPostedAcceptanceCriterionOutcomeBundle(writerInput(fixture));
    expect(first).toMatchObject({ kind: "recorded", current: true });
    if (first.kind !== "recorded") throw new Error("expected recorded bundle");
    expect(first.bundle.outcomes).toEqual([expect.objectContaining({
      criterionId: "AC-1",
      state: "proven",
      evidence: expect.objectContaining({
        kind: "execution_receipt",
        artifact: expect.objectContaining({
          artifactId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
          contentType: "image/png",
          contentSha256: fixture.artifactSha256,
        }),
      }),
    })]);
    expect(JSON.stringify(first.bundle)).not.toContain(fixture.artifactKey);
    const pair = await db.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, fixture.recordId),
      sql`${changeRecordEvents.eventKey} IN (
        ${`review:github-posted:${fixture.jobId}`},
        ${`review:criterion-outcomes:${fixture.jobId}`}
      )`,
    ));
    expect(pair).toHaveLength(2);
    expect(pair[0]!.at.valueOf()).toBe(pair[1]!.at.valueOf());
    const attestation = pair.find((event) => event.eventKey.startsWith("review:github-posted:"))!;
    expect(attestation.payloadRef["criterionOutcomeBundleSha256"]).toBe(first.bundle.sha256);

    await expect(recordPostedAcceptanceCriterionOutcomeBundle(writerInput(fixture)))
      .resolves.toMatchObject({ kind: "replayed", current: true, bundle: { id: first.bundle.id } });
    await expect(recordPostedAcceptanceCriterionOutcomeBundle({
      ...writerInput(fixture), inlineCommentsPosted: 1,
    })).rejects.toBeInstanceOf(AcceptanceCriterionOutcomeBundleConflictError);

    await projectPostedJob(fixture);
    const current = await readCurrentAcceptanceCriterionOutcomeBundle({ workspaceId, recordId: fixture.recordId });
    expect(current).toMatchObject({ kind: "current", bundle: { id: first.bundle.id } });
    if (current.kind !== "current") throw new Error("expected current bundle");
    const artifactId = current.bundle.outcomes[0]!.evidence.kind === "execution_receipt"
      ? current.bundle.outcomes[0]!.evidence.artifact?.artifactId : null;
    if (!artifactId) throw new Error("expected opaque artifact id");
    await expect(resolveAcceptanceCriterionArtifact({ workspaceId, recordId: fixture.recordId, artifactId }))
      .resolves.toEqual({
        kind: "resolved",
        artifact: {
          artifactId,
          contentType: "image/png",
          contentSha256: fixture.artifactSha256,
          artifactKey: fixture.artifactKey,
        },
      });
    await expect(resolveAcceptanceCriterionArtifact({
      workspaceId, recordId: fixture.recordId, artifactId: randomUUID(),
    })).resolves.toEqual({ kind: "artifact_not_found" });
    await expect(resolveAcceptanceCriterionArtifact({
      workspaceId: randomUUID(), recordId: fixture.recordId, artifactId,
    })).resolves.toEqual({ kind: "not_found" });
    await expect(readCurrentAcceptanceCriterionOutcomeBundle({
      workspaceId: randomUUID(), recordId: fixture.recordId,
    })).resolves.toEqual({ kind: "not_found" });

    await expect(readCurrentAcceptancePrDecision({ workspaceId, recordId: fixture.recordId }))
      .resolves.toMatchObject({ kind: "current", decision: null });
    await expect(readAcceptancePrReviewMetrics({ workspaceId, recordId: fixture.recordId }))
      .resolves.toMatchObject({ kind: "record" });
    const detail = await readAcceptanceRecordDetail({ workspaceId, recordId: fixture.recordId });
    expect(detail).toMatchObject({ kind: "record" });
  });

  it("rederives exact API, data, job-not-proven, and UI-failed receipts with closed artifact rules", async () => {
    for (const [index, modality] of (["api", "data", "job"] as const).entries()) {
      const fixture = await replaceFixtureWithModality(await createBundleFixture({
        workspaceId,
        workKey: `modality-${modality}`,
        prNumber: 210 + index,
        headSha: String(index + 1).repeat(40),
        contractModality: modality,
      }), modality);
      const result = await recordPostedAcceptanceCriterionOutcomeBundle(writerInput(fixture));
      if (result.kind !== "recorded") {
        throw new Error(`expected ${modality} bundle, received ${JSON.stringify(result)}`);
      }
      expect(result).toMatchObject({ kind: "recorded", current: true });
      const outcome = result.bundle.outcomes[0]!;
      expect(outcome.evidence).toMatchObject({
        kind: "execution_receipt",
        modality,
        executionId: fixture.executionId,
      });
      if (outcome.evidence.kind !== "execution_receipt") throw new Error("expected receipt evidence");
      if (modality === "job") {
        expect(outcome).toMatchObject({ state: "not_proven" });
        expect(outcome.evidence.artifact).toBeNull();
      } else {
        expect(outcome).toMatchObject({ state: "proven" });
        expect(outcome.evidence.artifact).toMatchObject({
          contentType: "application/json",
          contentSha256: fixture.artifactSha256,
        });
      }
    }

    const failed = await createBundleFixture({
      workspaceId, workKey: "ui-failed", prNumber: 213, headSha: "4".repeat(40),
    });
    await makeUiFailure(failed);
    const failedResult = await recordPostedAcceptanceCriterionOutcomeBundle(writerInput(failed));
    expect(failedResult).toMatchObject({
      kind: "recorded",
      bundle: { outcomes: [{ state: "failed", evidence: { artifact: { contentType: "image/png" } } }] },
    });

    const fallback = await createBundleFixture({
      workspaceId, workKey: "preview-fallback", prNumber: 219, headSha: "6".repeat(40),
    });
    await makePreviewFallback(fallback);
    const fallbackResult = await recordPostedAcceptanceCriterionOutcomeBundle(writerInput(fallback));
    expect(fallbackResult).toMatchObject({
      kind: "recorded",
      bundle: { outcomes: [{ state: "not_proven", evidence: { kind: "preview_receipt" } }] },
    });
    if (fallbackResult.kind !== "recorded") throw new Error("expected preview fallback bundle");
    expect("artifact" in fallbackResult.bundle.outcomes[0]!.evidence).toBe(false);

    const lateFallback = await createBundleFixture({
      workspaceId, workKey: "late-preview-fallback", prNumber: 220, headSha: "7".repeat(40),
    });
    await makePreviewFallback(lateFallback);
    const latePost = (await db.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, lateFallback.recordId),
      eq(changeRecordEvents.eventKey, `review:github-attempt:${lateFallback.jobId}`),
    )))[0]!;
    await db.update(previewBoots).set({
      createdAt: new Date(latePost.at.valueOf() + 1),
    }).where(and(
      eq(previewBoots.workspaceId, workspaceId),
      eq(previewBoots.prNumber, lateFallback.prNumber),
    ));
    await expect(recordPostedAcceptanceCriterionOutcomeBundle(writerInput(lateFallback)))
      .resolves.toEqual({ kind: "not_ready", reason: "invalid_criterion_outcome_custody" });

    const mismatchedCorrection = await replaceFixtureWithModality(await createBundleFixture({
      workspaceId, workKey: "job-correction-mismatch", prNumber: 214, headSha: "5".repeat(40),
      contractModality: "job",
    }), "job");
    const packet = (await db.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, mismatchedCorrection.recordId),
      eq(changeRecordEvents.eventKey, `review:correction:${mismatchedCorrection.jobId}:AC-1`),
    )))[0]!;
    await db.update(changeRecordEvents).set({
      payloadRef: { ...packet.payloadRef, observed: "A different observation." },
    }).where(eq(changeRecordEvents.id, packet.id));
    await expect(recordPostedAcceptanceCriterionOutcomeBundle(writerInput(mismatchedCorrection)))
      .resolves.toEqual({ kind: "not_ready", reason: "invalid_criterion_outcome_custody" });
  });

  it("fails closed when member-visible plan or correction text is secret-shaped", async () => {
    const unsafePlan = await createBundleFixture({
      workspaceId,
      workKey: "secret-shaped-plan",
      prNumber: 228,
      headSha: "a".repeat(40),
      notTestable: true,
    });
    const planEvent = (await db.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, unsafePlan.recordId),
      eq(changeRecordEvents.eventKey, unsafePlan.planEventKey),
    )))[0]!;
    const planPayload = structuredClone(planEvent.payloadRef);
    (planPayload["plans"] as Record<string, unknown>[])[0]!["notTestableReason"] =
      "authorization: Bearer abcdefghijklmnopqrstuvwxyz";
    await db.update(changeRecordEvents).set({ payloadRef: planPayload })
      .where(eq(changeRecordEvents.id, planEvent.id));
    await expect(recordPostedAcceptanceCriterionOutcomeBundle(writerInput(unsafePlan)))
      .resolves.toEqual({ kind: "not_ready", reason: "invalid_criterion_outcome_custody" });

    const safePlan = await createBundleFixture({
      workspaceId,
      workKey: "ordinary-plan-prose",
      prNumber: 229,
      headSha: "b".repeat(40),
      notTestable: true,
    });
    await expect(recordPostedAcceptanceCriterionOutcomeBundle(writerInput(safePlan)))
      .resolves.toMatchObject({
        kind: "recorded",
        bundle: { outcomes: [{
          state: "not_testable",
          observed: "No bounded exact-head browser flow exists for this criterion.",
        }] },
      });

    const unsafeCorrection = await replaceFixtureWithModality(await createBundleFixture({
      workspaceId,
      workKey: "secret-shaped-correction",
      prNumber: 230,
      headSha: "c".repeat(40),
      contractModality: "job",
    }), "job");
    const correctionEvent = (await db.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, unsafeCorrection.recordId),
      eq(changeRecordEvents.eventKey, `review:correction:${unsafeCorrection.jobId}:AC-1`),
    )))[0]!;
    await db.update(changeRecordEvents).set({
      payloadRef: {
        ...correctionEvent.payloadRef,
        requiredCorrection: "Replace token=abcdefghijk12345 before retrying.",
      },
    }).where(eq(changeRecordEvents.id, correctionEvent.id));
    await expect(recordPostedAcceptanceCriterionOutcomeBundle(writerInput(unsafeCorrection)))
      .resolves.toEqual({ kind: "not_ready", reason: "invalid_criterion_outcome_custody" });
    await expect(readAcceptanceRecordDetail({
      workspaceId,
      recordId: unsafeCorrection.recordId,
    })).resolves.toEqual({ kind: "unavailable", reason: "invalid_review_custody" });
  });

  it("does not project secret-shaped confirmed Contract text from an unattached Record", async () => {
    const draft = await createDraftAcceptanceRecord({
      workspaceId,
      repo: REPO,
      workKey: "unattached-secret-contract",
      originChannel: "codex_mcp",
      contract: {
        ...contract(1),
        originalRequest: "api_key=abcdefghijk12345",
        environment: { authorization: "abcdefghijk12345" },
      },
      createdBy: "user:r112-secret-test",
    });
    await db.update(acceptanceContracts).set({
      status: "confirmed",
      confirmedBy: "console_user:r112-secret-test",
      confirmedAt: new Date("2026-08-11T03:00:00.000Z"),
    }).where(eq(acceptanceContracts.id, draft.contract.id));

    await expect(readAcceptanceRecordDetail({
      workspaceId,
      recordId: draft.record.id,
    })).resolves.toEqual({
      kind: "unavailable",
      reason: "confirmed_contract_unavailable",
    });
  });

  it("keeps legacy UI and API plans readable without admitting unknown plan fields", async () => {
    const legacyUi = await createBundleFixture({
      workspaceId, workKey: "legacy-ui-plan", prNumber: 225, headSha: "4".repeat(40),
    });
    await makePreviewFallback(legacyUi);
    const legacyUiPlan = (await db.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, legacyUi.recordId),
      eq(changeRecordEvents.eventKey, legacyUi.planEventKey),
    )))[0]!;
    const legacyUiPayload = structuredClone(legacyUiPlan.payloadRef);
    delete (legacyUiPayload["plans"] as Record<string, unknown>[])[0]!["uiSteps"];
    await db.update(changeRecordEvents).set({ payloadRef: legacyUiPayload })
      .where(eq(changeRecordEvents.id, legacyUiPlan.id));
    await expect(recordPostedAcceptanceCriterionOutcomeBundle(writerInput(legacyUi)))
      .resolves.toMatchObject({
        kind: "recorded",
        bundle: { outcomes: [{ state: "not_proven", evidence: { kind: "preview_receipt" } }] },
      });

    const legacyApi = await replaceFixtureWithModality(await createBundleFixture({
      workspaceId, workKey: "legacy-api-plan", prNumber: 226, headSha: "5".repeat(40),
      contractModality: "api",
    }), "api");
    const apiFlow = "Run the exact api verification descriptor.";
    await makePreviewFallback(legacyApi, {
      modality: "api",
      flow: apiFlow,
      reproduction: {
        modality: "api",
        request: { method: "GET", path: "/health", expectedStatus: 200 },
      },
    });
    const legacyApiPlan = (await db.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, legacyApi.recordId),
      eq(changeRecordEvents.eventKey, legacyApi.planEventKey),
    )))[0]!;
    const legacyApiPayload = structuredClone(legacyApiPlan.payloadRef);
    delete (legacyApiPayload["plans"] as Record<string, unknown>[])[0]!["apiRequest"];
    await db.update(changeRecordEvents).set({ payloadRef: legacyApiPayload })
      .where(eq(changeRecordEvents.id, legacyApiPlan.id));
    await expect(recordPostedAcceptanceCriterionOutcomeBundle(writerInput(legacyApi)))
      .resolves.toMatchObject({
        kind: "recorded",
        bundle: { outcomes: [{ state: "not_proven", evidence: { kind: "preview_receipt" } }] },
      });

    const unknownField = await createBundleFixture({
      workspaceId, workKey: "legacy-plan-unknown-field", prNumber: 227, headSha: "6".repeat(40),
    });
    await makePreviewFallback(unknownField);
    const unknownFieldPlan = (await db.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, unknownField.recordId),
      eq(changeRecordEvents.eventKey, unknownField.planEventKey),
    )))[0]!;
    const unknownFieldPayload = structuredClone(unknownFieldPlan.payloadRef);
    const unknownPlan = (unknownFieldPayload["plans"] as Record<string, unknown>[])[0]!;
    delete unknownPlan["uiSteps"];
    unknownPlan["unexpectedAuthority"] = true;
    await db.update(changeRecordEvents).set({ payloadRef: unknownFieldPayload })
      .where(eq(changeRecordEvents.id, unknownFieldPlan.id));
    await expect(recordPostedAcceptanceCriterionOutcomeBundle(writerInput(unknownField)))
      .resolves.toEqual({ kind: "not_ready", reason: "invalid_criterion_outcome_custody" });
  });

  it("fails closed for a partial pair, malformed plan/attempt/result, or altered attestation digest", async () => {
    const partial = await createBundleFixture({
      workspaceId, workKey: "partial-pair", prNumber: 202, headSha: "2".repeat(40),
    });
    const recorded = await recordPostedAcceptanceCriterionOutcomeBundle(writerInput(partial));
    expect(recorded.kind).toBe("recorded");
    await db.delete(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, partial.recordId),
      eq(changeRecordEvents.eventKey, `review:criterion-outcomes:${partial.jobId}`),
    ));
    await expect(recordPostedAcceptanceCriterionOutcomeBundle(writerInput(partial)))
      .rejects.toBeInstanceOf(AcceptanceCriterionOutcomeBundleConflictError);

    const malformedPlan = await createBundleFixture({
      workspaceId, workKey: "malformed-plan", prNumber: 203, headSha: "3".repeat(40),
    });
    const plan = (await db.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, malformedPlan.recordId),
      eq(changeRecordEvents.eventKey, malformedPlan.planEventKey),
    )))[0]!;
    const planPayload = structuredClone(plan.payloadRef);
    ((planPayload["plans"] as Record<string, unknown>[])[0]!["uiSteps"] as Record<string, unknown>[])[0] = {
      action: "open", path: "\\\\evil.example\\share",
    };
    await db.update(changeRecordEvents).set({ payloadRef: planPayload }).where(eq(changeRecordEvents.id, plan.id));
    await expect(recordPostedAcceptanceCriterionOutcomeBundle(writerInput(malformedPlan)))
      .resolves.toEqual({ kind: "not_ready", reason: "invalid_criterion_outcome_custody" });

    const missingAttempt = await createBundleFixture({
      workspaceId, workKey: "missing-attempt", prNumber: 204, headSha: "4".repeat(40),
    });
    await db.delete(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, missingAttempt.recordId),
      eq(changeRecordEvents.eventKey, missingAttempt.attemptEventKey!),
    ));
    await expect(recordPostedAcceptanceCriterionOutcomeBundle(writerInput(missingAttempt)))
      .resolves.toEqual({ kind: "not_ready", reason: "invalid_criterion_outcome_custody" });

    const wrongArtifact = await createBundleFixture({
      workspaceId, workKey: "wrong-artifact-key", prNumber: 205, headSha: "5".repeat(40),
    });
    const result = (await db.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, wrongArtifact.recordId),
      eq(changeRecordEvents.eventKey, wrongArtifact.resultEventKey!),
    )))[0]!;
    const wrongResult = { ...result.payloadRef, artifactKey: `${wrongArtifact.artifactKey}-wrong` };
    await db.update(changeRecordEvents).set({ payloadRef: wrongResult }).where(eq(changeRecordEvents.id, result.id));
    const reservation = (await db.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, wrongArtifact.recordId),
      eq(changeRecordEvents.eventKey, wrongArtifact.reservationEventKey!),
    )))[0]!;
    await db.update(changeRecordEvents).set({
      payloadRef: { kind: "review_job_ui_screenshot_upload_reservation", result: wrongResult },
    }).where(eq(changeRecordEvents.id, reservation.id));
    await expect(recordPostedAcceptanceCriterionOutcomeBundle(writerInput(wrongArtifact)))
      .resolves.toEqual({ kind: "not_ready", reason: "invalid_criterion_outcome_custody" });

    const wrongObservation = await replaceFixtureWithModality(await createBundleFixture({
      workspaceId, workKey: "wrong-observed-status", prNumber: 215, headSha: "a".repeat(40),
      contractModality: "api",
    }), "api");
    const apiResult = (await db.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, wrongObservation.recordId),
      eq(changeRecordEvents.eventKey, wrongObservation.resultEventKey!),
    )))[0]!;
    const driftedResult = { ...apiResult.payloadRef, observedStatus: 500 };
    await db.update(changeRecordEvents).set({ payloadRef: driftedResult }).where(eq(changeRecordEvents.id, apiResult.id));
    const apiReservation = (await db.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, wrongObservation.recordId),
      eq(changeRecordEvents.eventKey, wrongObservation.reservationEventKey!),
    )))[0]!;
    await db.update(changeRecordEvents).set({
      payloadRef: { kind: "review_job_api_card_upload_reservation", result: driftedResult },
    }).where(eq(changeRecordEvents.id, apiReservation.id));
    await expect(recordPostedAcceptanceCriterionOutcomeBundle(writerInput(wrongObservation)))
      .resolves.toEqual({ kind: "not_ready", reason: "invalid_criterion_outcome_custody" });

    const missingReservation = await createBundleFixture({
      workspaceId, workKey: "missing-reservation", prNumber: 216, headSha: "b".repeat(40),
    });
    await db.delete(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, missingReservation.recordId),
      eq(changeRecordEvents.eventKey, missingReservation.reservationEventKey!),
    ));
    await expect(recordPostedAcceptanceCriterionOutcomeBundle(writerInput(missingReservation)))
      .resolves.toEqual({ kind: "not_ready", reason: "invalid_criterion_outcome_custody" });

    const mismatchedReservation = await createBundleFixture({
      workspaceId, workKey: "mismatched-reservation", prNumber: 221, headSha: "f".repeat(40),
    });
    const mismatchedReservationEvent = (await db.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, mismatchedReservation.recordId),
      eq(changeRecordEvents.eventKey, mismatchedReservation.reservationEventKey!),
    )))[0]!;
    const reservedResult = structuredClone(
      mismatchedReservationEvent.payloadRef["result"] as Record<string, unknown>,
    );
    reservedResult["observed"] = "A different reserved result.";
    await db.update(changeRecordEvents).set({
      payloadRef: {
        kind: "review_job_ui_screenshot_upload_reservation",
        result: reservedResult,
      },
    }).where(eq(changeRecordEvents.id, mismatchedReservationEvent.id));
    await expect(recordPostedAcceptanceCriterionOutcomeBundle(writerInput(mismatchedReservation)))
      .resolves.toEqual({ kind: "not_ready", reason: "invalid_criterion_outcome_custody" });

    const afterPost = await createBundleFixture({
      workspaceId, workKey: "result-after-post", prNumber: 217, headSha: "c".repeat(40),
    });
    const postAttempt = (await db.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, afterPost.recordId),
      eq(changeRecordEvents.eventKey, `review:github-attempt:${afterPost.jobId}`),
    )))[0]!;
    await db.update(changeRecordEvents).set({
      at: new Date(postAttempt.at.valueOf() + 1),
    }).where(and(
      eq(changeRecordEvents.recordId, afterPost.recordId),
      eq(changeRecordEvents.eventKey, afterPost.resultEventKey!),
    ));
    await expect(recordPostedAcceptanceCriterionOutcomeBundle(writerInput(afterPost)))
      .resolves.toEqual({ kind: "not_ready", reason: "invalid_criterion_outcome_custody" });

    const backdatedExecution = await createBundleFixture({
      workspaceId, workKey: "execution-before-plan", prNumber: 224, headSha: "3".repeat(40),
    });
    const backdatedPlan = (await db.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, backdatedExecution.recordId),
      eq(changeRecordEvents.eventKey, backdatedExecution.planEventKey),
    )))[0]!;
    const backdatedReservation = (await db.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, backdatedExecution.recordId),
      eq(changeRecordEvents.eventKey, backdatedExecution.reservationEventKey!),
    )))[0]!;
    await db.update(changeRecordEvents).set({
      at: backdatedReservation.at,
    }).where(eq(changeRecordEvents.id, backdatedPlan.id));
    await expect(recordPostedAcceptanceCriterionOutcomeBundle(writerInput(backdatedExecution)))
      .resolves.toEqual({ kind: "not_ready", reason: "invalid_criterion_outcome_custody" });

    const badDataPlan = await replaceFixtureWithModality(await createBundleFixture({
      workspaceId, workKey: "duplicate-data-pointer", prNumber: 222, headSha: "1".repeat(40),
      contractModality: "data",
    }), "data");
    const badDataPlanEvent = (await db.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, badDataPlan.recordId),
      eq(changeRecordEvents.eventKey, badDataPlan.planEventKey),
    )))[0]!;
    const badDataPayload = structuredClone(badDataPlanEvent.payloadRef);
    const storedDataRequest = (badDataPayload["plans"] as Record<string, unknown>[])[0]!["dataRequest"] as Record<string, unknown>;
    storedDataRequest["expectedJson"] = [
      ...(storedDataRequest["expectedJson"] as Record<string, unknown>[]),
      structuredClone((storedDataRequest["expectedJson"] as Record<string, unknown>[])[0]!),
    ];
    await db.update(changeRecordEvents).set({ payloadRef: badDataPayload })
      .where(eq(changeRecordEvents.id, badDataPlanEvent.id));
    await expect(recordPostedAcceptanceCriterionOutcomeBundle(writerInput(badDataPlan)))
      .resolves.toEqual({ kind: "not_ready", reason: "invalid_criterion_outcome_custody" });

    const badJobPlan = await replaceFixtureWithModality(await createBundleFixture({
      workspaceId, workKey: "arbitrary-job-path", prNumber: 223, headSha: "2".repeat(40),
      contractModality: "job",
    }), "job");
    const badJobPlanEvent = (await db.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, badJobPlan.recordId),
      eq(changeRecordEvents.eventKey, badJobPlan.planEventKey),
    )))[0]!;
    const badJobPayload = structuredClone(badJobPlanEvent.payloadRef);
    const storedJobRequest = (badJobPayload["plans"] as Record<string, unknown>[])[0]!["jobRequest"] as Record<string, unknown>;
    (storedJobRequest["trigger"] as Record<string, unknown>)["path"] = "/arbitrary/mutation";
    await db.update(changeRecordEvents).set({ payloadRef: badJobPayload })
      .where(eq(changeRecordEvents.id, badJobPlanEvent.id));
    await expect(recordPostedAcceptanceCriterionOutcomeBundle(writerInput(badJobPlan)))
      .resolves.toEqual({ kind: "not_ready", reason: "invalid_criterion_outcome_custody" });

    const alteredHash = await createBundleFixture({
      workspaceId, workKey: "altered-attestation", prNumber: 206, headSha: "6".repeat(40),
    });
    await recordPostedAcceptanceCriterionOutcomeBundle(writerInput(alteredHash));
    await projectPostedJob(alteredHash);
    const posted = (await db.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, alteredHash.recordId),
      eq(changeRecordEvents.eventKey, `review:github-posted:${alteredHash.jobId}`),
    )))[0]!;
    await db.update(changeRecordEvents).set({
      payloadRef: { ...posted.payloadRef, criterionOutcomeBundleSha256: "f".repeat(64) },
    }).where(eq(changeRecordEvents.id, posted.id));
    await expect(readCurrentAcceptanceCriterionOutcomeBundle({ workspaceId, recordId: alteredHash.recordId }))
      .resolves.toEqual({ kind: "not_ready", reason: "invalid_criterion_outcome_custody" });
  });

  it("preserves a known historical post race and never revives A1 after A→B→A", async () => {
    const fixture = await createBundleFixture({
      workspaceId, workKey: "historical-post-race", prNumber: 207, headSha: "7".repeat(40),
    });
    const headB = "8".repeat(40);
    const advancedB = await advanceConfirmedAcceptanceRecordPullRequestHead({
      workspaceId,
      recordId: fixture.recordId,
      repo: REPO,
      prNumber: fixture.prNumber,
      headSha: headB,
      event: "synchronize",
      deliveryId: "historical-post-race:b",
      admitReviewJob: true,
      headTransition: { beforeHeadSha: fixture.headSha, afterHeadSha: headB },
      source: "github_webhook",
    });
    if (advancedB.kind !== "advanced") throw new Error("expected B cycle");
    await expect(recordPostedAcceptanceCriterionOutcomeBundle(writerInput(fixture)))
      .resolves.toMatchObject({ kind: "recorded", current: false });
    await expect(readCurrentAcceptanceCriterionOutcomeBundle({ workspaceId, recordId: fixture.recordId }))
      .resolves.toMatchObject({ kind: "not_ready" });

    const advancedA2 = await advanceConfirmedAcceptanceRecordPullRequestHead({
      workspaceId,
      recordId: fixture.recordId,
      repo: REPO,
      prNumber: fixture.prNumber,
      headSha: fixture.headSha,
      event: "synchronize",
      deliveryId: "historical-post-race:a2",
      admitReviewJob: true,
      headTransition: { beforeHeadSha: headB, afterHeadSha: fixture.headSha },
      source: "github_webhook",
    });
    if (advancedA2.kind !== "advanced") throw new Error("expected A2 cycle");
    expect(advancedA2.jobId).not.toBe(fixture.jobId);
    await expect(readCurrentAcceptanceCriterionOutcomeBundle({ workspaceId, recordId: fixture.recordId }))
      .resolves.toMatchObject({ kind: "not_ready", reason: "verification_plan_unavailable" });
    expect(await db.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, fixture.recordId),
      eq(changeRecordEvents.eventKey, `review:criterion-outcomes:${advancedA2.jobId}`),
    ))).toHaveLength(0);
  });

  it("linearizes a posted-receipt write against head advance without ever binding A evidence to B", async () => {
    const fixture = await createBundleFixture({
      workspaceId, workKey: "write-head-race", prNumber: 218, headSha: "d".repeat(40),
    });
    const headB = "e".repeat(40);
    const [write, advance] = await Promise.all([
      recordPostedAcceptanceCriterionOutcomeBundle(writerInput(fixture)),
      advanceConfirmedAcceptanceRecordPullRequestHead({
        workspaceId,
        recordId: fixture.recordId,
        repo: REPO,
        prNumber: fixture.prNumber,
        headSha: headB,
        event: "synchronize",
        deliveryId: "write-head-race:b",
        admitReviewJob: true,
        headTransition: { beforeHeadSha: fixture.headSha, afterHeadSha: headB },
        source: "github_webhook",
      }),
    ]);
    expect(write).toMatchObject({ kind: "recorded" });
    expect(advance).toMatchObject({ kind: "advanced" });
    const bundle = (await db.select().from(changeRecordEvents).where(and(
      eq(changeRecordEvents.recordId, fixture.recordId),
      eq(changeRecordEvents.eventKey, `review:criterion-outcomes:${fixture.jobId}`),
    )))[0]!;
    expect((bundle.payloadRef["binding"] as Record<string, unknown>)["headSha"]).toBe(fixture.headSha);
    expect((bundle.payloadRef["binding"] as Record<string, unknown>)["reviewJobId"]).toBe(fixture.jobId);
    const currentRecord = (await db.select().from(changeRecords).where(eq(
      changeRecords.id, fixture.recordId,
    )))[0]!;
    expect(currentRecord).toMatchObject({ currentPrHeadSha: headB });
    await expect(readCurrentAcceptanceCriterionOutcomeBundle({ workspaceId, recordId: fixture.recordId }))
      .resolves.toMatchObject({ kind: "not_ready" });
  });

  it("accepts the full 100-criterion Contract without inventing artifacts for not-testable plans", async () => {
    const fixture = await createBundleFixture({
      workspaceId,
      workKey: "max-contract",
      prNumber: 208,
      headSha: "9".repeat(40),
      criteriaCount: 100,
      notTestable: true,
    });
    const result = await recordPostedAcceptanceCriterionOutcomeBundle(writerInput(fixture));
    expect(result).toMatchObject({ kind: "recorded", current: true });
    if (result.kind !== "recorded") throw new Error("expected max Contract bundle");
    expect(result.bundle.outcomes).toHaveLength(100);
    expect(result.bundle.outcomes.every((outcome) => outcome.state === "not_testable"
      && outcome.evidence.kind === "not_testable_plan"
      && !("artifact" in outcome.evidence))).toBe(true);
    expect(result.bundle.id).toBe(acceptanceCriterionOutcomeBundleId({
      recordId: fixture.recordId,
      headCycleId: fixture.jobId,
    }));
  });

  it("fails closed when exact-cycle event count or payload bytes exceed custody bounds", async () => {
    const overCount = await createBundleFixture({
      workspaceId, workKey: "event-count-bound", prNumber: 228, headSha: "7".repeat(40),
      notTestable: true,
    });
    const noiseEvents = Array.from({ length: 511 }, (_, index) => {
      const eventKey = `verification:noise:${overCount.jobId}:${index}`;
      return {
        id: changeRecordEventId({ recordId: overCount.recordId, eventKey }),
        recordId: overCount.recordId,
        eventKey,
        stage: "verification",
        actor: "server:r112b-bound-test",
        payloadRef: { kind: "bounded_noise", index },
      };
    });
    await db.insert(changeRecordEvents).values(noiseEvents);
    await expect(recordPostedAcceptanceCriterionOutcomeBundle(writerInput(overCount)))
      .resolves.toEqual({ kind: "not_ready", reason: "invalid_criterion_outcome_custody" });

    const overBytes = await createBundleFixture({
      workspaceId, workKey: "event-byte-bound", prNumber: 229, headSha: "8".repeat(40),
      notTestable: true,
    });
    const oversizedEventKey = `verification:noise:${overBytes.jobId}:oversized`;
    await db.execute(sql`
      INSERT INTO change_record_events (
        id, record_id, event_key, stage, actor, payload_ref
      ) VALUES (
        ${changeRecordEventId({ recordId: overBytes.recordId, eventKey: oversizedEventKey })},
        ${overBytes.recordId},
        ${oversizedEventKey},
        'verification',
        'server:r112b-bound-test',
        jsonb_build_object(
          'kind', 'oversized_noise',
          'blob', repeat('x', ${ACCEPTANCE_CRITERION_OUTCOME_MAX_EVENT_BYTES + 1})
        )
      )
    `);
    await expect(recordPostedAcceptanceCriterionOutcomeBundle(writerInput(overBytes)))
      .resolves.toEqual({ kind: "not_ready", reason: "invalid_criterion_outcome_custody" });
  });
});
