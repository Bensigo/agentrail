import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  claimReviewJob: vi.fn(),
  bindReviewJobSession: vi.fn(),
  releaseReviewJob: vi.fn(),
}));
import { POST } from "./route";
import {
  claimReviewJob,
  bindReviewJobSession,
  releaseReviewJob,
} from "@agentrail/db-postgres";

const mockClaim = vi.mocked(claimReviewJob);
const mockBind = vi.mocked(bindReviewJobSession);
const mockRelease = vi.mocked(releaseReviewJob);

// Central-secret auth — same idiom as runner/pr-review/route.test.ts and
// runner/workspace-memory/route.test.ts.
const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];
const BUDGET_ENV_KEY = "REVIEW_JOBS_DAILY_BUDGET";
const ORIGINAL_BUDGET_ENV = process.env[BUDGET_ENV_KEY];

const NOW = new Date("2026-08-01T00:00:00.000Z");

const CLAIMED_JOB = {
  id: "job-1",
  workspaceId: "ws-1",
  repo: "acme/widgets",
  prNumber: 42,
  headSha: "a".repeat(40),
  event: "opened",
  state: "running",
  attempts: 0,
  claimedBy: "worker-1",
  claimedAt: NOW,
  nextEligibleAt: null,
  postedReviewUrl: null,
  verdict: null,
  skipReason: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function postReq(body: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/review-jobs/claim", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${SECRET}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function rawReq(rawBody: string, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/review-jobs/claim", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${SECRET}` } : {}),
    },
    body: rawBody,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = SECRET;
  delete process.env[BUDGET_ENV_KEY];
  mockClaim.mockResolvedValue(null as never);
  mockBind.mockResolvedValue(undefined as never);
  mockRelease.mockResolvedValue(undefined as never);
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
  if (ORIGINAL_BUDGET_ENV === undefined) delete process.env[BUDGET_ENV_KEY];
  else process.env[BUDGET_ENV_KEY] = ORIGINAL_BUDGET_ENV;
});

describe("POST /api/v1/runner/review-jobs/claim", () => {
  // ---------------------------------------------------------------------
  // auth — mirrors runner/pr-review's own auth tests, same guard
  // ---------------------------------------------------------------------
  describe("auth (central JACE_CONSOLE_TOKEN secret)", () => {
    it("401 when no Authorization header is sent, and never touches claimReviewJob", async () => {
      const res = await POST(postReq({ workerId: "w1", eveSessionId: "eve-1" }, false));
      expect(res.status).toBe(401);
      expect(mockClaim).not.toHaveBeenCalled();
    });

    it("401 when JACE_CONSOLE_TOKEN is unset (fail closed)", async () => {
      delete process.env[ENV_KEY];
      const res = await POST(postReq({ workerId: "w1", eveSessionId: "eve-1" }));
      expect(res.status).toBe(401);
      expect(mockClaim).not.toHaveBeenCalled();
    });

    it("401 on a wrong secret", async () => {
      const res = await POST(
        new NextRequest("http://localhost/api/v1/runner/review-jobs/claim", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: "Bearer wrong-secret",
          },
          body: JSON.stringify({ workerId: "w1", eveSessionId: "eve-1" }),
        })
      );
      expect(res.status).toBe(401);
      expect(mockClaim).not.toHaveBeenCalled();
    });

    it("401 body is requireJaceConsoleSecret's exact shape: { error: 'Unauthorized' }", async () => {
      const res = await POST(postReq({ workerId: "w1", eveSessionId: "eve-1" }, false));
      expect(await res.json()).toEqual({ error: "Unauthorized" });
    });
  });

  // ---------------------------------------------------------------------
  // body validation (400) — before any claim/bind call
  // ---------------------------------------------------------------------
  describe("body validation", () => {
    it("400 on invalid JSON", async () => {
      const res = await POST(rawReq("{not valid json"));
      expect(res.status).toBe(400);
      expect(mockClaim).not.toHaveBeenCalled();
    });

    it("400 when workerId is missing", async () => {
      const res = await POST(postReq({ eveSessionId: "eve-1" }));
      expect(res.status).toBe(400);
      expect(mockClaim).not.toHaveBeenCalled();
    });

    it("400 when eveSessionId is missing", async () => {
      const res = await POST(postReq({ workerId: "w1" }));
      expect(res.status).toBe(400);
      expect(mockClaim).not.toHaveBeenCalled();
    });

    it("400 when workerId is an empty string", async () => {
      const res = await POST(postReq({ workerId: "", eveSessionId: "eve-1" }));
      expect(res.status).toBe(400);
    });

    it("400 when eveSessionId is an empty string", async () => {
      const res = await POST(postReq({ workerId: "w1", eveSessionId: "" }));
      expect(res.status).toBe(400);
    });

    it("400 when both fields are missing entirely (empty body)", async () => {
      const res = await POST(postReq({}));
      expect(res.status).toBe(400);
      expect(mockClaim).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // daily budget resolution — REVIEW_JOBS_DAILY_BUDGET, default 50
  // ---------------------------------------------------------------------
  describe("daily budget resolution", () => {
    it("defaults dailyBudget to 50 when REVIEW_JOBS_DAILY_BUDGET is unset", async () => {
      await POST(postReq({ workerId: "w1", eveSessionId: "eve-1" }));
      expect(mockClaim).toHaveBeenCalledWith({ workerId: "w1", dailyBudget: 50 });
    });

    it("resolves dailyBudget from REVIEW_JOBS_DAILY_BUDGET when set", async () => {
      process.env[BUDGET_ENV_KEY] = "10";
      await POST(postReq({ workerId: "w1", eveSessionId: "eve-1" }));
      expect(mockClaim).toHaveBeenCalledWith({ workerId: "w1", dailyBudget: 10 });
    });

    it("falls back to the default when REVIEW_JOBS_DAILY_BUDGET is not a valid number", async () => {
      process.env[BUDGET_ENV_KEY] = "not-a-number";
      await POST(postReq({ workerId: "w1", eveSessionId: "eve-1" }));
      expect(mockClaim).toHaveBeenCalledWith({ workerId: "w1", dailyBudget: 50 });
    });
  });

  // ---------------------------------------------------------------------
  // no eligible job -> 204 empty
  // ---------------------------------------------------------------------
  it("204 with an empty body when no eligible job exists", async () => {
    mockClaim.mockResolvedValue(null as never);
    const res = await POST(postReq({ workerId: "w1", eveSessionId: "eve-1" }));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(mockBind).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // claimed -> bind -> 200 { job }
  // ---------------------------------------------------------------------
  describe("job claimed", () => {
    it("binds the session with the job id + eveSessionId BEFORE responding", async () => {
      mockClaim.mockResolvedValue(CLAIMED_JOB as never);
      await POST(postReq({ workerId: "w1", eveSessionId: "eve-session-9" }));

      expect(mockBind).toHaveBeenCalledWith({
        jobId: "job-1",
        eveSessionId: "eve-session-9",
      });
    });

    it("200 with { job: { id, repo, prNumber, headSha, event, workspaceId } }", async () => {
      mockClaim.mockResolvedValue(CLAIMED_JOB as never);
      const res = await POST(postReq({ workerId: "w1", eveSessionId: "eve-session-9" }));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        job: {
          id: "job-1",
          repo: "acme/widgets",
          prNumber: 42,
          headSha: "a".repeat(40),
          event: "opened",
          workspaceId: "ws-1",
        },
      });
      expect(mockRelease).not.toHaveBeenCalled();
    });

    it("passes the claimed job's own workerId through to claimReviewJob", async () => {
      mockClaim.mockResolvedValue(CLAIMED_JOB as never);
      await POST(postReq({ workerId: "worker-xyz", eveSessionId: "eve-1" }));
      expect(mockClaim).toHaveBeenCalledWith({ workerId: "worker-xyz", dailyBudget: 50 });
    });
  });

  // ---------------------------------------------------------------------
  // bind failure -> release (not leak) -> 503
  // ---------------------------------------------------------------------
  describe("bind failure releases the claim", () => {
    it("calls releaseReviewJob with the claimed job's id when bindReviewJobSession throws", async () => {
      mockClaim.mockResolvedValue(CLAIMED_JOB as never);
      mockBind.mockRejectedValue(new Error("session store down"));

      await POST(postReq({ workerId: "w1", eveSessionId: "eve-1" }));

      expect(mockRelease).toHaveBeenCalledWith({ jobId: "job-1" });
    });

    it("responds 503 when bindReviewJobSession throws", async () => {
      mockClaim.mockResolvedValue(CLAIMED_JOB as never);
      mockBind.mockRejectedValue(new Error("session store down"));

      const res = await POST(postReq({ workerId: "w1", eveSessionId: "eve-1" }));

      expect(res.status).toBe(503);
    });

    it("never leaks a claimed job on bind failure: releaseReviewJob itself throwing still yields 503, not a 500 crash", async () => {
      mockClaim.mockResolvedValue(CLAIMED_JOB as never);
      mockBind.mockRejectedValue(new Error("session store down"));
      mockRelease.mockRejectedValue(new Error("db also down"));

      const res = await POST(postReq({ workerId: "w1", eveSessionId: "eve-1" }));

      expect(res.status).toBe(503);
    });
  });
});
