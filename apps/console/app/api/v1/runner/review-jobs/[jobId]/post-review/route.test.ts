import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentrail/db-postgres")>();
  const CurrentHeadError = actual.CurrentReviewJobNotCurrentError ?? class extends Error {
    readonly code = "CURRENT_REVIEW_JOB_NOT_CURRENT";
    constructor(readonly reason: "record_not_current" | "job_not_running") {
      super(`Current review job is not current: ${reason}`);
    }
  };
  return {
    appendChangeRecordEvent: vi.fn(),
    appendCurrentReviewJobEventsAtomically: vi.fn(),
    CurrentReviewJobNotCurrentError: CurrentHeadError,
    getInstallationToken: vi.fn(),
    getJaceSessionByEveSessionId: vi.fn(),
    getPreviewBoot: vi.fn(),
    getRepositoryByName: vi.fn(),
    getReviewJobById: vi.fn(),
    previewBootId: vi.fn(() => "boot-1"),
    readAcceptanceContracts: vi.fn(),
    readChangeRecordTimelineByPr: vi.fn(),
    reviewJobCorrectionPacketId: actual.reviewJobCorrectionPacketId,
    validateReviewJobCorrectionPacketPayload: actual.validateReviewJobCorrectionPacketPayload,
  };
});
vi.mock("../../../../../../../lib/github-advisory-review", () => ({
  postGithubAdvisoryReview: vi.fn(),
}));

import {
  appendChangeRecordEvent,
  appendCurrentReviewJobEventsAtomically,
  CurrentReviewJobNotCurrentError,
  getInstallationToken,
  getJaceSessionByEveSessionId,
  getPreviewBoot,
  getRepositoryByName,
  getReviewJobById,
  readAcceptanceContracts,
  readChangeRecordTimelineByPr,
} from "@agentrail/db-postgres";
import { postGithubAdvisoryReview } from "../../../../../../../lib/github-advisory-review";
import {
  type ExactReviewJobProof,
  R7_READY_NOT_PROVEN_OBSERVATION,
  r7UnavailablePreviewObservation,
} from "../../../../../../../lib/review-job-proof-attestation";
import {
  buildReviewJobUiAttempt,
  buildReviewJobUiResult,
  buildReviewJobUiScreenshotReservation,
  reviewJobUiAttemptEventKey,
  reviewJobUiResultEventKey,
  reviewJobUiScreenshotReservationEventKey,
} from "../../../../../../../lib/review-job-ui-execution";
import {
  buildReviewJobApiAttempt,
  buildReviewJobApiCardReservation,
  buildReviewJobApiResult,
  reviewJobApiAttemptEventKey,
  reviewJobApiCardReservationEventKey,
  reviewJobApiResultEventKey,
} from "../../../../../../../lib/review-job-api-execution";
import {
  buildReviewJobDataAttempt,
  buildReviewJobDataCardReservation,
  buildReviewJobDataResult,
  reviewJobDataAttemptEventKey,
  reviewJobDataCardReservationEventKey,
  reviewJobDataResultEventKey,
} from "../../../../../../../lib/review-job-data-execution";
import {
  buildStoredDataVerificationRequest,
  dataScalarKind,
  reviewDataScalarHmac,
  buildStoredJobVerificationRequest,
  reviewJobScalarHmac,
} from "../../../../../../../lib/review-job-verification-plan";
import {
  buildReviewJobAttempt,
  buildReviewJobCardReservation,
  buildReviewJobResult,
  reviewJobAttemptEventKey,
  reviewJobCardReservationEventKey,
  reviewJobResultEventKey,
} from "../../../../../../../lib/review-job-job-execution";
import { POST } from "./route";

const secret = "test-secret";
const jobId = "job-1";
const workspaceId = "00000000-0000-0000-0000-000000000001";
const recordId = "00000000-0000-0000-0000-000000000002";
const headSha = "a".repeat(40);
const bootLogKey = "review-evidence/ws-1/ada__widgets/98/abcdef/boot.log";
const screenshotKey =
  "review-evidence/ws-1/ada__widgets/98/abcdef/AC-1/exact.png";
const apiEvidenceKey =
  "review-evidence/ws-1/ada__widgets/98/abcdef/AC-1/response.json";
const dataEvidenceKey =
  "review-evidence/ws-1/ada__widgets/98/abcdef/AC-1/data.json";
const jobEvidenceKey =
  "review-evidence/ws-1/ada__widgets/98/abcdef/AC-1/job.json";
const previewUrl = "http://127.0.0.1:43123";
const dataHmacKey = {
  keyId: "route-test-2026-08",
  key: Buffer.alloc(32, 7),
};

const session = {
  id: "session-1",
  eveSessionId: "eve-session-1",
  workspaceId,
  chatIdentityId: null,
  channel: "review-job",
  conversationKey: `review-job:${jobId}`,
  status: "active",
};
const job = {
  id: jobId,
  workspaceId,
  repo: "ada/widgets",
  prNumber: 98,
  headSha,
  state: "running",
};
const contract = {
  id: "contract-1",
  version: 3,
  status: "confirmed",
  contract: {
    acceptanceCriteria: [
      {
        id: "AC-1",
        text: "The saved value remains visible after reload.",
        userVisible: true,
      },
    ],
  },
};

function storedDataRequest(path: string, criterionId = "AC-1") {
  return buildStoredDataVerificationRequest({
    value: {
      method: "GET",
      path,
      expectedStatus: 200,
      expectedJson: [{ pointer: "/enabled", equals: true }],
    },
    binding: {
      workspaceId,
      recordId,
      jobId,
      headSha,
      contractId: contract.id,
      contractVersion: contract.version,
      criterionId,
    },
    hmacKey: dataHmacKey,
  })!;
}

function observedDataScalar(
  dataRequest: ReturnType<typeof storedDataRequest>,
  value: boolean,
) {
  return {
    pointer: "/enabled",
    found: true,
    observedType: dataScalarKind(value),
    observedHmacSha256: reviewDataScalarHmac({
      key: dataHmacKey.key,
      context: dataRequest.digestContext,
      pointer: "/enabled",
      value,
    }),
  };
}

function storedJobRequest(criterionId = "AC-1") {
  return buildStoredJobVerificationRequest({
    value: {
      trigger: { method: "POST", path: "/__agentrail/verification/jobs/reindex-1/trigger", expectedStatus: 202 },
      readback: { method: "GET", path: "/__agentrail/verification/jobs/reindex-1/result", expectedStatus: 200, expectedJson: [{ pointer: "/state", equals: "complete" }] },
    },
    binding: { workspaceId, recordId, jobId, headSha, contractId: contract.id, contractVersion: contract.version, criterionId },
    hmacKey: dataHmacKey,
  })!;
}

function observedJobScalar(request: ReturnType<typeof storedJobRequest>, value: string) {
  return {
    pointer: "/state", found: true, observedType: dataScalarKind(value),
    observedHmacSha256: reviewJobScalarHmac({ key: dataHmacKey.key, context: request.readback.digestContext, pointer: "/state", value }),
  };
}
const planPayload = {
  kind: "review_job_verification_plan",
  jobId,
  workspaceId,
  repo: job.repo,
  prNumber: job.prNumber,
  headSha,
  recordId,
  acceptanceContractId: contract.id,
  acceptanceContractVersion: contract.version,
  plannedBy: "jace:review-job-worker",
  plans: [
    {
      criterionId: "AC-1",
      criterionTextSnapshot: "The saved value remains visible after reload.",
      modality: "ui",
      environmentKind: "isolated_preview",
      flow: "Save a value, reload, and observe the saved row.",
      uiSteps: [
        { action: "open", path: "/saved-values" },
        { action: "expect_text", text: "Saved value" },
        { action: "screenshot", label: "saved-value" },
      ],
      status: "planned",
      notTestableReason: null,
    },
  ],
};

let timeline: {
  record: {
    id: string;
    workspaceId: string;
    repo: string;
    prNumber: number;
    headShas: string[];
    currentPrHeadSha: string | null;
    currentPrHeadCycleId: string | null;
    currentPrHeadAuthoritative: boolean;
  };
  events: Array<{ eventKey: string; payloadRef: Record<string, unknown> }>;
};

const criterionResults = [
  {
    criterionId: "AC-1",
    state: "not_proven",
    expected: "The saved value remains visible after reload.",
    observed: R7_READY_NOT_PROVEN_OBSERVATION,
    evidenceRefs: ["preview-boot:boot-1"],
  },
];
const validBody = {
  eveSessionId: "eve-session-1",
  summary: "The exact-head environment was available; behavior remains unproven.",
  comments: [
    { path: "src/widget.ts", line: 12, body: "This guard is required." },
  ],
  criterionResults,
  verdict: "not_proven",
  summaryLine: "ada/widgets #98 — not_proven",
  evidenceKeys: [bootLogKey],
};

const uiSteps = [
  { action: "open", path: "/saved-values" },
  { action: "expect_text", text: "Saved value" },
  { action: "screenshot", label: "saved-value" },
] as const;

