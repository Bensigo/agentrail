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
import {
  confirmedVerificationContract,
  parseStoredReviewJobVerificationPlan,
} from "../../../../../../../lib/review-job-verification-plan";
import { POST } from "./route";

const SECRET = "jace-shared-secret-abc123";
const HEAD_SHA = "a".repeat(40);
const NOW = new Date("2026-08-10T00:00:00.000Z");
const ORIGINAL_TOKEN = process.env.JACE_CONSOLE_TOKEN;
const ORIGINAL_HMAC_ACTIVE = process.env.REVIEW_DATA_HMAC_ACTIVE_KEY_ID;
const ORIGINAL_HMAC_KEYS = process.env.REVIEW_DATA_HMAC_KEYS_JSON;
const HMAC_KEY_ID = "review-data-2026-08";
const HMAC_KEYS_JSON = JSON.stringify({
  [HMAC_KEY_ID]: Buffer.alloc(32, 7).toString("base64url"),
});

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
    status: "planned",
    flow: "Read the saved filter endpoint and require an OK response.",
    apiRequest: {
      method: "GET",
      path: "/api/filters/saved",
      expectedStatus: 200,
    },
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
      apiRequest: null,
      dataRequest: null,
      status: "planned",
      notTestableReason: null,
    },
    {
      criterionId: "AC-API",
      criterionTextSnapshot: "The API returns the saved filter.",
      modality: "api",
      environmentKind: "isolated_preview",
      flow: "Read the saved filter endpoint and require an OK response.",
      uiSteps: null,
      apiRequest: {
        method: "GET",
        path: "/api/filters/saved",
        expectedStatus: 200,
      },
      dataRequest: null,
      status: "planned",
      notTestableReason: null,
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
  delete process.env.REVIEW_DATA_HMAC_ACTIVE_KEY_ID;
  delete process.env.REVIEW_DATA_HMAC_KEYS_JSON;
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
  if (ORIGINAL_HMAC_ACTIVE === undefined) delete process.env.REVIEW_DATA_HMAC_ACTIVE_KEY_ID;
  else process.env.REVIEW_DATA_HMAC_ACTIVE_KEY_ID = ORIGINAL_HMAC_ACTIVE;
  if (ORIGINAL_HMAC_KEYS === undefined) delete process.env.REVIEW_DATA_HMAC_KEYS_JSON;
  else process.env.REVIEW_DATA_HMAC_KEYS_JSON = ORIGINAL_HMAC_KEYS;
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

  it("requires one valid plan per confirmed criterion and fails closed on malformed descriptors or unsupported executors", async () => {
    const invalidPlans = [
      [REQUEST_PLANS[0]],
      [REQUEST_PLANS[0], { ...REQUEST_PLANS[1], criterionId: "AC-UI" }],
      [{ ...REQUEST_PLANS[0], flow: "" }, REQUEST_PLANS[1]],
      [{ ...REQUEST_PLANS[0], uiSteps: [{ action: "open", path: "//external" }, { action: "expect_text", text: "Saved filter" }, { action: "screenshot", label: "proof" }] }, REQUEST_PLANS[1]],
      [{ ...REQUEST_PLANS[0], uiSteps: [{ action: "open", path: "/filters" }, { action: "screenshot", label: "too early" }, { action: "expect_text", text: "Saved filter" }] }, REQUEST_PLANS[1]],
      [REQUEST_PLANS[0], { ...REQUEST_PLANS[1], apiRequest: { ...REQUEST_PLANS[1].apiRequest, method: "POST" } }],
      [REQUEST_PLANS[0], { ...REQUEST_PLANS[1], apiRequest: { ...REQUEST_PLANS[1].apiRequest, path: "https://other.example/api" } }],
      [REQUEST_PLANS[0], { ...REQUEST_PLANS[1], apiRequest: { ...REQUEST_PLANS[1].apiRequest, path: "/api/../admin" } }],
      [REQUEST_PLANS[0], { ...REQUEST_PLANS[1], apiRequest: { ...REQUEST_PLANS[1].apiRequest, path: "/api%2f%2e%2e%2fadmin" } }],
      [REQUEST_PLANS[0], { ...REQUEST_PLANS[1], apiRequest: { ...REQUEST_PLANS[1].apiRequest, path: "/api/filters?scope=all" } }],
      [REQUEST_PLANS[0], { ...REQUEST_PLANS[1], apiRequest: { ...REQUEST_PLANS[1].apiRequest, headers: { Authorization: "Bearer secret" } } }],
      [REQUEST_PLANS[0], { ...REQUEST_PLANS[1], apiRequest: { ...REQUEST_PLANS[1].apiRequest, body: "mutation payload" } }],
      [REQUEST_PLANS[0], { ...REQUEST_PLANS[1], apiRequest: { ...REQUEST_PLANS[1].apiRequest, expectedStatus: 99 } }],
      [REQUEST_PLANS[0], { ...REQUEST_PLANS[1], apiRequest: { ...REQUEST_PLANS[1].apiRequest, expectedStatus: 600 } }],
      [REQUEST_PLANS[0], { ...REQUEST_PLANS[1], modality: "job" }],
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

  it("keeps a legacy planned API payload without a descriptor readable but non-executable", () => {
    const legacyPayload = {
      ...STORED_PAYLOAD,
      plans: STORED_PAYLOAD.plans.map((plan) =>
        plan.criterionId === "AC-API"
          ? Object.fromEntries(Object.entries(plan).filter(([key]) => key !== "apiRequest"))
          : plan
      ),
    };
    const contract = confirmedVerificationContract([CONTRACT]);
    expect(contract).not.toBeNull();
    const parsed = parseStoredReviewJobVerificationPlan({
      payload: legacyPayload,
      job: RUNNING_JOB,
      recordId: RECORD.id,
      contract: contract!,
    });

    expect(parsed?.plans.find((plan) => plan.criterionId === "AC-API")?.apiRequest).toBeNull();
  });

  it("requires the purpose-scoped active HMAC key only for planned data and persists no raw equality", async () => {
    const dataPlans = [
      REQUEST_PLANS[0],
      {
        criterionId: "AC-API",
        modality: "data",
        status: "planned",
        flow: "Read the saved filter data.",
        dataRequest: {
          method: "GET",
          path: "/api/filters/saved",
          expectedStatus: 200,
          expectedJson: [{ pointer: "/state", equals: "saved" }],
        },
      },
    ];
    expect((await POST(
      postReq({ eveSessionId: "eve-session-1", plans: dataPlans }),
      params()
    )).status).toBe(400);
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();

    process.env.REVIEW_DATA_HMAC_ACTIVE_KEY_ID = HMAC_KEY_ID;
    process.env.REVIEW_DATA_HMAC_KEYS_JSON = HMAC_KEYS_JSON;
    vi.mocked(appendChangeRecordEvent).mockImplementationOnce(async (input) => ({
      event: { payloadRef: input.payloadRef },
      inserted: true,
    }) as never);
    const response = await POST(
      postReq({ eveSessionId: "eve-session-1", plans: dataPlans }),
      params()
    );
    expect(response.status).toBe(201);
    const json = await response.json();
    expect(JSON.stringify(json)).not.toContain('"saved"');
    expect(json.plans[1].dataRequest).toMatchObject({
      digestAlgorithm: "hmac-sha256-v1",
      digestKeyId: HMAC_KEY_ID,
      digestContext: expect.stringMatching(/^[a-f0-9]{64}$/u),
      expectedJson: [{
        pointer: "/state",
        equalsType: "string",
        equalsHmacSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }],
    });
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
