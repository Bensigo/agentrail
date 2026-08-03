import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  claimPreviewBoot: vi.fn(),
  getInstallationToken: vi.fn(),
}));
import { claimPreviewBoot, getInstallationToken } from "@agentrail/db-postgres";

import { POST } from "./route";

const mockClaim = vi.mocked(claimPreviewBoot);
const mockToken = vi.mocked(getInstallationToken);

const AUTH_ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const FLAG_ENV_KEY = "PREVIEW_BOOTS_ENABLED";
const TTL_ENV_KEY = "PREVIEW_BOOT_TTL_SECONDS";

const ORIGINAL_ENV: Record<string, string | undefined> = {};
const ALL_ENV_KEYS = [AUTH_ENV_KEY, FLAG_ENV_KEY, TTL_ENV_KEY] as const;

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
  return new NextRequest("http://localhost/api/v1/runner/preview-boots/claim", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${SECRET}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const NOW = new Date("2026-08-02T00:00:00.000Z");

const CLAIMED_ROW = {
  id: "boot-1",
  workspaceId: "ws-1",
  repo: "ada/widgets",
  prNumber: 98,
  headSha: "deadbeefcafe",
  ref: "deadbeefcafe",
  status: "claimed",
  workerId: "worker-1",
  claimedAt: NOW,
  url: null,
  port: null,
  reason: null,
  attempts: 0,
  expiresAt: new Date(NOW.getTime() + 720_000),
  lastLivenessAt: NOW,
  nextEligibleAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
  saveEnv(ALL_ENV_KEYS);
  process.env[AUTH_ENV_KEY] = SECRET;
  process.env[FLAG_ENV_KEY] = "1";
  delete process.env[TTL_ENV_KEY];

  mockClaim.mockResolvedValue(null as never);
  mockToken.mockResolvedValue("ghs_mockedtoken" as never);
});

afterEach(() => {
  restoreEnv(ALL_ENV_KEYS);
});