function installUiReceipt(assertionPassed = true) {
  const verificationPlan = {
    ...planPayload,
    plans: [{ ...planPayload.plans[0], uiSteps: [...uiSteps] }],
  };
  const receiptTimeline: typeof timeline = {
    record: {
      id: recordId,
      workspaceId,
      repo: job.repo,
      prNumber: job.prNumber,
      headShas: [headSha],
      currentPrHeadSha: headSha,
      currentPrHeadCycleId: jobId,
      currentPrHeadAuthoritative: true,
    },
    events: [{
      eventKey: `verification:plan:${jobId}`,
      payloadRef: verificationPlan,
    }],
  };
  const proof = {
    job,
    timeline: receiptTimeline,
    contract: {
      id: contract.id,
      version: contract.version,
      criteria: contract.contract.acceptanceCriteria,
    },
    verificationPlan,
  } as unknown as ExactReviewJobProof;
  const plan = proof.verificationPlan.plans[0];
  const boot = {
    id: "boot-1",
    workspaceId,
    repo: job.repo,
    prNumber: job.prNumber,
    headSha,
    status: "ready",
    url: previewUrl,
  };
  const attempt = buildReviewJobUiAttempt({ proof, plan, boot })!;
  const result = buildReviewJobUiResult({
    attempt,
    plan,
    assertionPassed,
    artifactKey: screenshotKey,
    contentType: "image/png",
    contentSha256: "c".repeat(64),
    observedUrl: `${previewUrl}/saved-values`,
  })!;
  receiptTimeline.events.push(
    {
      eventKey: reviewJobUiAttemptEventKey({ proof, plan }),
      payloadRef: attempt,
    },
    {
      eventKey: reviewJobUiScreenshotReservationEventKey({ proof, plan }),
      payloadRef: buildReviewJobUiScreenshotReservation(result),
    },
    {
      eventKey: reviewJobUiResultEventKey({ proof, plan }),
      payloadRef: result,
    }
  );
  timeline = receiptTimeline;
  return {
    attempt,
    result,
    plan,
    body: {
      ...validBody,
      criterionResults: [{
        criterionId: "AC-1",
        state: result.state,
        expected: result.expected,
        observed: result.observed,
        evidenceRefs: [result.evidenceRef],
      }],
      verdict: result.state,
      summaryLine: `ada/widgets #98 — ${result.state}`,
      evidenceKeys: [screenshotKey],
    },
  };
}

function installApiReceipt(observedStatus = 200) {
  const apiRequest = { method: "GET", path: "/health", expectedStatus: 200 };
  const verificationPlan = {
    ...planPayload,
    plans: [{
      ...planPayload.plans[0],
      modality: "api",
      flow: "Request the bounded health endpoint and inspect its status.",
      uiSteps: null,
      apiRequest,
    }],
  };
  const receiptTimeline: typeof timeline = {
    record: { id: recordId, workspaceId, repo: job.repo, prNumber: job.prNumber, headShas: [headSha], currentPrHeadSha: headSha, currentPrHeadCycleId: jobId, currentPrHeadAuthoritative: true },
    events: [{ eventKey: `verification:plan:${jobId}`, payloadRef: verificationPlan }],
  };
  const proof = {
    job,
    timeline: receiptTimeline,
    contract: { id: contract.id, version: contract.version, criteria: contract.contract.acceptanceCriteria },
    verificationPlan,
  } as unknown as ExactReviewJobProof;
  const plan = proof.verificationPlan.plans[0];
  const boot = { id: "boot-1", workspaceId, repo: job.repo, prNumber: job.prNumber, headSha, status: "ready", url: previewUrl };
  const attempt = buildReviewJobApiAttempt({ proof, plan, boot })!;
  const result = buildReviewJobApiResult({
    attempt,
    plan,
    observedStatus,
    artifactKey: apiEvidenceKey,
    contentSha256: "a".repeat(64),
  })!;
  vi.mocked(readAcceptanceContracts).mockResolvedValue([{
    ...contract,
    contract: {
      acceptanceCriteria: contract.contract.acceptanceCriteria.map((criterion) => ({
        ...criterion,
        userVisible: false,
      })),
    },
  }] as never);
  receiptTimeline.events.push(
    { eventKey: reviewJobApiAttemptEventKey({ proof, plan }), payloadRef: attempt },
    { eventKey: reviewJobApiCardReservationEventKey({ proof, plan }), payloadRef: buildReviewJobApiCardReservation(result) },
    { eventKey: reviewJobApiResultEventKey({ proof, plan }), payloadRef: result }
  );
  timeline = receiptTimeline;
  return {
    attempt,
    result,
    plan,
    body: {
      ...validBody,
      criterionResults: [{
        criterionId: "AC-1", state: result.state, expected: result.expected,
        observed: result.observed, evidenceRefs: [result.evidenceRef],
      }],
      verdict: result.state,
      summaryLine: `ada/widgets #98 — ${result.state}`,
      evidenceKeys: [apiEvidenceKey],
    },
  };
}

function installDataReceipt(observedStatus = 200) {
  const dataRequest = storedDataRequest("/health");
  const verificationPlan = {
    ...planPayload,
    plans: [{
      ...planPayload.plans[0], modality: "data", userVisible: false,
      flow: "Read the bounded JSON response and inspect the planned field.",
      uiSteps: null, apiRequest: null, dataRequest,
    }],
  };
  const receiptTimeline: typeof timeline = {
    record: { id: recordId, workspaceId, repo: job.repo, prNumber: job.prNumber, headShas: [headSha], currentPrHeadSha: headSha, currentPrHeadCycleId: jobId, currentPrHeadAuthoritative: true },
    events: [{ eventKey: `verification:plan:${jobId}`, payloadRef: verificationPlan }],
  };
  const proof = {
    job, timeline: receiptTimeline,
    contract: { id: contract.id, version: contract.version, criteria: contract.contract.acceptanceCriteria },
    verificationPlan,
  } as unknown as ExactReviewJobProof;
  const plan = proof.verificationPlan.plans[0];
  const boot = { id: "boot-1", workspaceId, repo: job.repo, prNumber: job.prNumber, headSha, status: "ready", url: previewUrl };
  const attempt = buildReviewJobDataAttempt({ proof, plan, boot })!;
  const result = buildReviewJobDataResult({
    attempt, plan, observedStatus,
    observations: observedStatus === 200
      ? [observedDataScalar(dataRequest, true)]
      : [],
    artifactKey: dataEvidenceKey, contentSha256: "d".repeat(64),
  })!;
  vi.mocked(readAcceptanceContracts).mockResolvedValue([{
    ...contract,
    contract: { acceptanceCriteria: contract.contract.acceptanceCriteria.map((criterion) => ({ ...criterion, userVisible: false })) },
  }] as never);
  receiptTimeline.events.push(
    { eventKey: reviewJobDataAttemptEventKey({ proof, plan }), payloadRef: attempt },
    { eventKey: reviewJobDataCardReservationEventKey({ proof, plan }), payloadRef: buildReviewJobDataCardReservation(result) },
    { eventKey: reviewJobDataResultEventKey({ proof, plan }), payloadRef: result },
  );
  timeline = receiptTimeline;
  return {
    attempt, result, plan,
    body: {
      ...validBody,
      criterionResults: [{ criterionId: "AC-1", state: result.state, expected: result.expected, observed: result.observed, evidenceRefs: [result.evidenceRef] }],
      verdict: result.state, summaryLine: `ada/widgets #98 — ${result.state}`,
      evidenceKeys: [dataEvidenceKey],
    },
  };
}

