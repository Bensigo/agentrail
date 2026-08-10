import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  appendChangeRecordEvent: vi.fn(),
  completeReviewJob: vi.fn(),
  findOrCreateChangeRecord: vi.fn(),
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
  getReviewJobById,
  readAcceptanceContracts,
  readChangeRecordTimelineByPr,
} from "@agentrail/db-postgres";
import { sendWorkspaceNotification } from "../../result/notify";

const mockAppendChangeRecordEvent = vi.mocked(appendChangeRecordEvent);
const mockComplete = vi.mocked(completeReviewJob);
const mockFindOrCreateChangeRecord = vi.mocked(findOrCreateChangeRecord);
const mockGetReviewJobById = vi.mocked(getReviewJobById);
const mockReadAcceptanceContracts = vi.mocked(readAcceptanceContracts);
const mockReadChangeRecordTimelineByPr = vi.mocked(readChangeRecordTimelineByPr);
const mockNotify = vi.mocked(sendWorkspaceNotification);

// Central-secret auth — same idiom as the sibling claim route's tests.
const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

const NOW = new Date("2026-08-01T00:00:00.000Z");

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
  verdict: "approve",
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

const CONTRACT_TIMELINE = {
  record: CHANGE_RECORD,
  events: [],
};

const CONFIRMED_CONTRACT = [{
  status: "confirmed",
  version: 2,
  contract: {
    acceptanceCriteria: [
      { id: "AC-1", text: "The saved value is visible." },
    ],
  },
}];

function postReq(body: unknown, withAuth = true): NextRequest {
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
  verdict: "approve",
  summaryLine: "AgentRail review posted for acme/widgets#42 — 3/3 ACs pass, no blockers",
  criterionResults: [{
    criterionId: "AC-1",
    state: "proven",
    expected: "The saved value is visible.",
    observed: "The saved value is visible.",
    evidenceRefs: ["artifact://review/ac-1"],
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = SECRET;
  mockComplete.mockResolvedValue(null as never);
  mockGetReviewJobById.mockResolvedValue(RUNNING_JOB as never);
  mockReadChangeRecordTimelineByPr.mockResolvedValue(CONTRACT_TIMELINE as never);
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
          verdict: "approve",
        })
      );
      expect(mockComplete).toHaveBeenCalledWith({
        jobId: "job-1",
        outcome: "posted",
        postedReviewUrl: "https://github.com/acme/widgets/pull/42#pullrequestreview-1",
        verdict: "approve",
        error: null,
      });
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
          evidenceKeys: ["review-evidence/ws-1/acme__widgets/42/sha/ac-1/1.png"],
        })
      );
      expect(mockComplete).toHaveBeenCalledWith({
        jobId: "job-1",
        outcome: "posted",
        postedReviewUrl: VALID_POSTED_BODY.postedReviewUrl,
        verdict: "approve",
        error: null,
        evidenceKeys: ["review-evidence/ws-1/acme__widgets/42/sha/ac-1/1.png"],
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
          verdict: "approve",
          evidenceKeys: null,
          criterionResults: VALID_POSTED_BODY.criterionResults,
        },
        at: NOW,
      });
    });

    it("persists typed terminal outcomes with the exact review head", async () => {
      mockComplete.mockResolvedValue(POSTED_JOB as never);
      const criterionResults = [{
        criterionId: "AC-1",
        state: "not_proven",
        expected: "Saving a filter preserves it after reload.",
        observed: "No safe preview was available for the reload flow.",
        evidenceRefs: ["preview-boot:unavailable"],
      }];
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