describe("POST /api/v1/runner/preview-boots/claim", () => {
  // -------------------------------------------------------------------------
  // auth
  // -------------------------------------------------------------------------
  describe("auth (central JACE_CONSOLE_TOKEN secret)", () => {
    it("401 when no Authorization header is sent, and never touches the flag/claim", async () => {
      process.env[FLAG_ENV_KEY] = "0"; // flag OFF too — proves auth wins the race
      const res = await POST(postReq({ workerId: "w1" }, false));
      expect(res.status).toBe(401);
      expect(mockClaim).not.toHaveBeenCalled();
    });

    it("401 when JACE_CONSOLE_TOKEN is unset (fail closed)", async () => {
      delete process.env[AUTH_ENV_KEY];
      const res = await POST(postReq({ workerId: "w1" }));
      expect(res.status).toBe(401);
      expect(mockClaim).not.toHaveBeenCalled();
    });

    it("401 on a wrong secret", async () => {
      const res = await POST(
        new NextRequest("http://localhost/api/v1/runner/preview-boots/claim", {
          method: "POST",
          headers: { "content-type": "application/json", Authorization: "Bearer wrong-secret" },
          body: JSON.stringify({ workerId: "w1" }),
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
      const res = await POST(postReq({ workerId: "w1" }));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "preview boots not enabled" });
      expect(mockClaim).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // body validation (400)
  // -------------------------------------------------------------------------
  describe("body validation", () => {
    it("400 on invalid JSON", async () => {
      const res = await POST(
        new NextRequest("http://localhost/api/v1/runner/preview-boots/claim", {
          method: "POST",
          headers: { "content-type": "application/json", Authorization: `Bearer ${SECRET}` },
          body: "{not valid json",
        })
      );
      expect(res.status).toBe(400);
      expect(mockClaim).not.toHaveBeenCalled();
    });

    it("400 when workerId is missing", async () => {
      const res = await POST(postReq({}));
      expect(res.status).toBe(400);
      expect(mockClaim).not.toHaveBeenCalled();
    });

    it("400 when workerId is an empty string", async () => {
      const res = await POST(postReq({ workerId: "   " }));
      expect(res.status).toBe(400);
    });

    it("400 when the body is empty", async () => {
      const res = await POST(postReq(undefined));
      expect(res.status).toBe(400);
      expect(mockClaim).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // TTL resolution — PREVIEW_BOOT_TTL_SECONDS, default 720
  // -------------------------------------------------------------------------
  describe("TTL resolution", () => {
    it("defaults ttlSeconds to 720 when PREVIEW_BOOT_TTL_SECONDS is unset", async () => {
      await POST(postReq({ workerId: "w1" }));
      expect(mockClaim).toHaveBeenCalledWith({ workerId: "w1", ttlSeconds: 720 });
    });

    it("resolves ttlSeconds from PREVIEW_BOOT_TTL_SECONDS when set", async () => {
      process.env[TTL_ENV_KEY] = "300";
      await POST(postReq({ workerId: "w1" }));
      expect(mockClaim).toHaveBeenCalledWith({ workerId: "w1", ttlSeconds: 300 });
    });

    it("falls back to the default when PREVIEW_BOOT_TTL_SECONDS is not a valid number", async () => {
      process.env[TTL_ENV_KEY] = "not-a-number";
      await POST(postReq({ workerId: "w1" }));
      expect(mockClaim).toHaveBeenCalledWith({ workerId: "w1", ttlSeconds: 720 });
    });

    it("falls back to the default when PREVIEW_BOOT_TTL_SECONDS is negative", async () => {
      process.env[TTL_ENV_KEY] = "-5";
      await POST(postReq({ workerId: "w1" }));
      expect(mockClaim).toHaveBeenCalledWith({ workerId: "w1", ttlSeconds: 720 });
    });

    it("echoes the resolved ttlSeconds back in the response on a claimed boot", async () => {
      process.env[TTL_ENV_KEY] = "300";
      mockClaim.mockResolvedValue(CLAIMED_ROW as never);
      const res = await POST(postReq({ workerId: "w1" }));
      const json = await res.json();
      expect(json.ttlSeconds).toBe(300);
    });
  });

  // -------------------------------------------------------------------------
  // no eligible boot -> 204 empty
  // -------------------------------------------------------------------------
  it("204 with an empty body when no eligible boot exists", async () => {
    mockClaim.mockResolvedValue(null as never);
    const res = await POST(postReq({ workerId: "w1" }));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(mockToken).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // claimed -> 200, mints a token, derives repoUrl
  // -------------------------------------------------------------------------
  describe("boot claimed", () => {
    it("200 with the full item shape, minted githubToken, and derived repoUrl", async () => {
      mockClaim.mockResolvedValue(CLAIMED_ROW as never);
      mockToken.mockResolvedValue("ghs_realtoken" as never);

      const res = await POST(postReq({ workerId: "worker-1" }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json).toEqual({
        id: "boot-1",
        workspaceId: "ws-1",
        repo: "ada/widgets",
        repoUrl: "https://github.com/ada/widgets",
        prNumber: 98,
        headSha: "deadbeefcafe",
        ref: "deadbeefcafe",
        githubToken: "ghs_realtoken",
        ttlSeconds: 720,
      });
      expect(mockToken).toHaveBeenCalledWith("ws-1");
    });

    it("passes the caller's own workerId through to claimPreviewBoot", async () => {
      mockClaim.mockResolvedValue(CLAIMED_ROW as never);
      await POST(postReq({ workerId: "worker-xyz" }));
      expect(mockClaim).toHaveBeenCalledWith({ workerId: "worker-xyz", ttlSeconds: 720 });
    });

    it('githubToken is "" (never null/undefined) when getInstallationToken resolves null', async () => {
      mockClaim.mockResolvedValue(CLAIMED_ROW as never);
      mockToken.mockResolvedValue(null as never);
      const res = await POST(postReq({ workerId: "w1" }));
      const json = await res.json();
      expect(json.githubToken).toBe("");
    });

    it("repoUrl passes a full URL through unchanged (not just an owner/name slug)", async () => {
      mockClaim.mockResolvedValue({ ...CLAIMED_ROW, repo: "https://github.com/ada/widgets" } as never);
      const res = await POST(postReq({ workerId: "w1" }));
      const json = await res.json();
      expect(json.repoUrl).toBe("https://github.com/ada/widgets");
    });
  });
});
