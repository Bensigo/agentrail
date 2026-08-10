import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  appendChangeRecordEvent: vi.fn(),
  getJaceSessionByEveSessionId: vi.fn(),
  getReviewJobById: vi.fn(),
  readAcceptanceContracts: vi.fn(),
  readChangeRecordTimelineByPr: vi.fn(),
}));

import {
  appendChangeRecordEvent,
  getJaceSessionByEveSessionId,
  getReviewJobById,
  readAcceptanceContracts,
  readChangeRecordTimelineByPr,
} from "@agentrail/db-postgres";
import { POST } from "./route";

const SECRET = "jace-shared-secret-abc123";
const HEAD_SHA = "a".repeat(40);
const NOW = new Date("2026-08-10T00:00:00.000Z");
const ORIGINAL_TOKEN = process.env.JACE_CONSOLE_TOKEN;

const RUNNING_JOB = {
  id: "job-1",
  workspaceId: "ws-1",
  repo: "acme/widgets",
  prNumber: 42,
  headSha: HEAD_SHA,
  event: "opened",
  state: "running",
  attempts: 0,
  claimedBy: "worker-1",
  claimedAt: NOW,
  nextEligibleAt: null,
  postedReviewUrl: null,
  verdict: null,
  skipReason: null,
  evidenceKeys: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const BOUND_REVIEW_SESSION = {
  id: "session-1",
  workspaceId: "ws-1",
  chatIdentityId: null,
  channel: "review-job",
  conversationKey: "review-job:job-1",
  eveSessionId: "eve-session-1",
  anchoredBriefId: null,
  anchoredInvestigationId: null,
  status: "active",
  lastActivityAt: NOW,
  engagementDormantSince: null,
  engagedSpeakerId: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const RECORD = {
  id: "record-1",
  workspaceId: "ws-1",
  repo: "acme/widgets",
  issueNumber: null,
  prNumber: 42,
  headShas: [HEAD_SHA],
  mergedSha: null,
  state: "open",
  createdAt: NOW,
  updatedAt: NOW,
};

const CONTRACT = {
  id: "contract-1",
  recordId: "record-1",
  version: 3,
  status: "confirmed",
  contract: {
    acceptanceCriteria: [
      { id: "AC-UI", text: "A saved filter is visible after reload.", userVisible: true },
      { id: "AC-API", text: "The API returns the saved filter.", userVisible: false },
    ],
  },
  createdBy: "user-1",
  createdAt: NOW,
  confirmedAt: NOW,
};

const REQUEST_PLANS = [
  {
    criterionId: "AC-UI",
    modality: "ui",
    status: "planned",
    flow: "Open saved filters, reload, and verify the named filter remains visible.",
    uiSteps: [
      { action: "open", path: "/filters" },
      { action: "click", selector: "[data-testid=\"saved-filter\"]" },
      { action: "expect_text", text: "Saved filter" },
      { action: "screenshot", label: "saved-filter-visible" },
    ],
  },
  {
    criterionId: "AC-API",
    modality: "api",
    status: "not_testable",
    notTestableReason: "The R7.2 API executor is not available in this deployment.",
  },
];

const STORED_PAYLOAD = {
  kind: "review_job_verification_plan",
  jobId: "job-1",
  workspaceId: "ws-1",
  repo: "acme/widgets",
  prNumber: 42,
  headSha: HEAD_SHA,
  recordId: "record-1",
  acceptanceContractId: "contract-1",
  acceptanceContractVersion: 3,
  plannedBy: "jace:review-job-worker",
  plans: [
    {
      criterionId: "AC-UI",
      criterionTextSnapshot: "A saved filter is visible after reload.",
      modality: "ui",
      environmentKind: "isolated_preview",
      flow: "Open saved filters, reload, and verify the named filter remains visible.",
      uiSteps: [
        { action: "open", path: "/filters" },
        { action: "click", selector: "[data-testid=\"saved-filter\"]" },
        { action: "expect_text", text: "Saved filter" },
        { action: "screenshot", label: "saved-filter-visible" },
      ],
      status: "planned",
      notTestableReason: null,
    },
    {
      criterionId: "AC-API",
      criterionTextSnapshot: "The API returns the saved filter.",
      modality: "api",
      environmentKind: null,
      flow: null,
      uiSteps: null,
      status: "not_testable",
      notTestableReason: "The R7.2 API executor is not available in this deployment.",
    },
  ],
};

const PLAN_EVENT = {
  id: "event-plan-1",
  recordId: "record-1",
  eventKey: "verification:plan:job-1",
  stage: "verification",
  actor: "jace:review-verification-planner",
  payloadRef: STORED_PAYLOAD,
  at: NOW,
  createdAt: NOW,
};

function postReq(body: unknown, withAuth = true): NextRequest {
  return new NextRequest(
    "http://localhost/api/v1/runner/review-jobs/job-1/verification-plan",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(withAuth ? { Authorization: `Bearer ${SECRET}` } : {}),
      },
      body: JSON.stringify(body),
    }
  );
}

