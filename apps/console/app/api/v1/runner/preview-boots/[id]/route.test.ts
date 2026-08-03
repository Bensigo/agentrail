import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  getChatIdentityById: vi.fn(),
  getPreviewBoot: vi.fn(),
}));
import { getJaceSessionByEveSessionId, getChatIdentityById, getPreviewBoot } from "@agentrail/db-postgres";

import { GET } from "./route";

const NOW = new Date("2026-08-02T00:00:00.000Z");

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

function getReq(qs: Record<string, string> | null, withAuth = true): NextRequest {
  const url = new URL("http://localhost/api/v1/runner/preview-boots/boot-1");
  if (qs) {
    for (const [k, v] of Object.entries(qs)) url.searchParams.set(k, v);
  }
  return new NextRequest(url, {
    method: "GET",
    headers: withAuth ? { Authorization: `Bearer ${SECRET}` } : {},
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

const PINNED_SESSION = {
  id: "session-1",
  workspaceId: "ws-1",
  chatIdentityId: "chat-identity-1",
  channel: "telegram",
  conversationKey: "tg-chat-42",
  eveSessionId: "eve-session-1",
  status: "active",
  lastActivityAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

const BOUND_IDENTITY = {
  id: "chat-identity-1",
  platform: "telegram",
  platformUserId: "tg-123",
  displayName: "Ada",
  userId: "user-1",
  workspaceId: "ws-1",
  linkToken: null,
  linkTokenExpiresAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const PENDING_ROW = {
  id: "boot-1",
  workspaceId: "ws-1",
  repo: "ada/widgets",
  prNumber: 98,
  headSha: "deadbeefcafe",
  ref: "deadbeefcafe",
  status: "pending",
  workerId: null,
  claimedAt: null,
  url: null,
  port: null,
  reason: null,
  attempts: 0,
  expiresAt: null,
  lastLivenessAt: null,
  nextEligibleAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
  saveEnv(ALL_ENV_KEYS);
  process.env[AUTH_ENV_KEY] = SECRET;
  process.env[FLAG_ENV_KEY] = "1";

  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(PINNED_SESSION as never);
  vi.mocked(getChatIdentityById).mockResolvedValue(BOUND_IDENTITY as never);
  vi.mocked(getPreviewBoot).mockResolvedValue(PENDING_ROW as never);
});

afterEach(() => {
  restoreEnv(ALL_ENV_KEYS);
});

describe("GET /api/v1/runner/preview-boots/[id]", () => {
  // -------------------------------------------------------------------------
  // auth
  // -------------------------------------------------------------------------
  describe("auth (central JACE_CONSOLE_TOKEN secret)", () => {
    it("401 when no Authorization header is sent, and never touches the flag/DB", async () => {
      process.env[FLAG_ENV_KEY] = "0"; // flag OFF too — proves auth wins the race
      const res = await GET(getReq({ eveSessionId: "eve-session-1" }, false), params("boot-1"));
      expect(res.status).toBe(401);
      expect(getPreviewBoot).not.toHaveBeenCalled();
      expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    });

    it("401 when JACE_CONSOLE_TOKEN is unset (fail closed)", async () => {
      delete process.env[AUTH_ENV_KEY];
      const res = await GET(getReq({ eveSessionId: "eve-session-1" }), params("boot-1"));
      expect(res.status).toBe(401);
    });

    it("401 on a wrong secret", async () => {
      const url = new URL("http://localhost/api/v1/runner/preview-boots/boot-1");
      url.searchParams.set("eveSessionId", "eve-session-1");
      const res = await GET(
        new NextRequest(url, { method: "GET", headers: { Authorization: "Bearer wrong-secret" } }),
        params("boot-1")
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
      const res = await GET(getReq({ eveSessionId: "eve-session-1" }), params("boot-1"));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "preview boots not enabled" });
      expect(getPreviewBoot).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // eveSessionId required (400) — before any DB call
  // -------------------------------------------------------------------------
  describe("query validation", () => {
    it("400 when eveSessionId is missing", async () => {
      const res = await GET(getReq(null), params("boot-1"));
      expect(res.status).toBe(400);
      expect(getPreviewBoot).not.toHaveBeenCalled();
      expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    });

    it("400 when eveSessionId is blank", async () => {
      const res = await GET(getReq({ eveSessionId: "   " }), params("boot-1"));
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // absent row -> 404
  // -------------------------------------------------------------------------
  describe("absent row", () => {
    it('404 {error:"boot not found"} when getPreviewBoot returns null', async () => {
      vi.mocked(getPreviewBoot).mockResolvedValue(null as never);
      const res = await GET(getReq({ eveSessionId: "eve-session-1" }), params("unknown-id"));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "boot not found" });
      // Session resolution is skipped once the row itself doesn't exist.
      expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // session resolution
  // -------------------------------------------------------------------------
  describe("session resolution", () => {
    it('404 "Session not found" when no jace_sessions row is bound to eveSessionId', async () => {
      vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null as never);
      const res = await GET(getReq({ eveSessionId: "unknown-session" }), params("boot-1"));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Session not found" });
    });

    it("resolves a workspace-anchored, identity-less session without calling getChatIdentityById", async () => {
      vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
        ...PINNED_SESSION,
        chatIdentityId: null,
      } as never);

      const res = await GET(getReq({ eveSessionId: "eve-session-1" }), params("boot-1"));

      expect(res.status).toBe(200);
      expect(getChatIdentityById).not.toHaveBeenCalled();
    });

    it("409 when neither the session nor the identity has a workspace", async () => {
      vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
        ...PINNED_SESSION,
        workspaceId: null,
      } as never);
      vi.mocked(getChatIdentityById).mockResolvedValue({ ...BOUND_IDENTITY, workspaceId: null } as never);

      const res = await GET(getReq({ eveSessionId: "eve-session-1" }), params("boot-1"));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "this conversation has no workspace yet — create one first",
      });
    });
  });

  // -------------------------------------------------------------------------
  // cross-tenant — hidden as not-found, byte-identical to the absent-row 404
  // -------------------------------------------------------------------------
  describe("cross-tenant scoping", () => {
    it('404 {error:"boot not found"} (same shape as absent) when the row belongs to a different workspace', async () => {
      vi.mocked(getPreviewBoot).mockResolvedValue({ ...PENDING_ROW, workspaceId: "some-other-ws" } as never);
      const res = await GET(getReq({ eveSessionId: "eve-session-1" }), params("boot-1"));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "boot not found" });
    });
  });

  // -------------------------------------------------------------------------
  // happy path — 200 {status, url, reason}
  // -------------------------------------------------------------------------
  describe("happy path", () => {
    it("200 {status, url:null, reason:null} for a pending boot with neither set", async () => {
      const res = await GET(getReq({ eveSessionId: "eve-session-1" }), params("boot-1"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "pending", url: null, reason: null });
    });

    it("200 surfaces a live url on a ready boot", async () => {
      vi.mocked(getPreviewBoot).mockResolvedValue({
        ...PENDING_ROW,
        status: "ready",
        url: "http://127.0.0.1:41234",
        port: 41234,
      } as never);
      const res = await GET(getReq({ eveSessionId: "eve-session-1" }), params("boot-1"));
      expect(await res.json()).toEqual({ status: "ready", url: "http://127.0.0.1:41234", reason: null });
    });

    it("200 surfaces a reason on a failed boot", async () => {
      vi.mocked(getPreviewBoot).mockResolvedValue({
        ...PENDING_ROW,
        status: "failed",
        reason: "stale",
      } as never);
      const res = await GET(getReq({ eveSessionId: "eve-session-1" }), params("boot-1"));
      expect(await res.json()).toEqual({ status: "failed", url: null, reason: "stale" });
    });

    it("never leaks internal fields (workerId, attempts, expiresAt, ...)", async () => {
      const res = await GET(getReq({ eveSessionId: "eve-session-1" }), params("boot-1"));
      const json = await res.json();
      expect(Object.keys(json).sort()).toEqual(["reason", "status", "url"]);
    });
  });
});