/** A server-custodied bodyless POST plus immediate HMAC-only readback. */
function installJobReceipt(input: { triggerStatus?: number; readbackStatus?: number | null; observedValue?: string } = {}) {
  const triggerStatus = input.triggerStatus ?? 202;
  const readbackStatus = input.readbackStatus === undefined ? 200 : input.readbackStatus;
  const jobRequest = storedJobRequest();
  const verificationPlan = {
    ...planPayload,
    plans: [{
      ...planPayload.plans[0], modality: "job", userVisible: false,
      flow: "Trigger the bounded maintenance job and immediately read its result.",
      uiSteps: null, apiRequest: null, dataRequest: null, jobRequest,
    }],
  };
  const receiptTimeline: typeof timeline = {
    record: { id: recordId, workspaceId, repo: job.repo, prNumber: job.prNumber, headShas: [headSha], currentPrHeadSha: headSha, currentPrHeadCycleId: jobId, currentPrHeadAuthoritative: true },
    events: [{ eventKey: `verification:plan:${jobId}`, payloadRef: verificationPlan }],
  };
  const proof = { job, timeline: receiptTimeline, contract: { id: contract.id, version: contract.version, criteria: contract.contract.acceptanceCriteria }, verificationPlan } as unknown as ExactReviewJobProof;
  const plan = proof.verificationPlan.plans[0];
  const boot = { id: "boot-1", workspaceId, repo: job.repo, prNumber: job.prNumber, headSha, status: "ready", url: previewUrl };
  const attempt = buildReviewJobAttempt({ proof, plan, boot })!;
  const observations = triggerStatus === 202 && readbackStatus === 200
    ? [observedJobScalar(jobRequest, input.observedValue ?? "complete")]
    : [];
  const result = buildReviewJobResult({ attempt, plan, observedTriggerStatus: triggerStatus, observedReadbackStatus: readbackStatus, observations, artifactKey: jobEvidenceKey, contentSha256: "a".repeat(64) })!;
  vi.mocked(readAcceptanceContracts).mockResolvedValue([{
    ...contract, contract: { acceptanceCriteria: contract.contract.acceptanceCriteria.map((criterion) => ({ ...criterion, userVisible: false })) },
  }] as never);
  receiptTimeline.events.push(
    { eventKey: reviewJobAttemptEventKey({ proof, plan }), payloadRef: attempt },
    { eventKey: reviewJobCardReservationEventKey({ proof, plan }), payloadRef: buildReviewJobCardReservation(result) },
    { eventKey: reviewJobResultEventKey({ proof, plan }), payloadRef: result },
  );
  timeline = receiptTimeline;
  return {
    attempt, result, plan, jobRequest,
    body: {
      ...validBody,
      criterionResults: [{ criterionId: "AC-1", state: result.state, expected: result.expected, observed: result.observed, evidenceRefs: [result.evidenceRef] }],
      verdict: result.state, summaryLine: `ada/widgets #98 — ${result.state}`,
      evidenceKeys: [jobEvidenceKey],
    },
  };
}

function installDataVerdictPriorityProof() {
  const criteria = [
    { id: "AC-1", text: "The first bounded JSON field has its expected value.", userVisible: false },
    { id: "AC-2", text: "The second bounded JSON field has its expected value.", userVisible: false },
  ];
  const verificationPlan = {
    ...planPayload,
    plans: criteria.map((criterion, index) => ({
      criterionId: criterion.id, criterionTextSnapshot: criterion.text,
      modality: "data", environmentKind: "isolated_preview",
      flow: "Read the bounded JSON response and inspect the planned field.",
      uiSteps: null, apiRequest: null,
      dataRequest: storedDataRequest(index ? "/status" : "/health", criterion.id),
      status: "planned", notTestableReason: null,
    })),
  };
  const priorityTimeline: typeof timeline = {
    record: { id: recordId, workspaceId, repo: job.repo, prNumber: job.prNumber, headShas: [headSha], currentPrHeadSha: headSha, currentPrHeadCycleId: jobId, currentPrHeadAuthoritative: true },
    events: [{ eventKey: `verification:plan:${jobId}`, payloadRef: verificationPlan }],
  };
  const proof = {
    job, timeline: priorityTimeline,
    contract: { id: contract.id, version: contract.version, criteria }, verificationPlan,
  } as unknown as ExactReviewJobProof;
  const boot = { id: "boot-1", workspaceId, repo: job.repo, prNumber: job.prNumber, headSha, status: "ready", url: previewUrl };
  const results = proof.verificationPlan.plans.map((plan, index) => {
    const attempt = buildReviewJobDataAttempt({ proof, plan, boot })!;
    const result = buildReviewJobDataResult({
      attempt, plan, observedStatus: 200,
      observations: [observedDataScalar(plan.dataRequest!, index ? false : true)],
      artifactKey: `${dataEvidenceKey}.${index}`, contentSha256: `${index + 1}`.repeat(64),
    })!;
    priorityTimeline.events.push(
      { eventKey: reviewJobDataAttemptEventKey({ proof, plan }), payloadRef: attempt },
      { eventKey: reviewJobDataCardReservationEventKey({ proof, plan }), payloadRef: buildReviewJobDataCardReservation(result) },
      { eventKey: reviewJobDataResultEventKey({ proof, plan }), payloadRef: result },
    );
    return result;
  });
  timeline = priorityTimeline;
  vi.mocked(readAcceptanceContracts).mockResolvedValue([{
    ...contract, contract: { acceptanceCriteria: criteria },
  }] as never);
  return {
    ...validBody,
    criterionResults: results.map((result) => ({
      criterionId: result.criterionId, state: result.state,
      expected: result.expected, observed: result.observed,
      evidenceRefs: [result.evidenceRef],
    })),
    verdict: "failed", summaryLine: "ada/widgets #98 — failed",
    evidenceKeys: results.map((result) => result.artifactKey),
  };
}

function installApiVerdictPriorityProof() {
  const criteria = [
    { id: "AC-1", text: "The health endpoint returns its planned status.", userVisible: false },
    { id: "AC-2", text: "The status endpoint returns its planned status.", userVisible: false },
  ];
  const verificationPlan = {
    ...planPayload,
    plans: criteria.map((criterion, index) => ({
      criterionId: criterion.id,
      criterionTextSnapshot: criterion.text,
      modality: "api",
      environmentKind: "isolated_preview",
      flow: "Request the bounded endpoint and inspect its status.",
      uiSteps: null,
      status: "planned",
      notTestableReason: null,
      apiRequest: { method: "GET", path: index ? "/status" : "/health", expectedStatus: 200 },
    })),
  };
  const priorityTimeline: typeof timeline = {
    record: { id: recordId, workspaceId, repo: job.repo, prNumber: job.prNumber, headShas: [headSha], currentPrHeadSha: headSha, currentPrHeadCycleId: jobId, currentPrHeadAuthoritative: true },
    events: [{ eventKey: `verification:plan:${jobId}`, payloadRef: verificationPlan }],
  };
  const proof = {
    job, timeline: priorityTimeline,
    contract: { id: contract.id, version: contract.version, criteria }, verificationPlan,
  } as unknown as ExactReviewJobProof;
  const boot = { id: "boot-1", workspaceId, repo: job.repo, prNumber: job.prNumber, headSha, status: "ready", url: previewUrl };
  const results = proof.verificationPlan.plans.map((plan, index) => {
    const attempt = buildReviewJobApiAttempt({ proof, plan, boot })!;
    const result = buildReviewJobApiResult({
      attempt, plan, observedStatus: index ? 503 : 200,
      artifactKey: `${apiEvidenceKey}.${index}`, contentSha256: `${index + 1}`.repeat(64),
    })!;
    priorityTimeline.events.push(
      { eventKey: reviewJobApiAttemptEventKey({ proof, plan }), payloadRef: attempt },
      { eventKey: reviewJobApiCardReservationEventKey({ proof, plan }), payloadRef: buildReviewJobApiCardReservation(result) },
      { eventKey: reviewJobApiResultEventKey({ proof, plan }), payloadRef: result }
    );
    return result;
  });
  timeline = priorityTimeline;
  vi.mocked(readAcceptanceContracts).mockResolvedValue([{
    ...contract, contract: { acceptanceCriteria: criteria },
  }] as never);
  return {
    ...validBody,
    criterionResults: results.map((result) => ({
      criterionId: result.criterionId, state: result.state, expected: result.expected,
      observed: result.observed, evidenceRefs: [result.evidenceRef],
    })),
    verdict: "failed",
    summaryLine: "ada/widgets #98 — failed",
    evidenceKeys: results.map((result) => result.artifactKey),
  };
}