function params(jobId = "job-1") {
  return { params: Promise.resolve({ jobId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JACE_CONSOLE_TOKEN = SECRET;
  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(BOUND_REVIEW_SESSION as never);
  vi.mocked(getReviewJobById).mockResolvedValue(RUNNING_JOB as never);
  vi.mocked(readChangeRecordTimelineByPr).mockResolvedValue({ record: RECORD, events: [] } as never);
  vi.mocked(readAcceptanceContracts).mockResolvedValue([CONTRACT] as never);
  vi.mocked(appendChangeRecordEvent).mockResolvedValue({
    event: PLAN_EVENT,
    inserted: true,
  } as never);
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.JACE_CONSOLE_TOKEN;
  else process.env.JACE_CONSOLE_TOKEN = ORIGINAL_TOKEN;
});

describe("POST /api/v1/runner/review-jobs/[jobId]/verification-plan", () => {
  it("rejects unauthenticated requests before reading session or job state", async () => {
    const response = await POST(
      postReq({ eveSessionId: "eve-session-1", plans: REQUEST_PLANS }, false),
      params()
    );

    expect(response.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    expect(getReviewJobById).not.toHaveBeenCalled();
  });

  it("rejects caller-supplied identity fields before any lookup", async () => {
    const response = await POST(
      postReq({
        eveSessionId: "eve-session-1",
        plans: REQUEST_PLANS,
        headSha: "b".repeat(40),
      }),
      params()
    );

    expect(response.status).toBe(400);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
  });

  it("rejects a session that is not active and bound to the path job", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
      ...BOUND_REVIEW_SESSION,
      conversationKey: "review-job:other-job",
    } as never);

    const response = await POST(
      postReq({ eveSessionId: "eve-session-1", plans: REQUEST_PLANS }),
      params()
    );

    expect(response.status).toBe(409);
    expect(getReviewJobById).not.toHaveBeenCalled();
  });

  it("rejects a non-running or cross-workspace review job", async () => {
    for (const job of [
      { ...RUNNING_JOB, state: "posted" },
      { ...RUNNING_JOB, workspaceId: "ws-other" },
    ]) {
      vi.mocked(getReviewJobById).mockResolvedValueOnce(job as never);
      const response = await POST(
        postReq({ eveSessionId: "eve-session-1", plans: REQUEST_PLANS }),
        params()
      );
      expect(response.status).toBe(409);
    }

    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
  });

  it("rejects a foreign head or anything other than one valid confirmed Contract", async () => {
    vi.mocked(readChangeRecordTimelineByPr).mockResolvedValueOnce({
      record: { ...RECORD, headShas: ["b".repeat(40)] },
      events: [],
    } as never);
    expect((await POST(
      postReq({ eveSessionId: "eve-session-1", plans: REQUEST_PLANS }),
      params()
    )).status).toBe(409);

    vi.mocked(readAcceptanceContracts).mockResolvedValueOnce([
      CONTRACT,
      { ...CONTRACT, id: "contract-2", version: 4 },
    ] as never);
    expect((await POST(
      postReq({ eveSessionId: "eve-session-1", plans: REQUEST_PLANS }),
      params()
    )).status).toBe(409);

    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
  });

  it("rejects a legacy confirmed Contract whose criteria omit userVisible", async () => {
    vi.mocked(readAcceptanceContracts).mockResolvedValueOnce([{
      ...CONTRACT,
      contract: {
        acceptanceCriteria: [
          { id: "AC-UI", text: "Legacy UI criterion" },
          { id: "AC-API", text: "Legacy API criterion" },
        ],
      },
    }] as never);

    const response = await POST(
      postReq({ eveSessionId: "eve-session-1", plans: REQUEST_PLANS }),
      params()
    );

    expect(response.status).toBe(409);
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
  });

  it("requires one valid plan per confirmed criterion and fails closed on unsupported executors", async () => {
    const invalidPlans = [
      [REQUEST_PLANS[0]],
      [REQUEST_PLANS[0], { ...REQUEST_PLANS[1], criterionId: "AC-UI" }],
      [{ ...REQUEST_PLANS[0], flow: "" }, REQUEST_PLANS[1]],
      [{ ...REQUEST_PLANS[0], uiSteps: [{ action: "open", path: "//external" }, { action: "expect_text", text: "Saved filter" }, { action: "screenshot", label: "proof" }] }, REQUEST_PLANS[1]],
      [{ ...REQUEST_PLANS[0], uiSteps: [{ action: "open", path: "/filters" }, { action: "screenshot", label: "too early" }, { action: "expect_text", text: "Saved filter" }] }, REQUEST_PLANS[1]],
      [REQUEST_PLANS[0], { ...REQUEST_PLANS[1], notTestableReason: "" }],
      [REQUEST_PLANS[0], { ...REQUEST_PLANS[1], status: "planned", flow: "GET /filters" }],
      [{
        criterionId: "AC-UI",
        modality: "api",
        status: "not_testable",
        notTestableReason: "Incorrectly classified as an API criterion.",
      }, REQUEST_PLANS[1]],
    ];

    for (const plans of invalidPlans) {
      const response = await POST(
        postReq({ eveSessionId: "eve-session-1", plans }),
        params()
      );
      expect(response.status).toBe(400);
    }

    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
  });

  it("persists one immutable exact-job plan event in confirmed criterion order", async () => {
    const response = await POST(
      postReq({
        eveSessionId: "eve-session-1",
        plans: [...REQUEST_PLANS].reverse(),
      }),
      params()
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      ok: true,
      inserted: true,
      headSha: HEAD_SHA,
      acceptanceContractVersion: 3,
      plans: STORED_PAYLOAD.plans,
    });
    expect(appendChangeRecordEvent).toHaveBeenCalledWith({
      recordId: "record-1",
      eventKey: "verification:plan:job-1",
      stage: "verification",
      actor: "jace:review-verification-planner",
      payloadRef: STORED_PAYLOAD,
    });
  });

  it("replays an identical stored plan without appending a second event", async () => {
    vi.mocked(readChangeRecordTimelineByPr).mockResolvedValue({
      record: RECORD,
      events: [PLAN_EVENT],
    } as never);
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
      ...BOUND_REVIEW_SESSION,
      id: "session-retry-2",
    } as never);

    const response = await POST(
      postReq({ eveSessionId: "eve-session-1", plans: REQUEST_PLANS }),
      params()
    );

    expect(response.status).toBe(200);
    expect((await response.json()).inserted).toBe(false);
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
  });

  it("rejects an attempt to replace the immutable plan for the same review job", async () => {
    vi.mocked(readChangeRecordTimelineByPr).mockResolvedValue({
      record: RECORD,
      events: [{
        ...PLAN_EVENT,
        payloadRef: {
          ...STORED_PAYLOAD,
          plans: STORED_PAYLOAD.plans.map((plan) =>
            plan.criterionId === "AC-UI" ? { ...plan, flow: "Different flow" } : plan
          ),
        },
      }],
    } as never);

    const response = await POST(
      postReq({ eveSessionId: "eve-session-1", plans: REQUEST_PLANS }),
      params()
    );

    expect(response.status).toBe(409);
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
  });
});
