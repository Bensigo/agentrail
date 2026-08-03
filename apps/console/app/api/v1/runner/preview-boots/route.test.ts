import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  getChatIdentityById: vi.fn(),
  getRepositoryByName: vi.fn(),
  enqueuePreviewBoot: vi.fn(),
}));
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  getRepositoryByName,
  enqueuePreviewBoot,
} from "@agentrail/db-postgres";

import { POST } from "./route";

const NOW = new Date("2026-08-02T00:00:00.000Z");

// Central-secret auth — same idiom as review-evidence/route.test.ts.
const AUTH_ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const FLAG_ENV_KEY = "PREVIEW_BOOTS_ENABLED";
const WORKSPACES_ENV_KEY = "PREVIEW_BOOTS_WORKSPACES";

const ORIGINAL_ENV: Record<string, string | undefined> = {};
const ALL_ENV_KEYS = [AUTH_ENV_KEY, FLAG_ENV_KEY, WORKSPACES_ENV_KEY] as const;

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
  return new NextRequest("http://localhost/api/v1/runner/preview-boots", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${SECRET}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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

const CONNECTED_REPO = {
  id: "repo-1",
  workspaceId: "ws-1",
  name: "ada/widgets",
  url: "https://github.com/ada/widgets",
  defaultBranch: "main",
  createdAt: NOW,
  updatedAt: NOW,
};

const VALID_BODY = {
  eveSessionId: "eve-session-1",
  repo: "ada/widgets",
  prNumber: 98,
  headSha: "deadbeefcafe",
};

beforeEach(() => {
  vi.clearAllMocks();
  saveEnv(ALL_ENV_KEYS);
  process.env[AUTH_ENV_KEY] = SECRET;
  process.env[FLAG_ENV_KEY] = "1";
  process.env[WORKSPACES_ENV_KEY] = "ws-1";

  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(PINNED_SESSION as never);
  vi.mocked(getChatIdentityById).mockResolvedValue(BOUND_IDENTITY as never);
  vi.mocked(getRepositoryByName).mockResolvedValue(CONNECTED_REPO as never);
  vi.mocked(enqueuePreviewBoot).mockResolvedValue({
    id: "boot-1",
    deduped: false,
    superseded: 0,
  } as never);
});

afterEach(() => {
  restoreEnv(ALL_ENV_KEYS);
});

describe("POST /api/v1/runner/preview-boots", () => {
  // -------------------------------------------------------------------------
  // auth — checked first, before the flag, before anything else
  // -------------------------------------------------------------------------
  describe("auth (central JACE_CONSOLE_TOKEN secret)", () => {
    it("401 when no Authorization header is sent, and never touches the flag/session/enqueue", async () => {
      process.env[FLAG_ENV_KEY] = "0"; // flag OFF too — proves auth wins the race
      const res = await POST(postReq(VALID_BODY, false));
      expect(res.status).toBe(401);
      expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
      expect(enqueuePreviewBoot).not.toHaveBeenCalled();
    });

    it("401 when JACE_CONSOLE_TOKEN is unset (fail closed)", async () => {
      delete process.env[AUTH_ENV_KEY];
      const res = await POST(postReq(VALID_BODY));
      expect(res.status).toBe(401);
    });

    it("401 on a wrong secret", async () => {
      const res = await POST(
        new NextRequest("http://localhost/api/v1/runner/preview-boots", {
          method: "POST",
          headers: { "content-type": "application/json", Authorization: "Bearer wrong-secret" },
          body: JSON.stringify(VALID_BODY),
        })
      );
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // flag — checked AFTER auth
  // -------------------------------------------------------------------------
  describe("flag (PREVIEW_BOOTS_ENABLED)", () => {
    it('503 {error:"preview boots not enabled"} when PREVIEW_BOOTS_ENABLED is unset', async () => {
      delete process.env[FLAG_ENV_KEY];
      const res = await POST(postReq(VALID_BODY));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "preview boots not enabled" });
      expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    });

    it('503 when PREVIEW_BOOTS_ENABLED is set to something other than "1"', async () => {
      process.env[FLAG_ENV_KEY] = "true";
      const res = await POST(postReq(VALID_BODY));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "preview boots not enabled" });
    });
  });

  // -------------------------------------------------------------------------
  // body validation (400) — before any DB call
  // -------------------------------------------------------------------------
  describe("body validation", () => {
    it("400 on invalid JSON", async () => {
      const res = await POST(
        new NextRequest("http://localhost/api/v1/runner/preview-boots", {
          method: "POST",
          headers: { "content-type": "application/json", Authorization: `Bearer ${SECRET}` },
          body: "{not valid json",
        })
      );
      expect(res.status).toBe(400);
      expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    });

    it("400 when any required field is missing", async () => {
      for (const field of ["eveSessionId", "repo", "prNumber", "headSha"] as const) {
        const bad = { ...VALID_BODY };
        delete (bad as Record<string, unknown>)[field];
        const res = await POST(postReq(bad));
        expect(res.status, `field ${field} missing should 400`).toBe(400);
      }
      expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    });

    it("400 when a string field is empty/blank", async () => {
      for (const field of ["eveSessionId", "repo", "headSha"] as const) {
        const res = await POST(postReq({ ...VALID_BODY, [field]: "   " }));
        expect(res.status, `blank ${field} should 400`).toBe(400);
      }
    });

    it("400 when prNumber is zero, negative, or non-integer", async () => {
      for (const prNumber of [0, -1, 1.5]) {
        const res = await POST(postReq({ ...VALID_BODY, prNumber }));
        expect(res.status).toBe(400);
      }
    });

    it("400 when prNumber is not a number at all (wrong type)", async () => {
      for (const prNumber of ["98", null, true, {}]) {
        const res = await POST(postReq({ ...VALID_BODY, prNumber }));
        expect(res.status, `prNumber=${JSON.stringify(prNumber)} should 400`).toBe(400);
      }
    });
  });

  // -------------------------------------------------------------------------
  // session chain resolution
  // -------------------------------------------------------------------------
  describe("session resolution", () => {
    it('404 "Session not found" when no jace_sessions row is bound to this eveSessionId', async () => {
      vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null as never);
      const res = await POST(postReq(VALID_BODY));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Session not found" });
    });

    it("resolves a workspace-anchored, identity-less session (Arc B review-job worker) and reaches the happy path without calling getChatIdentityById", async () => {
      vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
        ...PINNED_SESSION,
        chatIdentityId: null,
      } as never);

      const res = await POST(postReq(VALID_BODY));

      expect(res.status).toBe(200);
      expect(getChatIdentityById).not.toHaveBeenCalled();
    });

    it("409 when neither the session nor the identity has a workspace", async () => {
      vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
        ...PINNED_SESSION,
        workspaceId: null,
      } as never);
      vi.mocked(getChatIdentityById).mockResolvedValue({ ...BOUND_IDENTITY, workspaceId: null } as never);

      const res = await POST(postReq(VALID_BODY));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "this conversation has no workspace yet — create one first",
      });
      expect(enqueuePreviewBoot).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // enrollment (403) — checked AFTER session resolution, BEFORE repo gate
  // -------------------------------------------------------------------------
  describe("enrollment (PREVIEW_BOOTS_WORKSPACES)", () => {
    it('403 {error:"workspace not enrolled"} when the resolved workspace is not in the allowlist', async () => {
      process.env[WORKSPACES_ENV_KEY] = "some-other-ws";
      const res = await POST(postReq(VALID_BODY));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "workspace not enrolled" });
      expect(getRepositoryByName).not.toHaveBeenCalled();
      expect(enqueuePreviewBoot).not.toHaveBeenCalled();
    });

    it("403 when PREVIEW_BOOTS_WORKSPACES is unset (empty allowlist disables every workspace)", async () => {
      delete process.env[WORKSPACES_ENV_KEY];
      const res = await POST(postReq(VALID_BODY));
      expect(res.status).toBe(403);
    });

    it("admits a workspace present among several comma-separated entries", async () => {
      process.env[WORKSPACES_ENV_KEY] = "ws-other, ws-1 ,ws-third";
      const res = await POST(postReq(VALID_BODY));
      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // repo gate (404) — never proxies an unconnected repo
  // -------------------------------------------------------------------------
  describe("repo gate", () => {
    it('404 "repo not connected to this workspace" when the repo is not connected', async () => {
      vi.mocked(getRepositoryByName).mockResolvedValue(null as never);
      const res = await POST(postReq(VALID_BODY));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "repo not connected to this workspace" });
      expect(getRepositoryByName).toHaveBeenCalledWith("ws-1", "ada/widgets");
      expect(enqueuePreviewBoot).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // happy path — enqueuePreviewBoot -> 200 {id, deduped}
  // -------------------------------------------------------------------------
  describe("happy path", () => {
    it("200 {id, deduped}: calls enqueuePreviewBoot with ref=headSha and returns only id+deduped", async () => {
      vi.mocked(enqueuePreviewBoot).mockResolvedValue({
        id: "boot-xyz",
        deduped: false,
        superseded: 2,
      } as never);

      const res = await POST(postReq(VALID_BODY));
      const json = await res.json();

      expect(res.status).toBe(200);
      // Narrower than enqueuePreviewBoot's own return shape — `superseded`
      // must never leak through.
      expect(json).toEqual({ id: "boot-xyz", deduped: false });

      expect(enqueuePreviewBoot).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        repo: "ada/widgets",
        prNumber: 98,
        headSha: "deadbeefcafe",
        ref: "deadbeefcafe",
      });
    });

    it("surfaces deduped:true as-is on a replayed request", async () => {
      vi.mocked(enqueuePreviewBoot).mockResolvedValue({
        id: "boot-xyz",
        deduped: true,
        superseded: 0,
      } as never);

      const res = await POST(postReq(VALID_BODY));
      expect(await res.json()).toEqual({ id: "boot-xyz", deduped: true });
    });
  });
});
