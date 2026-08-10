import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  enqueuePreviewBoot: vi.fn(),
  getJaceSessionByEveSessionId: vi.fn(),
  getReviewJobById: vi.fn(),
  readAcceptanceContracts: vi.fn(),
  readChangeRecordTimelineByPr: vi.fn(),
}));

import {
  enqueuePreviewBoot,
  getJaceSessionByEveSessionId,
  getReviewJobById,
  readAcceptanceContracts,
  readChangeRecordTimelineByPr,
} from "@agentrail/db-postgres";
import { POST } from "./route";

const SECRET = "jace-shared-secret-abc123";
const HEAD_SHA = "a".repeat(40);
const NOW = new Date("2026-08-10T00:00:00.000Z");
const ORIGINAL_ENV = {
  JACE_CONSOLE_TOKEN: process.env.JACE_CONSOLE_TOKEN,
  PREVIEW_BOOTS_ENABLED: process.env.PREVIEW_BOOTS_ENABLED,
  PREVIEW_BOOTS_WORKSPACES: process.env.PREVIEW_BOOTS_WORKSPACES,
};

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

const EXACT_HEAD_TIMELINE = {
  record: {
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
  },
  events: [],
};

const CONFIRMED_CONTRACT = [{
  id: "contract-1",
  recordId: "record-1",
  version: 1,
  status: "confirmed",
  contract: {
    acceptanceCriteria: [
      { id: "AC-1", text: "The saved value is visible.", userVisible: true },
    ],
  },
  createdBy: "user-1",
  createdAt: NOW,
  confirmedAt: NOW,
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
    headSha: HEAD_SHA,
    recordId: "record-1",
    acceptanceContractId: "contract-1",
    acceptanceContractVersion: 1,
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

function postReq(body: unknown, withAuth = true): NextRequest {
  return new NextRequest(
    "http://localhost/api/v1/runner/review-jobs/job-1/preview",
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
  process.env.PREVIEW_BOOTS_ENABLED = "1";
  process.env.PREVIEW_BOOTS_WORKSPACES = "ws-1";
  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(BOUND_REVIEW_SESSION as never);
  vi.mocked(getReviewJobById).mockResolvedValue(RUNNING_JOB as never);
  vi.mocked(readChangeRecordTimelineByPr).mockResolvedValue({
    ...EXACT_HEAD_TIMELINE,
    events: [PLAN_EVENT],
  } as never);
  vi.mocked(readAcceptanceContracts).mockResolvedValue(CONFIRMED_CONTRACT as never);
  vi.mocked(enqueuePreviewBoot).mockResolvedValue({
    id: "boot-1",
    deduped: false,
    superseded: 0,
  } as never);
});

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("POST /api/v1/runner/review-jobs/[jobId]/preview", () => {
  it("rejects unauthenticated requests before reading any session or job", async () => {
    const response = await POST(
      postReq({ eveSessionId: "eve-session-1" }, false),
      params()
    );

    expect(response.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    expect(getReviewJobById).not.toHaveBeenCalled();
  });

  it("fails closed when preview boots are disabled", async () => {
    delete process.env.PREVIEW_BOOTS_ENABLED;

    const response = await POST(
      postReq({ eveSessionId: "eve-session-1" }),
      params()
    );

    expect(response.status).toBe(503);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("rejects caller-supplied repo, PR, or SHA fields before any lookup", async () => {
    const response = await POST(
      postReq({
        eveSessionId: "eve-session-1",
        repo: "attacker/other",
        prNumber: 999,
        headSha: "b".repeat(40),
      }),
      params()
    );

    expect(response.status).toBe(400);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    expect(enqueuePreviewBoot).not.toHaveBeenCalled();
  });

  it("rejects a session that is not bound to the path job before looking up that job", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
      ...BOUND_REVIEW_SESSION,
      conversationKey: "review-job:other-job",
    } as never);

    const response = await POST(
      postReq({ eveSessionId: "eve-session-1" }),
      params()
    );

    expect(response.status).toBe(409);
    expect(getReviewJobById).not.toHaveBeenCalled();
    expect(enqueuePreviewBoot).not.toHaveBeenCalled();
  });

  it("rejects a closed review-job session before looking up that job", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
      ...BOUND_REVIEW_SESSION,
      status: "closed",
    } as never);

    const response = await POST(
      postReq({ eveSessionId: "eve-session-1" }),
      params()
    );

    expect(response.status).toBe(409);
    expect(getReviewJobById).not.toHaveBeenCalled();
    expect(enqueuePreviewBoot).not.toHaveBeenCalled();
  });

  it("rejects a non-running job or a session from another workspace", async () => {
    for (const job of [
      { ...RUNNING_JOB, state: "posted" },
      { ...RUNNING_JOB, workspaceId: "ws-other" },
    ]) {
      vi.mocked(getReviewJobById).mockResolvedValueOnce(job as never);
      const response = await POST(
        postReq({ eveSessionId: "eve-session-1" }),
        params()
      );
      expect(response.status).toBe(409);
    }

    expect(enqueuePreviewBoot).not.toHaveBeenCalled();
  });

  it("rejects a review head that is not attached to the Acceptance Record", async () => {
    vi.mocked(readChangeRecordTimelineByPr).mockResolvedValue({
      ...EXACT_HEAD_TIMELINE,
      record: { ...EXACT_HEAD_TIMELINE.record, headShas: ["b".repeat(40)] },
    } as never);

    const response = await POST(
      postReq({ eveSessionId: "eve-session-1" }),
      params()
    );

    expect(response.status).toBe(409);
    expect(readAcceptanceContracts).not.toHaveBeenCalled();
    expect(enqueuePreviewBoot).not.toHaveBeenCalled();
  });

  it("rejects absent, multiple, or malformed confirmed Contracts", async () => {
    for (const contracts of [
      [],
      [...CONFIRMED_CONTRACT, { ...CONFIRMED_CONTRACT[0], id: "contract-2", version: 2 }],
      [{
        ...CONFIRMED_CONTRACT[0],
        contract: {
          acceptanceCriteria: [{ id: "AC-1", text: "Legacy criterion" }],
        },
      }],
      [{
        ...CONFIRMED_CONTRACT[0],
        contract: {
          acceptanceCriteria: [
            { id: "AC-1", text: "First", userVisible: true },
            { id: "AC-1", text: "Duplicate", userVisible: false },
          ],
        },
      }],
    ]) {
      vi.mocked(readAcceptanceContracts).mockResolvedValueOnce(contracts as never);
      const response = await POST(
        postReq({ eveSessionId: "eve-session-1" }),
        params()
      );
      expect(response.status).toBe(409);
    }

    expect(enqueuePreviewBoot).not.toHaveBeenCalled();
  });

  it("rejects boot admission until the exact review job has a persisted planned UI criterion", async () => {
    vi.mocked(readChangeRecordTimelineByPr).mockResolvedValue(EXACT_HEAD_TIMELINE as never);

    const response = await POST(
      postReq({ eveSessionId: "eve-session-1" }),
      params()
    );

    expect(response.status).toBe(409);
    expect(enqueuePreviewBoot).not.toHaveBeenCalled();
  });

  it("admits the exact review head from the bound running job, never a caller-supplied tuple", async () => {
    const response = await POST(
      postReq({ eveSessionId: "eve-session-1" }),
      params()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "boot-1", deduped: false });
    expect(enqueuePreviewBoot).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      repo: "acme/widgets",
      prNumber: 42,
      headSha: HEAD_SHA,
      ref: HEAD_SHA,
    });
  });

  it("surfaces deterministic boot deduplication without leaking supersession details", async () => {
    vi.mocked(enqueuePreviewBoot).mockResolvedValue({
      id: "boot-1",
      deduped: true,
      superseded: 3,
    } as never);

    const response = await POST(
      postReq({ eveSessionId: "eve-session-1" }),
      params()
    );

    expect(await response.json()).toEqual({ id: "boot-1", deduped: true });
  });
});
