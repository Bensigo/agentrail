import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  reportPreviewBoot: vi.fn(),
}));
import { reportPreviewBoot } from "@agentrail/db-postgres";

import { POST } from "./route";

const mockReport = vi.mocked(reportPreviewBoot);

const AUTH_ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const FLAG_ENV_KEY = "PREVIEW_BOOTS_ENABLED";

const ORIGINAL_ENV: Record<string, string | undefined> = {};
const ALL_ENV_KEYS = [AUTH_ENV_KEY, FLAG_ENV_KEY] as const;

function saveEnv(keys: readonly string[]) {
  for (const k of keys) ORIGINAL_ENV[k] = process.env[k];
}
function restoreEnv(keys: readonly string[]) {
  for (const k of keys) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k];
  }
}

function postReq(body?: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/preview-boots/report", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${SECRET}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const NOW = new Date("2026-08-02T00:00:00.000Z");

const READY_ROW = {
  id: "boot-1",
  workspaceId: "ws-1",
  repo: "ada/widgets",
  prNumber: 98,
  headSha: "deadbeefcafe",
  ref: "deadbeefcafe",
  status: "ready",
  workerId: "worker-1",
  claimedAt: NOW,
  url: "http://127.0.0.1:41234",
  port: 41234,
  reason: null,
  attempts: 0,
  expiresAt: new Date(NOW.getTime() + 720_000),
  lastLivenessAt: NOW,
  nextEligibleAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const VALID_BOOTING_BODY = { id: "boot-1", workerId: "worker-1", status: "booting" as const };
const VALID_READY_BODY = {
  id: "boot-1",
  workerId: "worker-1",
  status: "ready" as const,
  url: "http://127.0.0.1:41234",
  port: 41234,
};

beforeEach(() => {
  vi.clearAllMocks();
  saveEnv(ALL_ENV_KEYS);
  process.env[AUTH_ENV_KEY] = SECRET;
  process.env[FLAG_ENV_KEY] = "1";
  mockReport.mockResolvedValue(null as never);
});

afterEach(() => {
  restoreEnv(ALL_ENV_KEYS);
});

describe("POST /api/v1/runner/preview-boots/report", () => {
  // -------------------------------------------------------------------------
  // auth
  // -------------------------------------------------------------------------
  describe("auth (central JACE_CONSOLE_TOKEN secret)", () => {
    it("401 when no Authorization header is sent, and never touches the flag/reportPreviewBoot", async () => {
      process.env[FLAG_ENV_KEY] = "0"; // flag OFF too — proves auth wins the race
      const res = await POST(postReq(VALID_BOOTING_BODY, false));
      expect(res.status).toBe(401);
      expect(mockReport).not.toHaveBeenCalled();
    });

    it("401 when JACE_CONSOLE_TOKEN is unset (fail closed)", async () => {
      delete process.env[AUTH_ENV_KEY];
      const res = await POST(postReq(VALID_BOOTING_BODY));
      expect(res.status).toBe(401);
      expect(mockReport).not.toHaveBeenCalled();
    });

    it("401 on a wrong secret", async () => {
      const res = await POST(
        new NextRequest("http://localhost/api/v1/runner/preview-boots/report", {
          method: "POST",
          headers: { "content-type": "application/json", Authorization: "Bearer wrong-secret" },
          body: JSON.stringify(VALID_BOOTING_BODY),
        })
      );
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // flag — checked AFTER auth
  // -------------------------------------------------------------------------
  describe("flag (PREVIEW_BOOTS_ENABLED)", () => {
    it('503 {error:"preview boots not enabled"} when the flag is unset', async () => {
      delete process.env[FLAG_ENV_KEY];
      const res = await POST(postReq(VALID_BOOTING_BODY));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "preview boots not enabled" });
      expect(mockReport).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // body validation (400)
  // -------------------------------------------------------------------------
  describe("body validation", () => {
    it("400 on invalid JSON", async () => {
      const res = await POST(
        new NextRequest("http://localhost/api/v1/runner/preview-boots/report", {
          method: "POST",
          headers: { "content-type": "application/json", Authorization: `Bearer ${SECRET}` },
          body: "{not valid json",
        })
      );
      expect(res.status).toBe(400);
      expect(mockReport).not.toHaveBeenCalled();
    });

    it("400 when id is missing", async () => {
      const res = await POST(postReq({ workerId: "w1", status: "booting" }));
      expect(res.status).toBe(400);
      expect(mockReport).not.toHaveBeenCalled();
    });

    it("400 when workerId is missing", async () => {
      const res = await POST(postReq({ id: "boot-1", status: "booting" }));
      expect(res.status).toBe(400);
    });

    it("400 when status is missing", async () => {
      const res = await POST(postReq({ id: "boot-1", workerId: "w1" }));
      expect(res.status).toBe(400);
      expect(mockReport).not.toHaveBeenCalled();
    });

    it("400 when status is not one of the four legal values", async () => {
      for (const status of ["pending", "claimed", "done", "", "READY"]) {
        const res = await POST(postReq({ id: "boot-1", workerId: "w1", status }));
        expect(res.status, `status=${JSON.stringify(status)} should 400`).toBe(400);
      }
      expect(mockReport).not.toHaveBeenCalled();
    });

    it.each(["booting", "ready", "failed", "torn_down"] as const)(
      "accepts status=%s as a legal value (reaches reportPreviewBoot)",
      async (status) => {
        mockReport.mockResolvedValue({ ...READY_ROW, status } as never);
        const res = await POST(postReq({ id: "boot-1", workerId: "w1", status }));
        expect(res.status).not.toBe(400);
        expect(mockReport).toHaveBeenCalled();
      }
    );

    it("400 when url is present but not a string", async () => {
      const res = await POST(postReq({ ...VALID_READY_BODY, url: 12345 }));
      expect(res.status).toBe(400);
      expect(mockReport).not.toHaveBeenCalled();
    });

    it("400 when port is present but not a number", async () => {
      const res = await POST(postReq({ ...VALID_READY_BODY, port: "41234" }));
      expect(res.status).toBe(400);
      expect(mockReport).not.toHaveBeenCalled();
    });

    // Fix round 1 (review Finding 2, Minor): `typeof x === "number"` is true
    // for NaN/Infinity/non-integers too, which would previously pass this
    // gate and then throw uncaught at the Postgres driver layer (the
    // `port` column is `integer`) instead of a clean 400.
    it("400 when port is a number but not a valid integer (NaN/Infinity/non-integer) — would otherwise reach the DB layer uncaught", async () => {
      for (const port of [NaN, Infinity, -Infinity, 1.5]) {
        const res = await POST(postReq({ ...VALID_READY_BODY, port }));
        expect(res.status, `port=${port} should 400`).toBe(400);
      }
      expect(mockReport).not.toHaveBeenCalled();
    });

    it("accepts a negative or zero integer port without 400ing (only non-integers are rejected — scope of this fix)", async () => {
      for (const port of [0, -1]) {
        mockReport.mockResolvedValue({ ...READY_ROW, port } as never);
        const res = await POST(postReq({ ...VALID_READY_BODY, port }));
        expect(res.status, `port=${port} should not 400`).not.toBe(400);
      }
    });

    it("400 when reason is present but not a string", async () => {
      const res = await POST(postReq({ id: "boot-1", workerId: "w1", status: "failed", reason: 123 }));
      expect(res.status).toBe(400);
      expect(mockReport).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // pass-through to reportPreviewBoot
  // -------------------------------------------------------------------------
  describe("pass-through", () => {
    it("passes id/workerId/status through, with url/port/reason undefined when omitted", async () => {
      mockReport.mockResolvedValue({ ...READY_ROW, status: "booting" } as never);
      await POST(postReq(VALID_BOOTING_BODY));
      expect(mockReport).toHaveBeenCalledWith({
        id: "boot-1",
        workerId: "worker-1",
        status: "booting",
        url: undefined,
        port: undefined,
        reason: undefined,
      });
    });

    it("passes url/port through on a ready report", async () => {
      mockReport.mockResolvedValue(READY_ROW as never);
      await POST(postReq(VALID_READY_BODY));
      expect(mockReport).toHaveBeenCalledWith({
        id: "boot-1",
        workerId: "worker-1",
        status: "ready",
        url: "http://127.0.0.1:41234",
        port: 41234,
        reason: undefined,
      });
    });

    it("passes reason through on a failed report", async () => {
      mockReport.mockResolvedValue({ ...READY_ROW, status: "failed", reason: "boot error", url: null, port: null } as never);
      await POST(postReq({ id: "boot-1", workerId: "worker-1", status: "failed", reason: "boot error" }));
      expect(mockReport).toHaveBeenCalledWith({
        id: "boot-1",
        workerId: "worker-1",
        status: "failed",
        url: undefined,
        port: undefined,
        reason: "boot error",
      });
    });
  });

  // -------------------------------------------------------------------------
  // guarded transition: null -> 409 (foreign worker, illegal transition, or
  // unknown id all collapse into this same outcome — see route's doc-comment)
  // -------------------------------------------------------------------------
  describe("guarded transition failure", () => {
    it('409 {error:"boot not found or not owned"} when reportPreviewBoot returns null', async () => {
      mockReport.mockResolvedValue(null as never);
      const res = await POST(postReq(VALID_BOOTING_BODY));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "boot not found or not owned" });
    });

    it("409 for a report from a worker that does not own the row (reportPreviewBoot itself scopes by workerId)", async () => {
      mockReport.mockResolvedValue(null as never);
      const res = await POST(postReq({ id: "boot-1", workerId: "some-other-worker", status: "booting" }));
      expect(res.status).toBe(409);
      expect(mockReport).toHaveBeenCalledWith(
        expect.objectContaining({ id: "boot-1", workerId: "some-other-worker" })
      );
    });

    it("409 for an unknown boot id", async () => {
      mockReport.mockResolvedValue(null as never);
      const res = await POST(postReq({ id: "unknown-id", workerId: "w1", status: "ready" }));
      expect(res.status).toBe(409);
    });
  });

  // -------------------------------------------------------------------------
  // happy path — 200 {ok:true, status:row.status}
  // -------------------------------------------------------------------------
  describe("happy path", () => {
    it("200 {ok:true, status} reflecting the row's OWN post-transition status", async () => {
      mockReport.mockResolvedValue(READY_ROW as never);
      const res = await POST(postReq(VALID_READY_BODY));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, status: "ready" });
    });

    it("200 on the idempotent ready -> ready liveness re-report", async () => {
      mockReport.mockResolvedValue({ ...READY_ROW, status: "ready" } as never);
      const res = await POST(postReq({ id: "boot-1", workerId: "worker-1", status: "ready" }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, status: "ready" });
    });

    it("200 on a torn_down report", async () => {
      mockReport.mockResolvedValue({ ...READY_ROW, status: "torn_down", reason: "ttl expired" } as never);
      const res = await POST(postReq({ id: "boot-1", workerId: "worker-1", status: "torn_down", reason: "ttl expired" }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, status: "torn_down" });
    });
  });
});
