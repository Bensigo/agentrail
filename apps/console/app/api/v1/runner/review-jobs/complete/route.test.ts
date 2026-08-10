import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  appendChangeRecordEvent: vi.fn(),
  completeReviewJob: vi.fn(),
  findOrCreateChangeRecord: vi.fn(),
  getPreviewBoot: vi.fn(),
  getReviewJobById: vi.fn(),
  readAcceptanceContracts: vi.fn(),
  readChangeRecordTimelineByPr: vi.fn(),
}));
// The notify module is mocked wholesale, same convention as
// runner/result/route.test.ts's `vi.mock("./notify", ...)` — this route's
// own tests only need to prove IT calls the existing notify machinery
// correctly; the machinery's own channel-routing behavior is covered by
// notify.test.ts.
vi.mock("../../result/notify", () => ({
  sendWorkspaceNotification: vi.fn(),
}));

import { POST } from "./route";
import {
  appendChangeRecordEvent,
  completeReviewJob,
  findOrCreateChangeRecord,
  getPreviewBoot,
  getReviewJobById,
  readAcceptanceContracts,
  readChangeRecordTimelineByPr,
} from "@agentrail/db-postgres";
import { sendWorkspaceNotification } from "../../result/notify";
import {
  R7_READY_NOT_PROVEN_OBSERVATION,
  type CriterionResult,
  type ExactReviewJobProof,
  r7UnavailablePreviewObservation,
  reviewOutcomeDigest,
} from "../../../../../../lib/review-job-proof-attestation";
import {
  buildReviewJobUiAttempt,
  buildReviewJobUiResult,
  buildReviewJobUiScreenshotReservation,
  reviewJobUiAttemptEventKey,
  reviewJobUiResultEventKey,
  reviewJobUiScreenshotReservationEventKey,
} from "../../../../../../lib/review-job-ui-execution";
import {
  buildReviewJobApiAttempt,
  buildReviewJobApiCardReservation,
  buildReviewJobApiResult,
  reviewJobApiAttemptEventKey,
  reviewJobApiCardReservationEventKey,
  reviewJobApiResultEventKey,
} from "../../../../../../lib/review-job-api-execution";

const mockAppendChangeRecordEvent = vi.mocked(appendChangeRecordEvent);
const mockComplete = vi.mocked(completeReviewJob);
const mockFindOrCreateChangeRecord = vi.mocked(findOrCreateChangeRecord);
const mockGetPreviewBoot = vi.mocked(getPreviewBoot);
const mockGetReviewJobById = vi.mocked(getReviewJobById);
const mockReadAcceptanceContracts = vi.mocked(readAcceptanceContracts);
const mockReadChangeRecordTimelineByPr = vi.mocked(readChangeRecordTimelineByPr);
const mockNotify = vi.mocked(sendWorkspaceNotification);

// Central-secret auth — same idiom as the sibling claim route's tests.
const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

const NOW = new Date("2026-08-01T00:00:00.000Z");
const PREVIEW_BOOT_ID = "11111111-1111-5111-8111-111111111111";
const BOOT_LOG_KEY =
  "review-evidence/ws-1/acme__widgets/42/aaaaaaaa/boot.log";
const SCREENSHOT_KEY =
  "review-evidence/ws-1/acme__widgets/42/aaaaaaaa/AC-1/exact.png";
const API_EVIDENCE_KEY =
  "review-evidence/ws-1/acme__widgets/42/aaaaaaaa/AC-1/response.json";
const PREVIEW_URL = "http://preview.internal:4173";

const POSTED_JOB = {
  id: "job-1",
  workspaceId: "ws-1",
  repo: "acme/widgets",
  prNumber: 42,
  headSha: "a".repeat(40),
  event: "opened",
  state: "posted",
  attempts: 0,
  claimedBy: "worker-1",
  claimedAt: NOW,
  nextEligibleAt: null,
  postedReviewUrl: "https://github.com/acme/widgets/pull/42#pullrequestreview-1",
  verdict: "not_proven",
  skipReason: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const CHANGE_RECORD = {
  id: "record-1",
  workspaceId: "ws-1",
  repo: "acme/widgets",
  issueNumber: null,
  prNumber: 42,
  headShas: ["a".repeat(40)],
  mergedSha: null,
  state: "open",
  createdAt: NOW,
  updatedAt: NOW,
};

const CHANGE_RECORD_EVENT = {
  id: "event-1",
  recordId: "record-1",
  eventKey: "review:posted:job-1",
  stage: "review",
  actor: "reviewer-of-record",
  payloadRef: { kind: "review_job", jobId: "job-1" },
  at: NOW,
  createdAt: NOW,
};

const FAILED_JOB = {
  ...POSTED_JOB,
  state: "queued",
  postedReviewUrl: null,
  verdict: null,
  skipReason: null,
};

const RUNNING_JOB = {
  ...POSTED_JOB,
  state: "running",
  postedReviewUrl: null,
  verdict: null,
};

const CONFIRMED_CONTRACT = [{
  id: "contract-1",
  status: "confirmed",
  version: 2,
  contract: {
    acceptanceCriteria: [
      { id: "AC-1", text: "The saved value is visible.", userVisible: true },
    ],
  },
}];

const PLAN_EVENT = {
  id: "event-plan-1",
  recordId: "record-1",
  eventKey: "verification:plan:job-1",
  stage: "verification",
  actor: "jace:review-verification-planner",
  payloadRef: {
    kind: "review_job_verification_plan",
    jobId: "job-1",
    workspaceId: "ws-1",
    repo: "acme/widgets",
    prNumber: 42,
    headSha: "a".repeat(40),
    recordId: "record-1",
    acceptanceContractId: "contract-1",
    acceptanceContractVersion: 2,
    plannedBy: "jace:review-job-worker",
    plans: [{
      criterionId: "AC-1",
      criterionTextSnapshot: "The saved value is visible.",
      modality: "ui",
      environmentKind: "isolated_preview",
      flow: "Save the value, reload, and verify it remains visible.",
      status: "planned",
      notTestableReason: null,
    }],
  },
  at: NOW,
  createdAt: NOW,
};

const CONTRACT_TIMELINE = {
  record: CHANGE_RECORD,
  events: [PLAN_EVENT],
};

let latestRequestBody: Record<string, unknown> | null = null;

function timelineWithPostedAttestation(
  base: { record: typeof CHANGE_RECORD; events: unknown[] },
  body: Record<string, unknown> | null = latestRequestBody
) {
  const criterionResults = Array.isArray(body?.criterionResults)
    ? body.criterionResults
    : null;
  if (!criterionResults) return base;
  const outcomeDigest = reviewOutcomeDigest({
    criterionResults: criterionResults as CriterionResult[],
    verdict: typeof body?.verdict === "string" ? body.verdict : undefined,
    summaryLine: typeof body?.summaryLine === "string" ? body.summaryLine : undefined,
    evidenceKeys: Array.isArray(body?.evidenceKeys)
      ? (body.evidenceKeys as string[])
      : undefined,
  });
  return {
    ...base,
    events: [
      ...base.events,
      {
        id: "event-github-posted-1",
        recordId: "record-1",
        eventKey: "review:github-posted:job-1",
        stage: "review",
        actor: "reviewer-of-record",
        payloadRef: {
          kind: "review_job_github_posted",
          jobId: "job-1",
          workspaceId: "ws-1",
          repo: "acme/widgets",
          prNumber: 42,
          headSha: "a".repeat(40),
          recordId: "record-1",
          acceptanceContractId: "contract-1",
          acceptanceContractVersion: 2,
          outcomeDigest,
          postPayloadDigest: "test-post-payload-digest",
          postedReviewUrl:
            "https://github.com/acme/widgets/pull/42#pullrequestreview-1",
        },
        at: NOW,
        createdAt: NOW,
      },
    ],
  };
}

function postReq(body: unknown, withAuth = true): NextRequest {
  latestRequestBody =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  return new NextRequest("http://localhost/api/v1/runner/review-jobs/complete", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${SECRET}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function rawReq(rawBody: string, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/review-jobs/complete", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${SECRET}` } : {}),
    },
    body: rawBody,
  });
}