function installVerdictPriorityProof(
  states: Array<"proven" | "failed" | "not_proven" | "not_testable">
) {
  const criteria = states.map((state, index) => ({
    id: `AC-${index + 1}`,
    text: `Criterion ${index + 1}`,
    userVisible: state !== "not_testable",
  }));
  const plans = states.map((state, index) =>
    state === "not_testable"
      ? {
          criterionId: `AC-${index + 1}`,
          criterionTextSnapshot: `Criterion ${index + 1}`,
          modality: "api",
          environmentKind: null,
          flow: null,
          uiSteps: null,
          status: "not_testable",
          notTestableReason: "No server-custodied API executor is available.",
        }
      : {
          criterionId: `AC-${index + 1}`,
          criterionTextSnapshot: `Criterion ${index + 1}`,
          modality: "ui",
          environmentKind: "isolated_preview",
          flow: "Open the saved values and inspect the result.",
          uiSteps: [...uiSteps],
          status: "planned",
          notTestableReason: null,
        }
  );
  const verificationPlan = {
    ...planPayload,
    plans,
  };
  const priorityTimeline: typeof timeline = {
    record: {
      id: recordId,
      workspaceId,
      repo: job.repo,
      prNumber: job.prNumber,
      headShas: [headSha],
      currentPrHeadSha: headSha,
      currentPrHeadCycleId: jobId,
      currentPrHeadAuthoritative: true,
    },
    events: [{
      eventKey: `verification:plan:${jobId}`,
      payloadRef: verificationPlan,
    }],
  };
  const proof = {
    job,
    timeline: priorityTimeline,
    contract: { id: contract.id, version: contract.version, criteria },
    verificationPlan,
  } as unknown as ExactReviewJobProof;
  const boots = new Map<string, Record<string, unknown>>();
  const results: Array<Record<string, unknown>> = [];
  const evidenceKeys: string[] = [];

  for (const [index, state] of states.entries()) {
    const plan = proof.verificationPlan.plans[index];
    if (state === "not_testable") {
      results.push({
        criterionId: plan.criterionId,
        state,
        expected: plan.criterionTextSnapshot,
        observed: plan.notTestableReason,
        evidenceRefs: [],
      });
      continue;
    }
    // One exact current-cycle preview is shared by every criterion in the
    // immutable plan; criterion fan-out must not invent independent boots.
    const bootId = "boot-1";
    const boot = {
      id: bootId,
      workspaceId,
      repo: job.repo,
      prNumber: job.prNumber,
      headSha,
      status: "ready",
      url: previewUrl,
    };
    boots.set(bootId, boot);
    if (state === "not_proven") {
      results.push({
        criterionId: plan.criterionId,
        state,
        expected: plan.criterionTextSnapshot,
        observed: R7_READY_NOT_PROVEN_OBSERVATION,
        evidenceRefs: [`preview-boot:${bootId}`],
      });
      continue;
    }
    const attempt = buildReviewJobUiAttempt({ proof, plan, boot })!;
    const artifactKey = `${screenshotKey}.${index + 1}`;
    const result = buildReviewJobUiResult({
      attempt,
      plan,
      assertionPassed: state === "proven",
      artifactKey,
      contentType: "image/png",
      contentSha256: `${index + 1}`.repeat(64),
      observedUrl: `${previewUrl}/saved-values`,
    })!;
    priorityTimeline.events.push(
      {
        eventKey: reviewJobUiAttemptEventKey({ proof, plan }),
        payloadRef: attempt,
      },
      {
        eventKey: reviewJobUiScreenshotReservationEventKey({ proof, plan }),
        payloadRef: buildReviewJobUiScreenshotReservation(result),
      },
      {
        eventKey: reviewJobUiResultEventKey({ proof, plan }),
        payloadRef: result,
      }
    );
    evidenceKeys.push(artifactKey);
    results.push({
      criterionId: plan.criterionId,
      state: result.state,
      expected: result.expected,
      observed: result.observed,
      evidenceRefs: [result.evidenceRef],
    });
  }

  timeline = priorityTimeline;
  vi.mocked(readAcceptanceContracts).mockResolvedValue([{
    id: contract.id,
    version: contract.version,
    status: "confirmed",
    contract: { acceptanceCriteria: criteria },
  }] as never);
  vi.mocked(getPreviewBoot).mockImplementation(
    async (bootId) => (boots.get(bootId) ?? null) as never
  );
  return {
    ...validBody,
    criterionResults: results,
    evidenceKeys,
  };
}

function request(body: unknown = validBody, authorized = true) {
  return new NextRequest(
    `http://localhost/api/v1/runner/review-jobs/${jobId}/post-review`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorized ? { Authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify(body),
    }
  );
}

const params = { params: Promise.resolve({ jobId }) };

function correctionEventKeys() {
  return vi
    .mocked(appendCurrentReviewJobEventsAtomically)
    .mock.calls.flatMap(([input]) => input.events.map((event) => event.eventKey))
    .filter((eventKey) => eventKey.startsWith(`review:correction:${jobId}:`));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JACE_CONSOLE_TOKEN = secret;
  timeline = {
    record: {
      id: recordId,
      workspaceId,
      repo: job.repo,
      prNumber: job.prNumber,
      headShas: [headSha],
      currentPrHeadSha: headSha,
      currentPrHeadCycleId: jobId,
      currentPrHeadAuthoritative: true,
    },
    events: [{ eventKey: `verification:plan:${jobId}`, payloadRef: planPayload }],
  };
  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(session as never);
  vi.mocked(getReviewJobById).mockResolvedValue(job as never);
  vi.mocked(readChangeRecordTimelineByPr).mockImplementation(async () => timeline as never);
  vi.mocked(readAcceptanceContracts).mockResolvedValue([contract] as never);
  vi.mocked(getPreviewBoot).mockResolvedValue({
    id: "boot-1",
    workspaceId,
    repo: job.repo,
    prNumber: job.prNumber,
    headSha,
    status: "ready",
    url: "http://127.0.0.1:43123",
    bootLogKey,
  } as never);
  vi.mocked(getRepositoryByName).mockResolvedValue({ name: job.repo } as never);
  vi.mocked(getInstallationToken).mockResolvedValue("ghs-token");
  vi.mocked(appendChangeRecordEvent).mockImplementation(async (input) => ({
    inserted: true,
    event: { eventKey: input.eventKey, payloadRef: input.payloadRef },
  }) as never);
  vi.mocked(appendCurrentReviewJobEventsAtomically).mockImplementation(async (input) => ({
    events: input.events.map((event) => ({
      inserted: true,
      event: { eventKey: event.eventKey, payloadRef: event.payloadRef },
    })),
  }) as never);
  vi.mocked(postGithubAdvisoryReview).mockResolvedValue({
    ok: true,
    reviewUrl: "https://github.com/ada/widgets/pull/98#pullrequestreview-1",
    summary: "The exact-head behavior passed.",
    inlineCommentsPosted: 1,
    foldedComments: [],
  });
});

