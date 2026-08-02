import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getReviewJobState: vi.fn(),
  bindReviewJobSession: vi.fn(),
  releaseReviewJob: vi.fn(),
}));
import { POST } from "./route";
import { getReviewJobState, bindReviewJobSession, releaseReviewJob } from "@agentrail/db-postgres";

const mockGetState = vi.mocked(getReviewJobState);
const mockBind = vi.mocked(bindReviewJobSession);
const mockRelease = vi.mocked(releaseReviewJob);

// Central-secret auth — same idiom as the sibling claim/complete routes.
const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function postReq(body: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/review-jobs/bind", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${SECRET}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function rawReq(rawBody: string, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/review-jobs/bind", {
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
  mockGetState.mockResolvedValue("running" as never);
  mockBind.mockResolvedValue(undefined as never);
  mockRelease.mockResolvedValue(undefined as never);
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("POST /api/v1/runner/review-jobs/bind", () => {
  // ---------------------------------------------------------------------
  // auth — mirrors the sibling claim/complete routes' own auth tests
  // ---------------------------------------------------------------------
  describe("auth (central JACE_CONSOLE_TOKEN secret)", () => {
    it("401 when no Authorization header is sent, and never touches getReviewJobState/bindReviewJobSession", async () => {
      const res = await POST(postReq({ jobId: "job-1", eveSessionId: "eve-1" }, false));
      expect(res.status).toBe(401);
      expect(mockGetState).not.toHaveBeenCalled();
      expect(mockBind).not.toHaveBeenCalled();
    });

    it("401 when JACE_CONSOLE_TOKEN is unset (fail closed)", async () => {
      delete process.env[ENV_KEY];
      const res = await POST(postReq({ jobId: "job-1", eveSessionId: "eve-1" }));
      expect(res.status).toBe(401);
    });

    it("401 on a wrong secret", async () => {
      const res = await POST(
        new NextRequest("http://localhost/api/v1/runner/review-jobs/bind", {
          method: "POST",
          headers: { "content-type": "application/json", Authorization: "Bearer wrong-secret" },
          body: JSON.stringify({ jobId: "job-1", eveSessionId: "eve-1" }),
        })
      );
      expect(res.status).toBe(401);
    });

    it("401 body is requireJaceConsoleSecret's exact shape: { error: 'Unauthorized' }", async () => {
      const res = await POST(postReq({ jobId: "job-1", eveSessionId: "eve-1" }, false));
      expect(await res.json()).toEqual({ error: "Unauthorized" });
    });
  });

  // ---------------------------------------------------------------------
  // body validation (400) — before any db call
  // ---------------------------------------------------------------------
  describe("body validation", () => {
    it("400 on invalid JSON", async () => {
      const res = await POST(rawReq("{not valid json"));
      expect(res.status).toBe(400);
      expect(mockGetState).not.toHaveBeenCalled();
    });

    it("400 when jobId is missing", async () => {
      const res = await POST(postReq({ eveSessionId: "eve-1" }));
      expect(res.status).toBe(400);
      expect(mockGetState).not.toHaveBeenCalled();
    });

    it("400 when eveSessionId is missing", async () => {
      const res = await POST(postReq({ jobId: "job-1" }));
      expect(res.status).toBe(400);
      expect(mockGetState).not.toHaveBeenCalled();
    });

    it("400 when jobId is an empty string", async () => {
      const res = await POST(postReq({ jobId: "", eveSessionId: "eve-1" }));
      expect(res.status).toBe(400);
    });

    it("400 when eveSessionId is an empty string", async () => {
      const res = await POST(postReq({ jobId: "job-1", eveSessionId: "" }));
      expect(res.status).toBe(400);
    });

    it("400 when both fields are missing entirely (empty body)", async () => {
      const res = await POST(postReq({}));
      expect(res.status).toBe(400);
      expect(mockGetState).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // job not in running -> 409 (fix wave: claim no longer binds, so the job
  // could have moved on — reclaimed by the stale-running pre-pass, already
  // resolved, etc. — by the time bind is called)
  // ---------------------------------------------------------------------
  describe("job not in running -> 409", () => {
    it("409 when the job does not exist at all (getReviewJobState -> null), and bindReviewJobSession is never called", async () => {
      mockGetState.mockResolvedValue(null as never);
      const res = await POST(postReq({ jobId: "missing-job", eveSessionId: "eve-1" }));
      expect(res.status).toBe(409);
      expect(mockBind).not.toHaveBeenCalled();
      expect(mockRelease).not.toHaveBeenCalled();
    });

    it("409 when the job exists but is queued (e.g. reclaimed by the stale-running pre-pass), and bindReviewJobSession is never called", async () => {
      mockGetState.mockResolvedValue("queued" as never);
      const res = await POST(postReq({ jobId: "job-1", eveSessionId: "eve-1" }));
      expect(res.status).toBe(409);
      expect(mockBind).not.toHaveBeenCalled();
    });

    it("409 when the job already resolved (posted/failed/superseded/skipped)", async () => {
      for (const state of ["posted", "failed", "superseded", "skipped"]) {
        mockGetState.mockResolvedValue(state as never);
        const res = await POST(postReq({ jobId: "job-1", eveSessionId: "eve-1" }));
        expect(res.status).toBe(409);
      }
      expect(mockBind).not.toHaveBeenCalled();
    });

    it("calls getReviewJobState with the exact jobId from the body", async () => {
      mockGetState.mockResolvedValue("running" as never);
      await POST(postReq({ jobId: "job-77", eveSessionId: "eve-1" }));
      expect(mockGetState).toHaveBeenCalledWith("job-77");
    });
  });

  // ---------------------------------------------------------------------
  // running -> bind -> 200 {ok:true}
  // ---------------------------------------------------------------------
  describe("job running -> bind succeeds", () => {
    it("calls bindReviewJobSession with the job id + eveSessionId", async () => {
      mockGetState.mockResolvedValue("running" as never);
      await POST(postReq({ jobId: "job-1", eveSessionId: "eve-session-9" }));
      expect(mockBind).toHaveBeenCalledWith({ jobId: "job-1", eveSessionId: "eve-session-9" });
    });

    it("200 { ok: true } on success", async () => {
      mockGetState.mockResolvedValue("running" as never);
      const res = await POST(postReq({ jobId: "job-1", eveSessionId: "eve-1" }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(mockRelease).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // bind failure -> release (not leak) -> 503 (the compensating pattern
  // moved here verbatim from the original claim route)
  // ---------------------------------------------------------------------
  describe("bind failure releases the claim", () => {
    it("calls releaseReviewJob with the job's id when bindReviewJobSession throws", async () => {
      mockGetState.mockResolvedValue("running" as never);
      mockBind.mockRejectedValue(new Error("session store down"));

      await POST(postReq({ jobId: "job-1", eveSessionId: "eve-1" }));

      expect(mockRelease).toHaveBeenCalledWith({ jobId: "job-1" });
    });

    it("responds 503 when bindReviewJobSession throws", async () => {
      mockGetState.mockResolvedValue("running" as never);
      mockBind.mockRejectedValue(new Error("session store down"));

      const res = await POST(postReq({ jobId: "job-1", eveSessionId: "eve-1" }));

      expect(res.status).toBe(503);
    });

    it("never leaks a claimed job on bind failure: releaseReviewJob itself throwing still yields 503, not a 500 crash", async () => {
      mockGetState.mockResolvedValue("running" as never);
      mockBind.mockRejectedValue(new Error("session store down"));
      mockRelease.mockRejectedValue(new Error("db also down"));

      const res = await POST(postReq({ jobId: "job-1", eveSessionId: "eve-1" }));

      expect(res.status).toBe(503);
    });
  });
});