const VALID_POSTED_BODY = {
  jobId: "job-1",
  outcome: "posted" as const,
  postedReviewUrl: "https://github.com/acme/widgets/pull/42#pullrequestreview-1",
  verdict: "not_proven",
  summaryLine: "AgentRail review posted for acme/widgets#42 — not_proven",
  criterionResults: [{
    criterionId: "AC-1",
    state: "not_proven",
    expected: "The saved value is visible.",
    observed: R7_READY_NOT_PROVEN_OBSERVATION,
    evidenceRefs: [`preview-boot:${PREVIEW_BOOT_ID}`],
  }],
};

const UI_STEPS = [
  { action: "open", path: "/saved-values" },
  { action: "expect_text", text: "Saved value" },
  { action: "screenshot", label: "saved-value" },
] as const;

function uiReceiptFixture(assertionPassed = true) {
  const planEvent = {
    ...PLAN_EVENT,
    payloadRef: {
      ...PLAN_EVENT.payloadRef,
      plans: [{ ...PLAN_EVENT.payloadRef.plans[0], uiSteps: [...UI_STEPS] }],
    },
  };
  const receiptTimeline: {
    record: typeof CHANGE_RECORD;
    events: Array<{ eventKey: string; payloadRef: Record<string, unknown> }>;
  } = {
    record: CHANGE_RECORD,
    events: [planEvent],
  };
  const proof = {
    job: RUNNING_JOB,
    timeline: receiptTimeline,
    contract: {
      id: CONFIRMED_CONTRACT[0]!.id,
      version: CONFIRMED_CONTRACT[0]!.version,
      criteria: CONFIRMED_CONTRACT[0]!.contract.acceptanceCriteria,
    },
    verificationPlan: planEvent.payloadRef,
  } as unknown as ExactReviewJobProof;
  const plan = proof.verificationPlan.plans[0];
  const boot = {
    id: PREVIEW_BOOT_ID,
    workspaceId: RUNNING_JOB.workspaceId,
    repo: RUNNING_JOB.repo,
    prNumber: RUNNING_JOB.prNumber,
    headSha: RUNNING_JOB.headSha,
    status: "ready",
    url: PREVIEW_URL,
  };
  const attempt = buildReviewJobUiAttempt({ proof, plan, boot })!;
  const result = buildReviewJobUiResult({
    attempt,
    plan,
    assertionPassed,
    artifactKey: SCREENSHOT_KEY,
    contentType: "image/png",
    contentSha256: "d".repeat(64),
    observedUrl: `${PREVIEW_URL}/saved-values`,
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
  return {
    attempt,
    result,
    plan,
    timeline: receiptTimeline,
    body: {
      ...VALID_POSTED_BODY,
      verdict: result.state,
      summaryLine: `AgentRail review posted for acme/widgets#42 — ${result.state}`,
      criterionResults: [{
        criterionId: "AC-1",
        state: result.state,
        expected: result.expected,
        observed: result.observed,
        evidenceRefs: [result.evidenceRef],
      }],
      evidenceKeys: [SCREENSHOT_KEY],
    },
  };
}

function apiReceiptFixture(observedStatus = 200) {
  const apiRequest = { method: "GET", path: "/health", expectedStatus: 200 };
  const planEvent = {
    ...PLAN_EVENT,
    payloadRef: {
      ...PLAN_EVENT.payloadRef,
      plans: [{
        ...PLAN_EVENT.payloadRef.plans[0],
        modality: "api",
        flow: "Request the bounded health endpoint and inspect its status.",
        uiSteps: null,
        apiRequest,
      }],
    },
  };
  const receiptTimeline: {
    record: typeof CHANGE_RECORD;
    events: Array<{ eventKey: string; payloadRef: Record<string, unknown> }>;
  } = { record: CHANGE_RECORD, events: [planEvent] };
  const proof = {
    job: RUNNING_JOB,
    timeline: receiptTimeline,
    contract: {
      id: CONFIRMED_CONTRACT[0]!.id,
      version: CONFIRMED_CONTRACT[0]!.version,
      criteria: CONFIRMED_CONTRACT[0]!.contract.acceptanceCriteria,
    },
    verificationPlan: planEvent.payloadRef,
  } as unknown as ExactReviewJobProof;
  const plan = proof.verificationPlan.plans[0];
  const boot = {
    id: PREVIEW_BOOT_ID, workspaceId: RUNNING_JOB.workspaceId, repo: RUNNING_JOB.repo,
    prNumber: RUNNING_JOB.prNumber, headSha: RUNNING_JOB.headSha,
    status: "ready", url: PREVIEW_URL,
  };
  const attempt = buildReviewJobApiAttempt({ proof, plan, boot })!;
  const result = buildReviewJobApiResult({
    attempt, plan, observedStatus, artifactKey: API_EVIDENCE_KEY,
    contentSha256: "e".repeat(64),
  })!;
  mockReadAcceptanceContracts.mockResolvedValue([{
    ...CONFIRMED_CONTRACT[0]!,
    contract: {
      acceptanceCriteria: CONFIRMED_CONTRACT[0]!.contract.acceptanceCriteria.map((criterion) => ({
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
  return {
    attempt, result, plan, timeline: receiptTimeline,
    body: {
      ...VALID_POSTED_BODY,
      verdict: result.state,
      summaryLine: `AgentRail review posted for acme/widgets#42 — ${result.state}`,
      criterionResults: [{
        criterionId: "AC-1", state: result.state, expected: result.expected,
        observed: result.observed, evidenceRefs: [result.evidenceRef],
      }],
      evidenceKeys: [API_EVIDENCE_KEY],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  latestRequestBody = VALID_POSTED_BODY;
  process.env[ENV_KEY] = SECRET;
  mockComplete.mockResolvedValue(null as never);
  mockGetPreviewBoot.mockResolvedValue({
    id: PREVIEW_BOOT_ID,
    workspaceId: "ws-1",
    repo: "acme/widgets",
    prNumber: 42,
    headSha: "a".repeat(40),
    status: "ready",
    url: "http://preview.internal:4173",
    bootLogKey: BOOT_LOG_KEY,
  } as never);
  mockGetReviewJobById.mockResolvedValue(RUNNING_JOB as never);
  mockReadChangeRecordTimelineByPr.mockImplementation(
    async () => timelineWithPostedAttestation(CONTRACT_TIMELINE) as never
  );
  mockReadAcceptanceContracts.mockResolvedValue(CONFIRMED_CONTRACT as never);
  mockFindOrCreateChangeRecord.mockResolvedValue(CHANGE_RECORD as never);
  mockAppendChangeRecordEvent.mockResolvedValue({
    event: CHANGE_RECORD_EVENT,
    inserted: true,
  } as never);
  mockNotify.mockResolvedValue(undefined as never);
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("POST /api/v1/runner/review-jobs/complete", () => {
  // ---------------------------------------------------------------------
  // auth
  // ---------------------------------------------------------------------
  describe("auth (central JACE_CONSOLE_TOKEN secret)", () => {
    it("401 when no Authorization header is sent, and never touches completeReviewJob", async () => {
      const res = await POST(postReq(VALID_POSTED_BODY, false));
      expect(res.status).toBe(401);
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("401 when JACE_CONSOLE_TOKEN is unset (fail closed)", async () => {
      delete process.env[ENV_KEY];
      const res = await POST(postReq(VALID_POSTED_BODY));
      expect(res.status).toBe(401);
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("401 on a wrong secret", async () => {
      const res = await POST(
        new NextRequest("http://localhost/api/v1/runner/review-jobs/complete", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: "Bearer wrong-secret",
          },
          body: JSON.stringify(VALID_POSTED_BODY),
        })
      );
      expect(res.status).toBe(401);
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("401 body is requireJaceConsoleSecret's exact shape: { error: 'Unauthorized' }", async () => {
      const res = await POST(postReq(VALID_POSTED_BODY, false));
      expect(await res.json()).toEqual({ error: "Unauthorized" });
    });
  });

  // ---------------------------------------------------------------------
  // body validation (400)
  // ---------------------------------------------------------------------
  describe("body validation", () => {
    it("400 on invalid JSON", async () => {
      const res = await POST(rawReq("{not valid json"));
      expect(res.status).toBe(400);
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("400 when jobId is missing", async () => {
      const res = await POST(postReq({ outcome: "posted" }));
      expect(res.status).toBe(400);
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("400 when jobId is an empty string", async () => {
      const res = await POST(postReq({ ...VALID_POSTED_BODY, jobId: "" }));
      expect(res.status).toBe(400);
    });

    it("400 when outcome is missing", async () => {
      const res = await POST(postReq({ jobId: "job-1" }));
      expect(res.status).toBe(400);
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("400 when outcome is not 'posted' or 'failed'", async () => {
      const res = await POST(postReq({ jobId: "job-1", outcome: "green" }));
      expect(res.status).toBe(400);
      expect(mockComplete).not.toHaveBeenCalled();
    });

    // B2a §1 Task 3 — evidenceKeys: absent is fine (tested throughout this
    // file via bodies that simply omit it); PRESENT but malformed is a 400,
    // never a silent ignore.
    it("400 when evidenceKeys is present but not an array (e.g. a string)", async () => {
      const res = await POST(postReq({ ...VALID_POSTED_BODY, evidenceKeys: "not-an-array" }));
      expect(res.status).toBe(400);
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("400 when evidenceKeys is an array containing a non-string element", async () => {
      const res = await POST(postReq({ ...VALID_POSTED_BODY, evidenceKeys: ["ok-key", 123] }));
      expect(res.status).toBe(400);
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("400 when criterionResults repeat a criterion, use an unsupported state, or omit inspectable evidence", async () => {
      for (const criterionResults of [
        [{ criterionId: "AC-1", state: "green", expected: "x", observed: "x", evidenceRefs: [] }],
        [{ criterionId: "AC-1", state: "proven", expected: "x", observed: "x", evidenceRefs: [] }],
        [{ criterionId: "AC-1", state: "proven", expected: "x", observed: "x", evidenceRefs: [] }, { criterionId: "AC-1", state: "failed", expected: "x", observed: "y", evidenceRefs: ["artifact://a"] }],
        [{ criterionId: "AC-1", state: "proven", expected: "x", observed: "x", evidenceRefs: "artifact://a" }],
      ]) {
        const res = await POST(postReq({ ...VALID_POSTED_BODY, criterionResults }));
        expect(res.status).toBe(400);
      }
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("400 when a posted result omits criterionResults", async () => {
      const { criterionResults, ...withoutCriteria } = VALID_POSTED_BODY;
      const res = await POST(postReq(withoutCriteria));
      expect(res.status).toBe(400);
      expect(mockGetReviewJobById).not.toHaveBeenCalled();
    });
  });

  describe("confirmed Contract coverage", () => {
    it("rejects a valid-looking result when no server-owned pre-write GitHub attestation exists", async () => {
      mockReadChangeRecordTimelineByPr.mockResolvedValue(CONTRACT_TIMELINE as never);

      const res = await POST(postReq(VALID_POSTED_BODY));

      expect(res.status).toBe(409);
      expect(mockGetPreviewBoot).toHaveBeenCalledWith(PREVIEW_BOOT_ID);
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("rejects a terminal result whose verdict differs from the pre-write attested outcome", async () => {
      mockReadChangeRecordTimelineByPr.mockResolvedValue(
        timelineWithPostedAttestation(CONTRACT_TIMELINE, VALID_POSTED_BODY) as never
      );

      const res = await POST(
        postReq({ ...VALID_POSTED_BODY, verdict: "request_changes" })
      );

      expect(res.status).toBe(409);
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("rejects a legacy confirmed criterion without userVisible", async () => {
      mockReadAcceptanceContracts.mockResolvedValue([{
        ...CONFIRMED_CONTRACT[0],
        contract: {
          acceptanceCriteria: [{ id: "AC-1", text: "Legacy criterion" }],
        },
      }] as never);

      const res = await POST(postReq(VALID_POSTED_BODY));

      expect(res.status).toBe(409);
      expect(mockGetPreviewBoot).not.toHaveBeenCalled();
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("rejects a non-not_testable result that cites artifacts but no exact-head preview boot", async () => {
      mockComplete.mockResolvedValue(POSTED_JOB as never);

      const criterionResults = [{
        ...VALID_POSTED_BODY.criterionResults[0],
        evidenceRefs: ["artifact://review/ac-1"],
      }];

      const res = await POST(postReq({ ...VALID_POSTED_BODY, criterionResults }));

      expect(res.status).toBe(409);
      expect(mockGetPreviewBoot).not.toHaveBeenCalled();
      expect(mockComplete).not.toHaveBeenCalled();
      expect(mockAppendChangeRecordEvent).not.toHaveBeenCalled();
    });

    it("rejects exact-head boot evidence when the review job has no persisted criterion plan", async () => {
      mockReadChangeRecordTimelineByPr.mockResolvedValue({
        ...CONTRACT_TIMELINE,
        events: [],
      } as never);
      mockGetPreviewBoot.mockResolvedValue({
        id: PREVIEW_BOOT_ID,
        workspaceId: "ws-1",
        repo: "acme/widgets",
        prNumber: 42,
        headSha: "a".repeat(40),
        status: "ready",
        url: "http://preview.internal:4173",
      } as never);
      mockComplete.mockResolvedValue(POSTED_JOB as never);
      const criterionResults = [{
        ...VALID_POSTED_BODY.criterionResults[0],
        evidenceRefs: [`preview-boot:${PREVIEW_BOOT_ID}`],
      }];

      const res = await POST(postReq({ ...VALID_POSTED_BODY, criterionResults }));

      expect(res.status).toBe(409);
      expect(mockGetPreviewBoot).not.toHaveBeenCalled();
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("accepts a ready preview boot only when the server row matches the review job's exact head", async () => {
      mockGetPreviewBoot.mockResolvedValue({
        id: PREVIEW_BOOT_ID,
        workspaceId: "ws-1",
        repo: "acme/widgets",
        prNumber: 42,
        headSha: "a".repeat(40),
        status: "ready",
        url: "http://preview.internal:4173",
      } as never);
      mockComplete.mockResolvedValue(POSTED_JOB as never);
      const criterionResults = [{
        ...VALID_POSTED_BODY.criterionResults[0],
        evidenceRefs: [`preview-boot:${PREVIEW_BOOT_ID}`],
      }];

      const res = await POST(postReq({ ...VALID_POSTED_BODY, criterionResults }));

      expect(res.status).toBe(200);
      expect(mockGetPreviewBoot).toHaveBeenCalledWith(PREVIEW_BOOT_ID);
      expect(mockComplete).toHaveBeenCalledTimes(1);
    });

    it("completes proven or failed only from the exact stored UI receipt and its decisive screenshot", async () => {
      for (const assertionPassed of [true, false]) {
        const fixture = uiReceiptFixture(assertionPassed);
        mockReadChangeRecordTimelineByPr.mockImplementationOnce(
          async () => timelineWithPostedAttestation(fixture.timeline) as never
        );
        mockComplete.mockResolvedValueOnce({
          ...POSTED_JOB,
          verdict: fixture.result.state,
        } as never);
        const body = assertionPassed
          ? fixture.body
          : { ...fixture.body, evidenceKeys: [SCREENSHOT_KEY, BOOT_LOG_KEY] };

        const response = await POST(postReq(body));

        expect(response.status).toBe(200);
        expect(mockComplete).toHaveBeenCalledTimes(1);
        mockComplete.mockClear();
      }
    });

    it("keeps an executable UI plan at preview-only not_proven until its result receipt exists", async () => {
      const fixture = uiReceiptFixture();
      fixture.timeline.events = fixture.timeline.events.slice(0, 1);
      mockReadChangeRecordTimelineByPr.mockImplementationOnce(
        async () => timelineWithPostedAttestation(fixture.timeline) as never
      );
      mockComplete.mockResolvedValueOnce(POSTED_JOB as never);

      const response = await POST(postReq(VALID_POSTED_BODY));

      expect(response.status).toBe(200);
      expect(mockComplete).toHaveBeenCalledTimes(1);
    });

    it("keeps a valid screenshot reservation without a final result at preview-only not_proven", async () => {
      const fixture = uiReceiptFixture();
      fixture.timeline.events = fixture.timeline.events.filter(
        (event) => !String(event.eventKey).includes(":ui-result:")
      );
      mockReadChangeRecordTimelineByPr.mockImplementationOnce(
        async () => timelineWithPostedAttestation(fixture.timeline) as never
      );
      mockComplete.mockResolvedValueOnce(POSTED_JOB as never);

      const response = await POST(postReq(VALID_POSTED_BODY));

      expect(response.status).toBe(200);
      expect(mockComplete).toHaveBeenCalledTimes(1);
    });

    it("does not downgrade an existing UI receipt to preview-only not_proven", async () => {
      const fixture = uiReceiptFixture();
      mockReadChangeRecordTimelineByPr.mockImplementationOnce(
        async () => timelineWithPostedAttestation(fixture.timeline) as never
      );

      const response = await POST(postReq(VALID_POSTED_BODY));

      expect(response.status).toBe(409);
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("holds forged or mismatched UI execution custody before completing the job", async () => {
      const cases: Array<[string, (fixture: ReturnType<typeof uiReceiptFixture>) => void]> = [
        ["attempt", (fixture) => {
          fixture.timeline.events = fixture.timeline.events.filter(
            (event) => !String(event.eventKey).includes(":ui-attempt:")
          );
        }],
        ["attempt plan", (fixture) => {
          const event = fixture.timeline.events.find((candidate) =>
            String(candidate.eventKey).includes(":ui-attempt:")
          )!;
          event.payloadRef = { ...fixture.attempt, planDigest: "forged" };
        }],
        ["attempt execution", (fixture) => {
          const event = fixture.timeline.events.find((candidate) =>
            String(candidate.eventKey).includes(":ui-attempt:")
          )!;
          event.payloadRef = { ...fixture.attempt, executionId: "ui-forged" };
        }],
        ["result execution", (fixture) => {
          const event = fixture.timeline.events.find((candidate) =>
            String(candidate.eventKey).includes(":ui-result:")
          )!;
          event.payloadRef = { ...fixture.result, executionId: "ui-forged" };
        }],
        ["result head", (fixture) => {
          const event = fixture.timeline.events.find((candidate) =>
            String(candidate.eventKey).includes(":ui-result:")
          )!;
          event.payloadRef = { ...fixture.result, headSha: "foreign-head" };
        }],
        ["missing screenshot reservation", (fixture) => {
          fixture.timeline.events = fixture.timeline.events.filter(
            (event) => !String(event.eventKey).includes(":ui-screenshot:")
          );
        }],
        ["mismatched screenshot reservation", (fixture) => {
          const event = fixture.timeline.events.find((candidate) =>
            String(candidate.eventKey).includes(":ui-screenshot:")
          )!;
          event.payloadRef = buildReviewJobUiScreenshotReservation({
            ...fixture.result,
            artifactKey: "review-evidence/competing.png",
          });
        }],
        ["stored plan", (fixture) => {
          const event = fixture.timeline.events[0]!;
          const storedPlan = event.payloadRef.plans;
          if (!Array.isArray(storedPlan) || storedPlan.length === 0) {
            throw new Error("fixture must include a stored verification plan");
          }
          event.payloadRef = {
            ...event.payloadRef,
            plans: [{
              ...storedPlan[0],
              uiSteps: [
                { action: "open", path: "/saved-values" },
                { action: "expect_text", text: "Different text" },
                { action: "screenshot", label: "saved-value" },
              ],
            }],
          };
        }],
        ["boot tuple", () => {
          mockGetPreviewBoot.mockResolvedValueOnce({
            id: PREVIEW_BOOT_ID,
            workspaceId: "ws-1",
            repo: "acme/widgets",
            prNumber: 42,
            headSha: "b".repeat(40),
            status: "ready",
            url: PREVIEW_URL,
            bootLogKey: BOOT_LOG_KEY,
          } as never);
        }],
        ["boot URL", () => {
          mockGetPreviewBoot.mockResolvedValueOnce({
            id: PREVIEW_BOOT_ID,
            workspaceId: "ws-1",
            repo: "acme/widgets",
            prNumber: 42,
            headSha: "a".repeat(40),
            status: "ready",
            url: "http://preview.internal:4999",
            bootLogKey: BOOT_LOG_KEY,
          } as never);
        }],
        ["result observation", (fixture) => {
          const event = fixture.timeline.events.find((candidate) =>
            String(candidate.eventKey).includes(":ui-result:")
          )!;
          event.payloadRef = { ...fixture.result, observed: "forged" };
        }],
      ];

      for (const [name, arrange] of cases) {
        const fixture = uiReceiptFixture();
        arrange(fixture);
        mockReadChangeRecordTimelineByPr.mockImplementationOnce(
          async () => timelineWithPostedAttestation(fixture.timeline) as never
        );
        const response = await POST(postReq(fixture.body));
        expect(response.status, name).toBe(409);
      }
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("holds preview-only fallback when a stored UI result is present but invalid", async () => {
      for (const mutation of [
        { executionId: "ui-forged" },
        { headSha: "foreign-head" },
        { observed: "forged" },
      ]) {
        const fixture = uiReceiptFixture();
        const event = fixture.timeline.events.find((candidate) =>
          String(candidate.eventKey).includes(":ui-result:")
        )!;
        event.payloadRef = { ...fixture.result, ...mutation };
        mockReadChangeRecordTimelineByPr.mockImplementationOnce(
          async () => timelineWithPostedAttestation(fixture.timeline) as never
        );

        const response = await POST(postReq(VALID_POSTED_BODY));

        expect(response.status).toBe(409);
      }
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("completes exact API proven and failed receipts with their required JSON custody key", async () => {
      for (const observedStatus of [200, 503]) {
        const fixture = apiReceiptFixture(observedStatus);
        mockReadChangeRecordTimelineByPr.mockImplementationOnce(
          async () => timelineWithPostedAttestation(fixture.timeline, fixture.body) as never
        );
        mockComplete.mockResolvedValueOnce({ ...POSTED_JOB, verdict: fixture.result.state } as never);

        const response = await POST(postReq(fixture.body));

        expect(response.status).toBe(200);
        expect(mockComplete).toHaveBeenCalledWith(expect.objectContaining({
          verdict: fixture.result.state,
          evidenceKeys: [API_EVIDENCE_KEY],
        }));
        mockComplete.mockClear();
      }
    });

    it("holds result-only, malformed, mismatched, and present-invalid API custody before completion", async () => {
      const cases: Array<[string, (fixture: ReturnType<typeof apiReceiptFixture>) => void, Record<string, unknown> | null]> = [
        ["result-only", (fixture) => {
          fixture.timeline.events = fixture.timeline.events.filter((event) => !event.eventKey.includes(":api-attempt:"));
        }, null],
        ["missing reservation", (fixture) => {
          fixture.timeline.events = fixture.timeline.events.filter((event) => !event.eventKey.includes(":api-card:"));
        }, null],
        ["attempt plan", (fixture) => {
          const event = fixture.timeline.events.find((candidate) => candidate.eventKey.includes(":api-attempt:"))!;
          event.payloadRef = { ...fixture.attempt, planDigest: "forged" };
        }, null],
        ["result head", (fixture) => {
          const event = fixture.timeline.events.find((candidate) => candidate.eventKey.includes(":api-result:"))!;
          event.payloadRef = { ...fixture.result, headSha: "foreign-head" };
        }, null],
        ["reservation artifact", (fixture) => {
          const event = fixture.timeline.events.find((candidate) => candidate.eventKey.includes(":api-card:"))!;
          event.payloadRef = buildReviewJobApiCardReservation({ ...fixture.result, artifactKey: "review-evidence/competing.json" });
        }, null],
        ["boot tuple", () => {}, { headSha: "b".repeat(40) }],
        ["boot URL", () => {}, { url: "http://preview.internal:4999" }],
        ["result observation", (fixture) => {
          const event = fixture.timeline.events.find((candidate) => candidate.eventKey.includes(":api-result:"))!;
          event.payloadRef = { ...fixture.result, observed: "forged" };
        }, null],
      ];
      for (const [name, arrange, bootOverride] of cases) {
        const fixture = apiReceiptFixture();
        arrange(fixture);
        if (bootOverride) {
          mockGetPreviewBoot.mockResolvedValueOnce({
            id: PREVIEW_BOOT_ID, workspaceId: "ws-1", repo: "acme/widgets", prNumber: 42,
            headSha: "a".repeat(40), status: "ready", url: PREVIEW_URL,
            bootLogKey: BOOT_LOG_KEY, ...bootOverride,
          } as never);
        }
        mockReadChangeRecordTimelineByPr.mockImplementationOnce(
          async () => timelineWithPostedAttestation(fixture.timeline, fixture.body) as never
        );
        const response = await POST(postReq(fixture.body));
        expect(response.status, name).toBe(409);
      }
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("permits only absent or one exact pending API reservation to use the R7.1 preview fallback", async () => {
      const absent = apiReceiptFixture();
      absent.timeline.events = absent.timeline.events.slice(0, 1);
      mockReadChangeRecordTimelineByPr.mockImplementationOnce(
        async () => timelineWithPostedAttestation(absent.timeline, VALID_POSTED_BODY) as never
      );
      mockComplete.mockResolvedValueOnce(POSTED_JOB as never);
      expect((await POST(postReq(VALID_POSTED_BODY))).status).toBe(200);
      mockComplete.mockClear();

      const pending = apiReceiptFixture();
      pending.timeline.events = pending.timeline.events.filter((event) => !event.eventKey.includes(":api-result:"));
      mockReadChangeRecordTimelineByPr.mockImplementationOnce(
        async () => timelineWithPostedAttestation(pending.timeline, VALID_POSTED_BODY) as never
      );
      mockComplete.mockResolvedValueOnce(POSTED_JOB as never);
      expect((await POST(postReq(VALID_POSTED_BODY))).status).toBe(200);
      mockComplete.mockClear();

      const invalid = apiReceiptFixture();
      const resultEvent = invalid.timeline.events.find((event) => event.eventKey.includes(":api-result:"))!;
      resultEvent.payloadRef = { ...invalid.result, observed: "forged" };
      mockReadChangeRecordTimelineByPr.mockImplementationOnce(
        async () => timelineWithPostedAttestation(invalid.timeline, VALID_POSTED_BODY) as never
      );
      expect((await POST(postReq(VALID_POSTED_BODY))).status).toBe(409);
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("requires the receipt screenshot key exactly once and allows only its current boot log beside it", async () => {
      for (const evidenceKeys of [
        [],
        [BOOT_LOG_KEY],
        [SCREENSHOT_KEY, SCREENSHOT_KEY],
        [SCREENSHOT_KEY, "review-evidence/fabricated.png"],
        ["review-evidence/fabricated.png"],
      ]) {
        const fixture = uiReceiptFixture();
        mockReadChangeRecordTimelineByPr.mockImplementationOnce(
          async () => timelineWithPostedAttestation(fixture.timeline) as never
        );
        const response = await POST(
          postReq({ ...fixture.body, evidenceKeys })
        );
        expect(response.status, JSON.stringify(evidenceKeys)).toBe(409);
      }
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("holds caller changes to the UI receipt fields before completion", async () => {
      for (const mutation of [
        { state: "failed" },
        { expected: "Different expected behavior." },
        { observed: "The caller says it passed." },
        { evidenceRefs: ["review-ui-execution:forged"] },
      ]) {
        const fixture = uiReceiptFixture();
        mockReadChangeRecordTimelineByPr.mockImplementationOnce(
          async () => timelineWithPostedAttestation(fixture.timeline) as never
        );
        const criterionResult = {
          ...fixture.body.criterionResults[0],
          ...mutation,
        };
        const response = await POST(postReq({
          ...fixture.body,
          criterionResults: [criterionResult],
          verdict: criterionResult.state,
        }));
        expect(response.status).toBe(409);
      }
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("rejects direct-complete proof claims, changed observations, and extra references before completion", async () => {
      for (const criterionResult of [
        {
          ...VALID_POSTED_BODY.criterionResults[0],
          state: "proven",
          observed: "The model says it passed.",
        },
        {
          ...VALID_POSTED_BODY.criterionResults[0],
          state: "failed",
          observed: "The model says it failed.",
        },
        {
          ...VALID_POSTED_BODY.criterionResults[0],
          observed: "A different environment-only claim.",
        },
        {
          ...VALID_POSTED_BODY.criterionResults[0],
          evidenceRefs: [
            `preview-boot:${PREVIEW_BOOT_ID}`,
            "artifact://fabricated",
          ],
        },
      ]) {
        const res = await POST(
          postReq({ ...VALID_POSTED_BODY, criterionResults: [criterionResult] })
        );
        expect(res.status).toBe(409);
      }
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("accepts a server-custodied before-ready boot failure only as not_testable", async () => {
      const reason = "preview command exited 1";
      mockGetPreviewBoot.mockResolvedValue({
        id: PREVIEW_BOOT_ID,
        workspaceId: "ws-1",
        repo: "acme/widgets",
        prNumber: 42,
        headSha: "a".repeat(40),
        status: "failed",
        url: null,
        reason,
        bootLogKey: BOOT_LOG_KEY,
      } as never);
      mockComplete.mockResolvedValue(POSTED_JOB as never);
      const criterionResults = [{
        ...VALID_POSTED_BODY.criterionResults[0],
        state: "not_testable",
        observed: r7UnavailablePreviewObservation({ status: "failed", reason }),
      }];

      const response = await POST(postReq({
        ...VALID_POSTED_BODY,
        criterionResults,
        verdict: "not_testable",
        summaryLine: "AgentRail review posted for acme/widgets#42 — not_testable",
      }));

      expect(response.status).toBe(200);
      expect(mockComplete).toHaveBeenCalledTimes(1);
    });

    it("holds in-flight, failed-after-ready, and reasonless terminal boots", async () => {
      for (const boot of [
        { status: "pending", url: null, reason: null },
        { status: "ready", url: null, reason: null },
        { status: "failed", url: "http://preview.internal:4173", reason: "stale" },
        { status: "failed", url: null, reason: "   " },
        { status: "torn_down", url: null, reason: null },
      ]) {
        mockGetPreviewBoot.mockResolvedValueOnce({
          id: PREVIEW_BOOT_ID,
          workspaceId: "ws-1",
          repo: "acme/widgets",
          prNumber: 42,
          headSha: "a".repeat(40),
          bootLogKey: BOOT_LOG_KEY,
          ...boot,
        } as never);
        const response = await POST(postReq(VALID_POSTED_BODY));
        expect(response.status).toBe(409);
      }
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("rejects arbitrary evidenceKeys that are not custodied on the exact boot", async () => {
      const response = await POST(postReq({
        ...VALID_POSTED_BODY,
        evidenceKeys: ["review-evidence/fabricated.png"],
      }));

      expect(response.status).toBe(409);
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("rejects a fabricated preview-boot evidence reference before completing the review", async () => {
      const criterionResults = [{
        criterionId: "AC-1",
        state: "not_proven",
        expected: "Saving a filter preserves it after reload.",
        observed: "No safe preview was available for the reload flow.",
        evidenceRefs: ["preview-boot:unavailable"],
      }];

      const res = await POST(postReq({ ...VALID_POSTED_BODY, criterionResults }));

      expect(res.status).toBe(409);
      expect(mockComplete).not.toHaveBeenCalled();
      expect(mockAppendChangeRecordEvent).not.toHaveBeenCalled();
    });

    it("rejects a real preview boot from a different workspace, PR, or head", async () => {
      const criterionResults = [{
        ...VALID_POSTED_BODY.criterionResults[0],
        evidenceRefs: [`preview-boot:${PREVIEW_BOOT_ID}`],
      }];
      for (const mismatch of [
        { workspaceId: "ws-other" },
        { prNumber: 99 },
        { headSha: "b".repeat(40) },
      ]) {
        mockGetPreviewBoot.mockResolvedValueOnce({
          id: PREVIEW_BOOT_ID,
          workspaceId: "ws-1",
          repo: "acme/widgets",
          prNumber: 42,
          headSha: "a".repeat(40),
          status: "ready",
          url: "http://preview.internal:4173",
          ...mismatch,
        } as never);

        const res = await POST(postReq({ ...VALID_POSTED_BODY, criterionResults }));
        expect(res.status).toBe(409);
      }

      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("accepts a torn-down boot when it retains the URL from its ready transition", async () => {
      const criterionResults = [{
        ...VALID_POSTED_BODY.criterionResults[0],
        evidenceRefs: [`preview-boot:${PREVIEW_BOOT_ID}`],
      }];
      mockComplete.mockResolvedValue(POSTED_JOB as never);
      mockGetPreviewBoot.mockResolvedValueOnce({
        id: PREVIEW_BOOT_ID,
        workspaceId: "ws-1",
        repo: "acme/widgets",
        prNumber: 42,
        headSha: "a".repeat(40),
        status: "torn_down",
        url: "http://preview.internal:4173",
      } as never);

      const afterReady = await POST(postReq({ ...VALID_POSTED_BODY, criterionResults }));
      expect(afterReady.status).toBe(200);
    });

    it("accepts a plan-declared not_testable criterion only with its stored reason and no boot", async () => {
      const criterionText = "The API returns the saved value.";
      const notTestableReason = "The R7.2 API executor is not available in this deployment.";
      mockReadAcceptanceContracts.mockResolvedValue([{
        ...CONFIRMED_CONTRACT[0],
        contract: {
          acceptanceCriteria: [{ id: "AC-1", text: criterionText, userVisible: false }],
        },
      }] as never);
      const notTestableTimeline = {
        ...CONTRACT_TIMELINE,
        events: [{
          ...PLAN_EVENT,
          payloadRef: {
            ...PLAN_EVENT.payloadRef,
            plans: [{
              criterionId: "AC-1",
              criterionTextSnapshot: criterionText,
              modality: "api",
              environmentKind: null,
              flow: null,
              status: "not_testable",
              notTestableReason,
            }],
          },
        }],
      };
      mockReadChangeRecordTimelineByPr.mockImplementation(
        async () => timelineWithPostedAttestation(notTestableTimeline) as never
      );
      mockComplete.mockResolvedValue(POSTED_JOB as never);
      const criterionResults = [{
        criterionId: "AC-1",
        state: "not_testable",
        expected: criterionText,
        observed: notTestableReason,
        evidenceRefs: [],
      }];

      const response = await POST(postReq({
        ...VALID_POSTED_BODY,
        criterionResults,
        verdict: "not_testable",
        summaryLine: "AgentRail review posted for acme/widgets#42 — not_testable",
      }));

      expect(response.status).toBe(200);
      expect(mockGetPreviewBoot).not.toHaveBeenCalled();
      expect(mockComplete).toHaveBeenCalledTimes(1);
    });

    it("rejects a plan-declared not_testable criterion that changes its reason or claims proof", async () => {
      const criterionText = "The API returns the saved value.";
      const notTestableReason = "The R7.2 API executor is not available in this deployment.";
      mockReadAcceptanceContracts.mockResolvedValue([{
        ...CONFIRMED_CONTRACT[0],
        contract: {
          acceptanceCriteria: [{ id: "AC-1", text: criterionText, userVisible: false }],
        },
      }] as never);
      mockReadChangeRecordTimelineByPr.mockResolvedValue({
        ...CONTRACT_TIMELINE,
        events: [{
          ...PLAN_EVENT,
          payloadRef: {
            ...PLAN_EVENT.payloadRef,
            plans: [{
              criterionId: "AC-1",
              criterionTextSnapshot: criterionText,
              modality: "api",
              environmentKind: null,
              flow: null,
              status: "not_testable",
              notTestableReason,
            }],
          },
        }],
      } as never);

      for (const criterionResults of [
        [{
          criterionId: "AC-1",
          state: "not_testable",
          expected: criterionText,
          observed: "A different reason.",
          evidenceRefs: [],
        }],
        [{
          criterionId: "AC-1",
          state: "proven",
          expected: criterionText,
          observed: "Claimed proof despite the declared hold.",
          evidenceRefs: [`preview-boot:${PREVIEW_BOOT_ID}`],
        }],
      ]) {
        const response = await POST(postReq({ ...VALID_POSTED_BODY, criterionResults }));
        expect(response.status).toBe(409);
      }

      expect(mockGetPreviewBoot).not.toHaveBeenCalled();
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("rejects a stored plan that relabels a user-visible criterion away from ui", async () => {
      const notTestableReason = "Incorrectly classified as an API-only criterion.";
      mockReadAcceptanceContracts.mockResolvedValue([{
        ...CONFIRMED_CONTRACT[0],
        contract: {
          acceptanceCriteria: [{
            id: "AC-1",
            text: "The saved value is visible.",
            userVisible: true,
          }],
        },
      }] as never);
      mockReadChangeRecordTimelineByPr.mockResolvedValue({
        ...CONTRACT_TIMELINE,
        events: [{
          ...PLAN_EVENT,
          payloadRef: {
            ...PLAN_EVENT.payloadRef,
            plans: [{
              criterionId: "AC-1",
              criterionTextSnapshot: "The saved value is visible.",
              modality: "api",
              environmentKind: null,
              flow: null,
              status: "not_testable",
              notTestableReason,
            }],
          },
        }],
      } as never);
      mockComplete.mockResolvedValue(POSTED_JOB as never);
      const criterionResults = [{
        criterionId: "AC-1",
        state: "not_testable",
        expected: "The saved value is visible.",
        observed: notTestableReason,
        evidenceRefs: [],
      }];

      const response = await POST(postReq({ ...VALID_POSTED_BODY, criterionResults }));

      expect(response.status).toBe(409);
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("rejects a torn-down boot that never reached ready and has no URL", async () => {
      const criterionResults = [{
        ...VALID_POSTED_BODY.criterionResults[0],
        evidenceRefs: [`preview-boot:${PREVIEW_BOOT_ID}`],
      }];
      mockGetPreviewBoot.mockResolvedValueOnce({
        id: PREVIEW_BOOT_ID,
        workspaceId: "ws-1",
        repo: "acme/widgets",
        prNumber: 42,
        headSha: "a".repeat(40),
        status: "torn_down",
        url: null,
      } as never);

      const beforeReady = await POST(postReq({ ...VALID_POSTED_BODY, criterionResults }));
      expect(beforeReady.status).toBe(409);
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it("409 before completion when the Contract is missing, the head is foreign, or results do not exactly match the confirmed criterion IDs", async () => {
      const cases = [
        () => mockReadAcceptanceContracts.mockResolvedValue([] as never),
        () => mockReadChangeRecordTimelineByPr.mockResolvedValue({
          ...CONTRACT_TIMELINE,
          record: { ...CHANGE_RECORD, headShas: ["b".repeat(40)] },
        } as never),
        () => {},
      ];
      for (const arrange of cases) {
        arrange();
        const body = cases.indexOf(arrange) === 2
          ? { ...VALID_POSTED_BODY, criterionResults: [{ ...VALID_POSTED_BODY.criterionResults[0], criterionId: "AC-foreign" }] }
          : VALID_POSTED_BODY;
        const res = await POST(postReq(body));
        expect(res.status).toBe(409);
        expect(mockComplete).not.toHaveBeenCalled();
        vi.mocked(mockReadAcceptanceContracts).mockResolvedValue(CONFIRMED_CONTRACT as never);
        vi.mocked(mockReadChangeRecordTimelineByPr).mockResolvedValue(CONTRACT_TIMELINE as never);
      }
    });

    it("reads the exact running job and confirmed Contract before completing a valid posted review", async () => {
      mockComplete.mockResolvedValue(POSTED_JOB as never);
      await POST(postReq(VALID_POSTED_BODY));
      expect(mockGetReviewJobById).toHaveBeenCalledWith("job-1");
      expect(mockReadChangeRecordTimelineByPr).toHaveBeenCalledWith({ workspaceId: "ws-1", repo: "acme/widgets", prNumber: 42 });
      expect(mockReadAcceptanceContracts).toHaveBeenCalledWith({ workspaceId: "ws-1", recordId: "record-1" });
    });
  });

  // ---------------------------------------------------------------------
  // unknown job or not-running -> 409
  // ---------------------------------------------------------------------
  describe("unknown job or not-running", () => {
    it("409 when completeReviewJob returns null (guarded WHERE found nothing)", async () => {
      mockComplete.mockResolvedValue(null as never);
      const res = await POST(postReq(VALID_POSTED_BODY));
      expect(res.status).toBe(409);
      expect(mockNotify).not.toHaveBeenCalled();
    });

    it("passes jobId/outcome/postedReviewUrl/verdict/error through to completeReviewJob", async () => {
      mockComplete.mockResolvedValue(POSTED_JOB as never);
      await POST(
        postReq({
          ...VALID_POSTED_BODY,
          postedReviewUrl: "https://github.com/acme/widgets/pull/42#pullrequestreview-1",
          verdict: "not_proven",
        })
      );
      expect(mockComplete).toHaveBeenCalledWith({
        jobId: "job-1",
        outcome: "posted",
        postedReviewUrl: "https://github.com/acme/widgets/pull/42#pullrequestreview-1",
        verdict: "not_proven",
        error: null,
      });
    });

    it("uses the server-custodied posted URL instead of a caller substitution", async () => {
      mockComplete.mockResolvedValue(POSTED_JOB as never);
      await POST(
        postReq({
          ...VALID_POSTED_BODY,
          postedReviewUrl: "https://evil.example/review",
        })
      );
      expect(mockComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          postedReviewUrl:
            "https://github.com/acme/widgets/pull/42#pullrequestreview-1",
        })
      );
    });

    // B2a §1 Task 3 — evidenceKeys passthrough. The test directly above
    // (unmodified) is the additive proof: a body with no evidenceKeys at all
    // still produces that exact 5-key completeReviewJob call, with no sixth
    // key riding along.
    it("passes evidenceKeys through to completeReviewJob when present", async () => {
      mockComplete.mockResolvedValue(POSTED_JOB as never);
      await POST(
        postReq({
          ...VALID_POSTED_BODY,
          evidenceKeys: [BOOT_LOG_KEY],
        })
      );
      expect(mockComplete).toHaveBeenCalledWith({
        jobId: "job-1",
        outcome: "posted",
        postedReviewUrl: VALID_POSTED_BODY.postedReviewUrl,
        verdict: "not_proven",
        error: null,
        evidenceKeys: [BOOT_LOG_KEY],
      });
    });

    it("accepts an empty evidenceKeys array (valid — not the same as absent)", async () => {
      mockComplete.mockResolvedValue(POSTED_JOB as never);
      const res = await POST(postReq({ ...VALID_POSTED_BODY, evidenceKeys: [] }));
      expect(res.status).toBe(200);
      expect(mockComplete).toHaveBeenCalledWith(
        expect.objectContaining({ evidenceKeys: [] })
      );
    });
  });

  // ---------------------------------------------------------------------
  // posted -> notify exactly once, then 200
  // ---------------------------------------------------------------------
  describe("outcome: posted", () => {
    it("200 on a successful posted completion", async () => {
      mockComplete.mockResolvedValue(POSTED_JOB as never);
      const res = await POST(postReq(VALID_POSTED_BODY));
      expect(res.status).toBe(200);
    });

    it("notifies exactly once via the existing notify machinery", async () => {
      mockComplete.mockResolvedValue(POSTED_JOB as never);
      await POST(postReq(VALID_POSTED_BODY));
      expect(mockNotify).toHaveBeenCalledTimes(1);
    });

    it("notifies the job's OWN workspaceId (from the completed row, not the request)", async () => {
      mockComplete.mockResolvedValue(POSTED_JOB as never);
      await POST(postReq(VALID_POSTED_BODY));
      const [workspaceId] = mockNotify.mock.calls[0]!;
      expect(workspaceId).toBe("ws-1");
    });

    it("notify content is the worker-composed summaryLine plus the review URL — the worker composes, console only routes", async () => {
      mockComplete.mockResolvedValue(POSTED_JOB as never);
      await POST(postReq(VALID_POSTED_BODY));

      const [, text] = mockNotify.mock.calls[0]!;
      expect(text).toContain(VALID_POSTED_BODY.summaryLine);
      expect(text).toContain(VALID_POSTED_BODY.postedReviewUrl);
    });

    it("does not fold verdict into the notify text itself — the worker already folded it into summaryLine", async () => {
      mockComplete.mockResolvedValue(POSTED_JOB as never);
      await POST(postReq(VALID_POSTED_BODY));

      const [, text] = mockNotify.mock.calls[0]!;
      expect(text).not.toContain("approve");
    });

    it("a notify failure never changes the 200 response (best-effort)", async () => {
      mockComplete.mockResolvedValue(POSTED_JOB as never);
      mockNotify.mockRejectedValue(new Error("gateway down"));

      const res = await POST(postReq(VALID_POSTED_BODY));
      expect(res.status).toBe(200);
    });

    it("appends a Change Record review event using the completed job's PR anchor", async () => {
      mockComplete.mockResolvedValue(POSTED_JOB as never);
      await POST(postReq(VALID_POSTED_BODY));

      expect(mockFindOrCreateChangeRecord).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        repo: "acme/widgets",
        prNumber: 42,
        headShas: ["a".repeat(40)],
      });
      expect(mockAppendChangeRecordEvent).toHaveBeenCalledWith({
        recordId: "record-1",
        eventKey: "review:posted:job-1",
        stage: "review",
        actor: "reviewer-of-record",
        payloadRef: {
          kind: "review_job",
          jobId: "job-1",
          repo: "acme/widgets",
          prNumber: 42,
          headSha: "a".repeat(40),
          postedReviewUrl: VALID_POSTED_BODY.postedReviewUrl,
          verdict: "not_proven",
          evidenceKeys: null,
          criterionResults: VALID_POSTED_BODY.criterionResults,
        },
        at: NOW,
      });
    });

    it("persists typed terminal outcomes with the exact review head", async () => {
      mockComplete.mockResolvedValue(POSTED_JOB as never);
      const criterionResults = VALID_POSTED_BODY.criterionResults;
      await POST(postReq({ ...VALID_POSTED_BODY, criterionResults }));
      expect(mockAppendChangeRecordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          payloadRef: expect.objectContaining({
            headSha: "a".repeat(40),
            criterionResults,
          }),
        })
      );
    });

    it("treats a duplicate Change Record event as an idempotent success", async () => {
      mockComplete.mockResolvedValue(POSTED_JOB as never);
      mockAppendChangeRecordEvent.mockResolvedValue({
        event: CHANGE_RECORD_EVENT,
        inserted: false,
      } as never);

      const res = await POST(postReq(VALID_POSTED_BODY));
      expect(res.status).toBe(200);
      expect(mockAppendChangeRecordEvent).toHaveBeenCalledTimes(1);
      expect(mockNotify).toHaveBeenCalledTimes(1);
    });

    it("skips Change Record attachment when the completed job has no PR anchor, without failing completion", async () => {
      mockComplete.mockResolvedValue({ ...POSTED_JOB, prNumber: null } as never);

      const res = await POST(postReq(VALID_POSTED_BODY));
      expect(res.status).toBe(200);
      expect(mockFindOrCreateChangeRecord).not.toHaveBeenCalled();
      expect(mockAppendChangeRecordEvent).not.toHaveBeenCalled();
      expect(mockNotify).toHaveBeenCalledTimes(1);
    });

    it("keeps review completion successful when Change Record attachment is unavailable", async () => {
      mockComplete.mockResolvedValue(POSTED_JOB as never);
      mockAppendChangeRecordEvent.mockRejectedValue(new Error("change-record store down"));

      const res = await POST(postReq(VALID_POSTED_BODY));
      expect(res.status).toBe(200);
      expect(mockNotify).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------
  // failed -> recorded, no notify, 200
  // ---------------------------------------------------------------------
  describe("outcome: failed", () => {
    it("200 on a successful failed completion, and NO notify fires", async () => {
      mockComplete.mockResolvedValue(FAILED_JOB as never);
      const res = await POST(postReq({ jobId: "job-1", outcome: "failed", error: "transient GitHub 502" }));

      expect(res.status).toBe(200);
      expect(mockNotify).not.toHaveBeenCalled();
      expect(mockFindOrCreateChangeRecord).not.toHaveBeenCalled();
      expect(mockAppendChangeRecordEvent).not.toHaveBeenCalled();
    });

    it("passes the worker's error through to completeReviewJob", async () => {
      mockComplete.mockResolvedValue(FAILED_JOB as never);
      await POST(postReq({ jobId: "job-1", outcome: "failed", error: "transient GitHub 502" }));

      expect(mockComplete).toHaveBeenCalledWith({
        jobId: "job-1",
        outcome: "failed",
        postedReviewUrl: null,
        verdict: null,
        error: "transient GitHub 502",
      });
    });

    it("409 when the job is unknown/not-running for a failed completion too", async () => {
      mockComplete.mockResolvedValue(null as never);
      const res = await POST(postReq({ jobId: "job-1", outcome: "failed" }));
      expect(res.status).toBe(409);
      expect(mockNotify).not.toHaveBeenCalled();
    });
  });
});