describe("POST /api/v1/runner/review-jobs/[jobId]/post-review", () => {
  it("authenticates before resolving a session or touching GitHub", async () => {
    const response = await POST(request(validBody, false), params);
    expect(response.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("accepts no caller-authored repo, PR, head, workspace, or other extra field", async () => {
    for (const extra of [
      { repo: "evil/repo" },
      { prNumber: 7 },
      { headSha: "deadbeef" },
      { workspaceId: "foreign" },
      { event: "APPROVE" },
    ]) {
      const response = await POST(request({ ...validBody, ...extra }), params);
      expect(response.status).toBe(400);
    }
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("rejects an unbound or inactive session before looking up the job", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
      ...session,
      conversationKey: "review-job:other",
    } as never);
    const response = await POST(request(), params);
    expect(response.status).toBe(409);
    expect(getReviewJobById).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("invalid or foreign preview evidence never reserves or calls GitHub", async () => {
    vi.mocked(getPreviewBoot).mockResolvedValue({
      id: "boot-1",
      workspaceId: "foreign-workspace",
      repo: job.repo,
      prNumber: job.prNumber,
      headSha,
      status: "ready",
      url: "http://127.0.0.1:43123",
    } as never);
    const response = await POST(request(), params);
    expect(response.status).toBe(409);
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("persists the exact not_proven correction packet before repository, token, and GitHub work", async () => {
    const response = await POST(request(), params);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      posted: true,
      replayed: false,
      reviewUrl: "https://github.com/ada/widgets/pull/98#pullrequestreview-1",
    });

    expect(correctionEventKeys()).toEqual([`review:correction:${jobId}:AC-1`]);
    expect(vi.mocked(appendCurrentReviewJobEventsAtomically).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(getRepositoryByName).mock.invocationCallOrder[0]
    );
    expect(vi.mocked(appendCurrentReviewJobEventsAtomically).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(getInstallationToken).mock.invocationCallOrder[0]
    );
    expect(getRepositoryByName).toHaveBeenCalledWith(workspaceId, job.repo);
    expect(postGithubAdvisoryReview).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: job.repo,
        prNumber: job.prNumber,
        headSha,
        token: "ghs-token",
        comments: validBody.comments,
        summary: expect.stringContaining(`agentrail-review-job:${jobId}:`),
      })
    );
    expect(
      vi.mocked(postGithubAdvisoryReview).mock.calls[0][0].summary
    ).toMatch(/^\*\*AgentRail exact-head verification: not_proven\.\*\*/);
    expect(appendCurrentReviewJobEventsAtomically).toHaveBeenCalledTimes(2);
    expect(vi.mocked(appendCurrentReviewJobEventsAtomically).mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(postGithubAdvisoryReview).mock.invocationCallOrder[0]
    );
    expect(vi.mocked(postGithubAdvisoryReview).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(appendChangeRecordEvent).mock.invocationCallOrder[0]
    );
    expect(appendCurrentReviewJobEventsAtomically).toHaveBeenNthCalledWith(
      2,
      {
        workspaceId,
        recordId,
        jobId,
        repo: job.repo,
        prNumber: job.prNumber,
        headSha,
        events: [expect.objectContaining({
          eventKey: `review:github-attempt:${jobId}`,
          payloadRef: expect.objectContaining({
            jobId,
            repo: job.repo,
            prNumber: job.prNumber,
            headSha,
            acceptanceContractVersion: contract.version,
          }),
        })],
      }
    );
    expect(appendChangeRecordEvent).toHaveBeenCalledTimes(1);
    expect(appendChangeRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId,
        eventKey: `review:github-posted:${jobId}`,
        payloadRef: expect.objectContaining({
          kind: "review_job_github_posted",
          postedReviewUrl: "https://github.com/ada/widgets/pull/98#pullrequestreview-1",
        }),
      })
    );
  });

  it("appends correction packets only for failed or not_proven criteria in mixed exact coverage", async () => {
    const body = installVerdictPriorityProof([
      "proven",
      "not_testable",
      "not_proven",
      "failed",
    ]);

    const response = await POST(
      request({ ...body, verdict: "failed", summaryLine: "ada/widgets #98 — failed" }),
      params
    );

    expect(response.status).toBe(201);
    expect(correctionEventKeys()).toEqual([
      `review:correction:${jobId}:AC-3`,
      `review:correction:${jobId}:AC-4`,
    ]);
  });

  it("atomically persists the complete packet set when more than 100 criteria need correction", async () => {
    const body = installVerdictPriorityProof(
      Array.from({ length: 101 }, () => "not_proven" as const)
    );

    const response = await POST(
      request({
        ...body,
        verdict: "not_proven",
        summaryLine: "ada/widgets #98 — not_proven",
      }),
      params
    );

    expect(response.status).toBe(201);
    expect(appendCurrentReviewJobEventsAtomically).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(appendCurrentReviewJobEventsAtomically).mock.calls[0]![0].events
    ).toHaveLength(101);
  });

  it("does not append correction packets when every criterion is proven or not_testable", async () => {
    const body = installVerdictPriorityProof(["proven", "not_testable"]);

    const response = await POST(
      request({
        ...body,
        verdict: "not_testable",
        summaryLine: "ada/widgets #98 — not_testable",
      }),
      params
    );

    expect(response.status).toBe(201);
    expect(correctionEventKeys()).toEqual([]);
    expect(appendCurrentReviewJobEventsAtomically).toHaveBeenCalledOnce();
  });

  it("holds before repository, token, or GitHub work when correction packet custody cannot be persisted", async () => {
    vi.mocked(appendCurrentReviewJobEventsAtomically).mockRejectedValueOnce(
      new Error("packet provenance conflicts with its deterministic event key")
    );

    const response = await POST(request(), params);

    expect(response.status).toBe(503);
    expect(correctionEventKeys()).toEqual([`review:correction:${jobId}:AC-1`]);
    expect(getRepositoryByName).not.toHaveBeenCalled();
    expect(getInstallationToken).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("maps a superseding head during correction custody to 409 before any GitHub preparation", async () => {
    vi.mocked(appendCurrentReviewJobEventsAtomically).mockRejectedValueOnce(
      new CurrentReviewJobNotCurrentError("record_not_current")
    );

    const response = await POST(request(), params);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "review job is no longer current for this pull request head",
    });
    expect(getRepositoryByName).not.toHaveBeenCalled();
    expect(getInstallationToken).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("maps a superseding head at the final attempt reservation to 409 with no fetch", async () => {
    vi.mocked(appendCurrentReviewJobEventsAtomically)
      .mockImplementationOnce(async (input) => ({
        events: input.events.map((event) => ({
          inserted: true,
          event: { eventKey: event.eventKey, payloadRef: event.payloadRef },
        })),
      }) as never)
      .mockRejectedValueOnce(
        new CurrentReviewJobNotCurrentError("record_not_current")
      );

    const response = await POST(request(), params);

    expect(response.status).toBe(409);
    expect(appendCurrentReviewJobEventsAtomically).toHaveBeenCalledTimes(2);
    expect(getRepositoryByName).toHaveBeenCalledOnce();
    expect(getInstallationToken).toHaveBeenCalledOnce();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
  });

  it("re-resolves current-head proof after reservation and never fetches when the head advanced", async () => {
    let timelineReads = 0;
    vi.mocked(readChangeRecordTimelineByPr).mockImplementation(async () => {
      timelineReads += 1;
      if (timelineReads === 1) return timeline as never;
      return {
        ...timeline,
        record: {
          ...timeline.record,
          headShas: [headSha, "b".repeat(40)],
          currentPrHeadSha: "b".repeat(40),
          currentPrHeadAuthoritative: true,
        },
      } as never;
    });

    const response = await POST(request(), params);

    expect(response.status).toBe(409);
    expect(appendCurrentReviewJobEventsAtomically).toHaveBeenCalledTimes(2);
    expect(readChangeRecordTimelineByPr).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(appendCurrentReviewJobEventsAtomically).mock.invocationCallOrder[1]
    ).toBeLessThan(
      vi.mocked(readChangeRecordTimelineByPr).mock.invocationCallOrder[1]
    );
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
  });

  it("holds a historical job even when its head remains in Record history", async () => {
    timeline.record = {
      ...timeline.record,
      headShas: [headSha, "b".repeat(40)],
      currentPrHeadSha: "b".repeat(40),
      currentPrHeadAuthoritative: true,
    };

    const response = await POST(request(), params);

    expect(response.status).toBe(409);
    expect(appendCurrentReviewJobEventsAtomically).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("holds the matching head while its authoritative pointer is blocked", async () => {
    timeline.record = {
      ...timeline.record,
      currentPrHeadAuthoritative: false,
    };

    const response = await POST(request(), params);

    expect(response.status).toBe(409);
    expect(appendCurrentReviewJobEventsAtomically).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("holds an earlier cycle after the pull request revisits the same SHA", async () => {
    timeline.record = {
      ...timeline.record,
      currentPrHeadCycleId: "job-new-cycle",
    };

    const response = await POST(request(), params);

    expect(response.status).toBe(409);
    expect(appendCurrentReviewJobEventsAtomically).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("an existing attempt with no posted receipt holds instead of issuing a duplicate GitHub write", async () => {
    timeline.events.push({
      eventKey: `review:github-attempt:${jobId}`,
      payloadRef: { kind: "unknown-or-conflicting-attempt" },
    });
    const response = await POST(request(), params);
    expect(response.status).toBe(409);
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("replays an exact stored posted receipt without a second reservation or GitHub write", async () => {
    const first = await POST(request(), params);
    expect(first.status).toBe(201);
    expect(appendCurrentReviewJobEventsAtomically).toHaveBeenCalledTimes(2);
    for (const correction of vi.mocked(appendCurrentReviewJobEventsAtomically).mock.calls[0]![0].events) {
      timeline.events.push({
        eventKey: correction.eventKey,
        payloadRef: correction.payloadRef,
      });
    }
    const postedCall = vi.mocked(appendChangeRecordEvent).mock.calls[0][0];
    timeline.events.push({
      eventKey: postedCall.eventKey,
      payloadRef: postedCall.payloadRef,
    });
    vi.mocked(appendCurrentReviewJobEventsAtomically).mockClear();
    vi.mocked(appendChangeRecordEvent).mockClear();
    vi.mocked(postGithubAdvisoryReview).mockClear();

    const replay = await POST(request(), params);

    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      posted: true,
      replayed: true,
      reviewUrl: "https://github.com/ada/widgets/pull/98#pullrequestreview-1",
    });
    expect(appendCurrentReviewJobEventsAtomically).not.toHaveBeenCalled();
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("holds a posted replay when its correction packet custody is missing, malformed, or forged", async () => {
    const first = await POST(request(), params);
    expect(first.status).toBe(201);
    const correctionEvents = vi
      .mocked(appendCurrentReviewJobEventsAtomically)
      .mock.calls[0]![0].events
      .map((input) => ({ eventKey: input.eventKey, payloadRef: { ...input.payloadRef } }));
    const posted = vi.mocked(appendChangeRecordEvent).mock.calls[0]![0];
    const plan = timeline.events[0]!;

    const cases: Array<[string, Array<{ eventKey: string; payloadRef: Record<string, unknown> }>]> = [
      ["missing", []],
      ["malformed", [{ ...correctionEvents[0]!, payloadRef: { kind: "malformed" } }]],
      ["forged", [{
        ...correctionEvents[0]!,
        payloadRef: { ...correctionEvents[0]!.payloadRef, observed: "forged observation" },
      }]],
    ];

    for (const [name, corrections] of cases) {
      timeline.events = [
        plan,
        ...corrections,
        { eventKey: posted.eventKey, payloadRef: posted.payloadRef },
      ];
      vi.mocked(appendCurrentReviewJobEventsAtomically).mockClear();
      vi.mocked(appendChangeRecordEvent).mockClear();
      vi.mocked(getRepositoryByName).mockClear();
      vi.mocked(getInstallationToken).mockClear();
      vi.mocked(postGithubAdvisoryReview).mockClear();

      const replay = await POST(request(), params);

      expect(replay.status, name).toBe(409);
      expect(appendCurrentReviewJobEventsAtomically).not.toHaveBeenCalled();
      expect(appendChangeRecordEvent).not.toHaveBeenCalled();
      expect(getRepositoryByName).not.toHaveBeenCalled();
      expect(getInstallationToken).not.toHaveBeenCalled();
      expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
    }
  });

  it("a GitHub failure leaves only the durable attempt reservation and never records a false posted receipt", async () => {
    vi.mocked(postGithubAdvisoryReview).mockResolvedValue({
      ok: false,
      status: 502,
      error: "Could not reach GitHub.",
    });
    const response = await POST(request(), params);
    expect(response.status).toBe(502);
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
    expect(correctionEventKeys()).toEqual([`review:correction:${jobId}:AC-1`]);
    expect(appendCurrentReviewJobEventsAtomically).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(appendCurrentReviewJobEventsAtomically).mock.calls[1]![0].events
    ).toEqual([
      expect.objectContaining({ eventKey: `review:github-attempt:${jobId}` }),
    ]);
  });

  it("rejects proof claims and extra artifact references without an exact stored UI receipt", async () => {
    for (const criterionResult of [
      { ...criterionResults[0], state: "proven", observed: "It passed." },
      { ...criterionResults[0], state: "failed", observed: "It failed." },
      {
        ...criterionResults[0],
        evidenceRefs: ["preview-boot:boot-1", "artifact://fabricated"],
      },
    ]) {
      const response = await POST(
        request({ ...validBody, criterionResults: [criterionResult] }),
        params
      );
      expect(response.status).toBe(409);
    }
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("posts proven or failed only from the exact stored UI receipt and its decisive screenshot", async () => {
    for (const assertionPassed of [true, false]) {
      const fixture = installUiReceipt(assertionPassed);
      const body = assertionPassed
        ? fixture.body
        : { ...fixture.body, evidenceKeys: [screenshotKey, bootLogKey] };

      const response = await POST(request(body), params);

      expect(response.status).toBe(201);
      expect(postGithubAdvisoryReview).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(postGithubAdvisoryReview).mock.calls[0][0].summary
      ).toMatch(
        new RegExp(`^\\*\\*AgentRail exact-head verification: ${fixture.result.state}\\.\\*\\*`)
      );
      vi.mocked(appendChangeRecordEvent).mockClear();
      vi.mocked(postGithubAdvisoryReview).mockClear();
    }
  });

  it("keeps a planned executable UI criterion at preview-only not_proven until a result receipt exists", async () => {
    installUiReceipt();
    timeline.events = timeline.events.slice(0, 1);

    const response = await POST(request(validBody), params);

    expect(response.status).toBe(201);
    expect(postGithubAdvisoryReview).toHaveBeenCalledTimes(1);
  });

  it("keeps a valid screenshot reservation without a final result at preview-only not_proven", async () => {
    installUiReceipt();
    timeline.events = timeline.events.filter(
      (event) => !event.eventKey.includes(":ui-result:")
    );

    const response = await POST(request(validBody), params);

    expect(response.status).toBe(201);
    expect(postGithubAdvisoryReview).toHaveBeenCalledTimes(1);
  });

  it("does not downgrade an existing UI receipt to the preview-only R7.1 outcome", async () => {
    installUiReceipt();

    const response = await POST(request(validBody), params);

    expect(response.status).toBe(409);
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("holds forged or mismatched UI execution custody before reserving a GitHub write", async () => {
    const cases: Array<[string, (fixture: ReturnType<typeof installUiReceipt>) => void]> = [
      ["attempt", () => {
        timeline.events = timeline.events.filter(
          (event) => !event.eventKey.includes(":ui-attempt:")
        );
      }],
      ["attempt plan", (fixture) => {
        const event = timeline.events.find((candidate) =>
          candidate.eventKey.includes(":ui-attempt:")
        )!;
        event.payloadRef = { ...fixture.attempt, planDigest: "forged" };
      }],
      ["attempt execution", (fixture) => {
        const event = timeline.events.find((candidate) =>
          candidate.eventKey.includes(":ui-attempt:")
        )!;
        event.payloadRef = { ...fixture.attempt, executionId: "ui-forged" };
      }],
      ["result execution", (fixture) => {
        const event = timeline.events.find((candidate) =>
          candidate.eventKey.includes(":ui-result:")
        )!;
        event.payloadRef = { ...fixture.result, executionId: "ui-forged" };
      }],
      ["result head", (fixture) => {
        const event = timeline.events.find((candidate) =>
          candidate.eventKey.includes(":ui-result:")
        )!;
        event.payloadRef = { ...fixture.result, headSha: "foreign-head" };
      }],
      ["missing screenshot reservation", () => {
        timeline.events = timeline.events.filter(
          (event) => !event.eventKey.includes(":ui-screenshot:")
        );
      }],
      ["mismatched screenshot reservation", (fixture) => {
        const event = timeline.events.find((candidate) =>
          candidate.eventKey.includes(":ui-screenshot:")
        )!;
        event.payloadRef = buildReviewJobUiScreenshotReservation({
          ...fixture.result,
          artifactKey: "review-evidence/competing.png",
        });
      }],
      ["stored plan", () => {
        const event = timeline.events[0]!;
        const payload = event.payloadRef as typeof planPayload;
        event.payloadRef = {
          ...payload,
          plans: [{
            ...payload.plans[0],
            uiSteps: [
              { action: "open", path: "/saved-values" },
              { action: "expect_text", text: "Different text" },
              { action: "screenshot", label: "saved-value" },
            ],
          }],
        };
      }],
      ["boot tuple", () => {
        vi.mocked(getPreviewBoot).mockResolvedValueOnce({
          id: "boot-1",
          workspaceId,
          repo: job.repo,
          prNumber: job.prNumber,
          headSha: "foreign-head",
          status: "ready",
          url: previewUrl,
          bootLogKey,
        } as never);
      }],
      ["boot URL", () => {
        vi.mocked(getPreviewBoot).mockResolvedValueOnce({
          id: "boot-1",
          workspaceId,
          repo: job.repo,
          prNumber: job.prNumber,
          headSha,
          status: "ready",
          url: "http://127.0.0.1:49999",
          bootLogKey,
        } as never);
      }],
      ["result observation", (fixture) => {
        const event = timeline.events.find((candidate) =>
          candidate.eventKey.includes(":ui-result:")
        )!;
        event.payloadRef = { ...fixture.result, observed: "forged" };
      }],
    ];

    for (const [name, arrange] of cases) {
      const fixture = installUiReceipt();
      arrange(fixture);
      const response = await POST(request(fixture.body), params);
      expect(response.status, name).toBe(409);
    }
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("holds preview-only fallback when a stored UI result is present but invalid", async () => {
    for (const mutation of [
      { executionId: "ui-forged" },
      { headSha: "foreign-head" },
      { observed: "forged" },
    ]) {
      const fixture = installUiReceipt();
      const event = timeline.events.find((candidate) =>
        candidate.eventKey.includes(":ui-result:")
      )!;
      event.payloadRef = { ...fixture.result, ...mutation };

      const response = await POST(request(validBody), params);

      expect(response.status).toBe(409);
    }
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("posts exact API proven and failed receipts, with their JSON custody key", async () => {
    for (const observedStatus of [200, 503]) {
      const fixture = installApiReceipt(observedStatus);
      const response = await POST(request(fixture.body), params);

      expect(response.status).toBe(201);
      expect(vi.mocked(postGithubAdvisoryReview).mock.calls[0]?.[0].summary)
        .toContain(`AgentRail exact-head verification: ${fixture.result.state}`);
      expect(fixture.body.evidenceKeys).toEqual([apiEvidenceKey]);
      vi.mocked(appendChangeRecordEvent).mockClear();
      vi.mocked(postGithubAdvisoryReview).mockClear();
    }
  });

  it("holds malformed, result-only, mismatched, and present-invalid API receipts before GitHub", async () => {
    const cases: Array<[string, (fixture: ReturnType<typeof installApiReceipt>) => void, Record<string, unknown> | null]> = [
      ["result-only", () => { timeline.events = timeline.events.filter((event) => !event.eventKey.includes(":api-attempt:")); }, null],
      ["missing reservation", () => { timeline.events = timeline.events.filter((event) => !event.eventKey.includes(":api-card:")); }, null],
      ["attempt plan", (fixture) => {
        const event = timeline.events.find((candidate) => candidate.eventKey.includes(":api-attempt:"))!;
        event.payloadRef = { ...fixture.attempt, planDigest: "forged" };
      }, null],
      ["result head", (fixture) => {
        const event = timeline.events.find((candidate) => candidate.eventKey.includes(":api-result:"))!;
        event.payloadRef = { ...fixture.result, headSha: "foreign-head" };
      }, null],
      ["reservation artifact", (fixture) => {
        const event = timeline.events.find((candidate) => candidate.eventKey.includes(":api-card:"))!;
        event.payloadRef = buildReviewJobApiCardReservation({ ...fixture.result, artifactKey: "review-evidence/competing.json" });
      }, null],
      ["boot tuple", () => {}, { headSha: "foreign-head" }],
      ["boot URL", () => {}, { url: "http://127.0.0.1:49999" }],
      ["result observation", (fixture) => {
        const event = timeline.events.find((candidate) => candidate.eventKey.includes(":api-result:"))!;
        event.payloadRef = { ...fixture.result, observed: "forged" };
      }, null],
    ];

    for (const [name, arrange, bootOverride] of cases) {
      const fixture = installApiReceipt();
      arrange(fixture);
      if (bootOverride) {
        vi.mocked(getPreviewBoot).mockResolvedValueOnce({
          id: "boot-1", workspaceId, repo: job.repo, prNumber: job.prNumber,
          headSha, status: "ready", url: previewUrl, bootLogKey, ...bootOverride,
        } as never);
      }
      const response = await POST(request(fixture.body), params);
      expect(response.status, name).toBe(409);
    }
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("permits only absent or one exact pending API reservation to use the R7.1 preview fallback", async () => {
    installApiReceipt();
    timeline.events = timeline.events.slice(0, 1);
    expect((await POST(request(validBody), params)).status).toBe(201);
    vi.mocked(appendChangeRecordEvent).mockClear();
    vi.mocked(postGithubAdvisoryReview).mockClear();

    installApiReceipt();
    timeline.events = timeline.events.filter((event) => !event.eventKey.includes(":api-result:"));
    expect((await POST(request(validBody), params)).status).toBe(201);
    vi.mocked(appendChangeRecordEvent).mockClear();
    vi.mocked(postGithubAdvisoryReview).mockClear();

    const invalid = installApiReceipt();
    const resultEvent = timeline.events.find((event) => event.eventKey.includes(":api-result:"))!;
    resultEvent.payloadRef = { ...invalid.result, observed: "forged" };
    expect((await POST(request(validBody), params)).status).toBe(409);
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("gives an exact failed API receipt priority over a proven API receipt", async () => {
    const body = installApiVerdictPriorityProof();
    const rejected = await POST(request({ ...body, verdict: "proven", summaryLine: "ada/widgets #98 — proven" }), params);
    expect(rejected.status).toBe(409);

    const accepted = await POST(request(body), params);
    expect(accepted.status).toBe(201);
    expect(vi.mocked(postGithubAdvisoryReview).mock.calls[0]?.[0].summary)
      .toContain("AgentRail exact-head verification: failed");
  });

  it("posts exact data proven and decisive failed receipts with their card key", async () => {
    for (const status of [200, 503]) {
      const fixture = installDataReceipt(status);
      const response = await POST(request(fixture.body), params);
      expect(response.status).toBe(201);
      expect(vi.mocked(postGithubAdvisoryReview).mock.calls[0]?.[0].summary)
        .toContain(`AgentRail exact-head verification: ${fixture.result.state}`);
      expect(fixture.body.evidenceKeys).toEqual([dataEvidenceKey]);
      vi.mocked(appendChangeRecordEvent).mockClear();
      vi.mocked(postGithubAdvisoryReview).mockClear();
    }
  });

  it("gives a failed data receipt priority over a proven data receipt and requires both exact card keys", async () => {
    const body = installDataVerdictPriorityProof();
    const rejected = await POST(request({ ...body, verdict: "proven", summaryLine: "ada/widgets #98 — proven" }), params);
    expect(rejected.status).toBe(409);

    const accepted = await POST(request(body), params);
    expect(accepted.status).toBe(201);
    expect(body.evidenceKeys).toEqual([`${dataEvidenceKey}.0`, `${dataEvidenceKey}.1`]);
    expect(vi.mocked(postGithubAdvisoryReview).mock.calls[0]?.[0].summary)
      .toContain("AgentRail exact-head verification: failed");
  });

  it("permits absent or one exact pending data receipt only for the R7.1 preview fallback", async () => {
    installDataReceipt();
    timeline.events = timeline.events.slice(0, 1);
    expect((await POST(request(validBody), params)).status).toBe(201);
    vi.mocked(appendChangeRecordEvent).mockClear();
    vi.mocked(postGithubAdvisoryReview).mockClear();

    installDataReceipt();
    timeline.events = timeline.events.filter((event) => !event.eventKey.includes(":data-result:"));
    expect((await POST(request(validBody), params)).status).toBe(201);
    vi.mocked(appendChangeRecordEvent).mockClear();
    vi.mocked(postGithubAdvisoryReview).mockClear();

    const invalid = installDataReceipt();
    const result = timeline.events.find((event) => event.eventKey.includes(":data-result:"))!;
    result.payloadRef = { ...invalid.result, observed: "forged" };
    expect((await POST(request(validBody), params)).status).toBe(409);
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("holds present-invalid data result, reservation, attempt, plan, boot, artifact, observation, and state before GitHub", async () => {
    const cases: Array<[string, (fixture: ReturnType<typeof installDataReceipt>) => void, Record<string, unknown> | null]> = [
      ["result-only", () => { timeline.events = timeline.events.filter((event) => !event.eventKey.includes(":data-attempt:")); }, null],
      ["missing reservation", () => { timeline.events = timeline.events.filter((event) => !event.eventKey.includes(":data-card:")); }, null],
      ["attempt plan", (fixture) => { const event = timeline.events.find((candidate) => candidate.eventKey.includes(":data-attempt:"))!; event.payloadRef = { ...fixture.attempt, planDigest: "forged" }; }, null],
      ["stored plan", () => { const event = timeline.events[0]!; event.payloadRef = { ...event.payloadRef, plans: [{ ...(event.payloadRef.plans as Array<Record<string, unknown>>)[0]!, dataRequest: storedDataRequest("/other") }] }; }, null],
      ["result head", (fixture) => { const event = timeline.events.find((candidate) => candidate.eventKey.includes(":data-result:"))!; event.payloadRef = { ...fixture.result, headSha: "foreign-head" }; }, null],
      ["reservation artifact", (fixture) => { const event = timeline.events.find((candidate) => candidate.eventKey.includes(":data-card:"))!; event.payloadRef = buildReviewJobDataCardReservation({ ...fixture.result, artifactKey: "review-evidence/competing.json" }); }, null],
      ["result assertions", (fixture) => { const event = timeline.events.find((candidate) => candidate.eventKey.includes(":data-result:"))!; event.payloadRef = { ...fixture.result, assertions: [{ ...fixture.result.assertions[0], passed: false }] }; }, null],
      ["raw matched scalar result", (fixture) => { const event = timeline.events.find((candidate) => candidate.eventKey.includes(":data-result:"))!; event.payloadRef = { ...fixture.result, assertions: [{ ...fixture.result.assertions[0], observed: true }] }; }, null],
      ["raw matched scalar card", (fixture) => { const event = timeline.events.find((candidate) => candidate.eventKey.includes(":data-card:"))!; event.payloadRef = { ...event.payloadRef, result: { ...fixture.result, assertions: [{ ...fixture.result.assertions[0], observed: true }] } }; }, null],
      ["result state", (fixture) => { const event = timeline.events.find((candidate) => candidate.eventKey.includes(":data-result:"))!; event.payloadRef = { ...fixture.result, state: "failed" }; }, null],
      ["boot tuple", () => {}, { headSha: "foreign-head" }],
      ["boot URL", () => {}, { url: "http://127.0.0.1:49999" }],
    ];
    for (const [name, arrange, bootOverride] of cases) {
      const fixture = installDataReceipt(); arrange(fixture);
      if (bootOverride) vi.mocked(getPreviewBoot).mockResolvedValueOnce({ id: "boot-1", workspaceId, repo: job.repo, prNumber: job.prNumber, headSha, status: "ready", url: previewUrl, bootLogKey, ...bootOverride } as never);
      expect((await POST(request(fixture.body), params)).status, name).toBe(409);
    }
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("requires one exact data card evidence key and does not downgrade a valid data receipt", async () => {
    for (const evidenceKeys of [[], [bootLogKey], [dataEvidenceKey, dataEvidenceKey], [dataEvidenceKey, "review-evidence/fabricated.json"], ["review-evidence/fabricated.json"]]) {
      const fixture = installDataReceipt();
      expect((await POST(request({ ...fixture.body, evidenceKeys }), params)).status, JSON.stringify(evidenceKeys)).toBe(409);
    }
    installDataReceipt();
    expect((await POST(request(validBody), params)).status).toBe(409);
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("requires the receipt screenshot key exactly once and allows only its current boot log beside it", async () => {
    for (const evidenceKeys of [
      [],
      [bootLogKey],
      [screenshotKey, screenshotKey],
      [screenshotKey, "review-evidence/fabricated.png"],
      ["review-evidence/fabricated.png"],
    ]) {
      const fixture = installUiReceipt();
      const response = await POST(
        request({ ...fixture.body, evidenceKeys }),
        params
      );
      expect(response.status, JSON.stringify(evidenceKeys)).toBe(409);
    }
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("holds caller changes to the receipt state, expected value, observation, reference, or artifact", async () => {
    const mutations = [
      { state: "failed" },
      { expected: "Different expected behavior." },
      { observed: "The caller says it passed." },
      { evidenceRefs: ["review-ui-execution:forged"] },
    ];
    for (const mutation of mutations) {
      const fixture = installUiReceipt();
      const criterionResult = {
        ...fixture.body.criterionResults[0],
        ...mutation,
      };
      const response = await POST(
        request({
          ...fixture.body,
          criterionResults: [criterionResult],
          verdict: criterionResult.state,
        }),
        params
      );
      expect(response.status).toBe(409);
    }
    const fixture = installUiReceipt();
    const artifactMismatch = await POST(
      request({
        ...fixture.body,
        evidenceKeys: ["review-evidence/other.png"],
      }),
      params
    );
    expect(artifactMismatch.status).toBe(409);
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("derives mixed-criterion verdicts in failed, not_proven, not_testable, proven priority order", async () => {
    const cases = [
      {
        states: ["proven", "not_testable"] as const,
        rejectedVerdict: "proven",
        expectedVerdict: "not_testable",
      },
      {
        states: ["proven", "not_testable", "not_proven"] as const,
        rejectedVerdict: "not_testable",
        expectedVerdict: "not_proven",
      },
      {
        states: ["proven", "not_testable", "not_proven", "failed"] as const,
        rejectedVerdict: "not_proven",
        expectedVerdict: "failed",
      },
    ];

    for (const testCase of cases) {
      const body = installVerdictPriorityProof([...testCase.states]);
      const rejected = await POST(
        request({
          ...body,
          verdict: testCase.rejectedVerdict,
          summaryLine: `ada/widgets #98 — ${testCase.rejectedVerdict}`,
        }),
        params
      );
      expect(rejected.status).toBe(409);

      const accepted = await POST(
        request({
          ...body,
          verdict: testCase.expectedVerdict,
          summaryLine: `ada/widgets #98 — ${testCase.expectedVerdict}`,
        }),
        params
      );
      expect(accepted.status).toBe(201);
      vi.mocked(appendChangeRecordEvent).mockClear();
      vi.mocked(postGithubAdvisoryReview).mockClear();
    }
  });

  it("accepts a server-custodied before-ready boot failure only as not_testable", async () => {
    const reason = "preview command exited 1";
    vi.mocked(getPreviewBoot).mockResolvedValue({
      id: "boot-1",
      workspaceId,
      repo: job.repo,
      prNumber: job.prNumber,
      headSha,
      status: "failed",
      url: null,
      reason,
      bootLogKey,
    } as never);
    const result = {
      ...criterionResults[0],
      state: "not_testable",
      observed: r7UnavailablePreviewObservation({ status: "failed", reason }),
    };

    const response = await POST(
      request({
        ...validBody,
        criterionResults: [result],
        verdict: "not_testable",
        summaryLine: "ada/widgets #98 — not_testable",
      }),
      params
    );

    expect(response.status).toBe(201);
    expect(postGithubAdvisoryReview).toHaveBeenCalledTimes(1);
  });

  it("holds in-flight, failed-after-ready, and reasonless terminal boots", async () => {
    for (const boot of [
      { status: "pending", url: null, reason: null },
      { status: "ready", url: null, reason: null },
      { status: "failed", url: "http://127.0.0.1:43123", reason: "stale" },
      { status: "failed", url: null, reason: "   " },
      { status: "failed", url: null, reason: "line one\nline two" },
      { status: "failed", url: null, reason: "x".repeat(2001) },
      { status: "torn_down", url: null, reason: null },
    ]) {
      vi.mocked(getPreviewBoot).mockResolvedValueOnce({
        id: "boot-1",
        workspaceId,
        repo: job.repo,
        prNumber: job.prNumber,
        headSha,
        bootLogKey,
        ...boot,
      } as never);
      const response = await POST(request(), params);
      expect(response.status).toBe(409);
    }
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("rejects evidenceKeys that are not custodied on the exact boot row", async () => {
    const response = await POST(
      request({ ...validBody, evidenceKeys: ["review-evidence/fabricated.png"] }),
      params
    );

    expect(response.status).toBe(409);
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("posts only the exact custodied job receipt; a trigger/readback/assertion mismatch is not_proven", async () => {
    for (const [args, expectedState] of [
      [{}, "proven"],
      [{ triggerStatus: 503, readbackStatus: null }, "not_proven"],
      [{ readbackStatus: 503 }, "not_proven"],
      [{ observedValue: "running" }, "not_proven"],
    ] as const) {
      const fixture = installJobReceipt(args);
      const response = await POST(request(fixture.body), params);
      expect(response.status).toBe(201);
      expect(fixture.body.verdict).toBe(fixture.result.state);
      expect(fixture.result.state).toBe(expectedState);
      vi.mocked(appendChangeRecordEvent).mockClear();
      vi.mocked(postGithubAdvisoryReview).mockClear();
    }
  });

  it("permits only an absent or exact pending job receipt to use R7.1 fallback; no job receipt can attest failed", async () => {
    installJobReceipt();
    timeline.events = timeline.events.slice(0, 1);
    expect((await POST(request(validBody), params)).status).toBe(201);
    vi.mocked(appendChangeRecordEvent).mockClear();
    vi.mocked(postGithubAdvisoryReview).mockClear();

    installJobReceipt();
    timeline.events = timeline.events.filter((event) => !event.eventKey.includes(":job-result:"));
    expect((await POST(request(validBody), params)).status).toBe(201);
    vi.mocked(appendChangeRecordEvent).mockClear();
    vi.mocked(postGithubAdvisoryReview).mockClear();

    const fixture = installJobReceipt();
    expect((await POST(request(validBody), params)).status).toBe(409);
    expect((await POST(request({ ...fixture.body, verdict: "failed", summaryLine: "ada/widgets #98 — failed", criterionResults: [{ ...fixture.body.criterionResults[0], state: "failed" }] }), params)).status).toBe(409);
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("holds malformed or mismatched job custody before GitHub", async () => {
    const cases: Array<[string, (fixture: ReturnType<typeof installJobReceipt>) => void, Record<string, unknown> | null]> = [
      ["result-only", () => { timeline.events = timeline.events.filter((event) => !event.eventKey.includes(":job-attempt:")); }, null],
      ["missing reservation", () => { timeline.events = timeline.events.filter((event) => !event.eventKey.includes(":job-card:")); }, null],
      ["attempt", (fixture) => { const event = timeline.events.find((item) => item.eventKey.includes(":job-attempt:"))!; event.payloadRef = { ...fixture.attempt, planDigest: "forged" }; }, null],
      ["plan", () => { timeline.events[0]!.payloadRef = { ...timeline.events[0]!.payloadRef, plans: [{ ...(timeline.events[0]!.payloadRef.plans as Array<Record<string, unknown>>)[0]!, jobRequest: storedJobRequest("other") }] }; }, null],
      ["head", (fixture) => { const event = timeline.events.find((item) => item.eventKey.includes(":job-result:"))!; event.payloadRef = { ...fixture.result, headSha: "foreign" }; }, null],
      ["reservation", (fixture) => { const event = timeline.events.find((item) => item.eventKey.includes(":job-card:"))!; event.payloadRef = buildReviewJobCardReservation({ ...fixture.result, artifactKey: "review-evidence/competing.json" }); }, null],
      ["observation", (fixture) => { const event = timeline.events.find((item) => item.eventKey.includes(":job-result:"))!; event.payloadRef = { ...fixture.result, assertions: [{ ...fixture.result.assertions[0], observed: "[REDACTED_MISMATCH]", observedHmacSha256: "f".repeat(64), passed: false }] }; }, null],
      ["HMAC", (fixture) => { const event = timeline.events.find((item) => item.eventKey.includes(":job-result:"))!; event.payloadRef = { ...fixture.result, assertions: [{ ...fixture.result.assertions[0], observedHmacSha256: "f".repeat(64) }] }; }, null],
      ["state", (fixture) => { const event = timeline.events.find((item) => item.eventKey.includes(":job-result:"))!; event.payloadRef = { ...fixture.result, state: "failed" }; }, null],
      ["boot", () => {}, { headSha: "foreign" }],
      ["artifact boot", () => {}, { url: "http://127.0.0.1:49999" }],
    ];
    for (const [name, arrange, bootOverride] of cases) {
      const fixture = installJobReceipt(); arrange(fixture);
      if (bootOverride) vi.mocked(getPreviewBoot).mockResolvedValueOnce({ id: "boot-1", workspaceId, repo: job.repo, prNumber: job.prNumber, headSha, status: "ready", url: previewUrl, bootLogKey, ...bootOverride } as never);
      expect((await POST(request(fixture.body), params)).status, name).toBe(409);
    }
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("requires exactly the job card key and cannot downgrade a valid job receipt", async () => {
    for (const evidenceKeys of [[], [bootLogKey], [jobEvidenceKey, jobEvidenceKey], [jobEvidenceKey, "review-evidence/extra.json"], ["review-evidence/extra.json"]]) {
      const fixture = installJobReceipt();
      expect((await POST(request({ ...fixture.body, evidenceKeys }), params)).status, JSON.stringify(evidenceKeys)).toBe(409);
    }
    installJobReceipt();
    expect((await POST(request(validBody), params)).status).toBe(409);
  });
});
