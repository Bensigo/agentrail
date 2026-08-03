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
  bootLogKey: null,
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
    it('404 {error:"boot not found"} when getPreviewBoot returns null (after a successfully-resolved session)', async () => {
      vi.mocked(getPreviewBoot).mockResolvedValue(null as never);
      const res = await GET(getReq({ eveSessionId: "eve-session-1" }), params("unknown-id"));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "boot not found" });
      // Fix round 1 (review Finding 1): session resolution now runs BEFORE
      // the row lookup, so a valid session still resolves even when the row
      // turns out not to exist — this is the opposite of the pre-fix
      // assertion, which pinned the buggy row-first ordering.
      expect(getJaceSessionByEveSessionId).toHaveBeenCalled();
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
      // Fix round 1 (Finding 1): the row must never be looked up once
      // session resolution has already failed — this is what closes the
      // existence oracle (see the dedicated "existence oracle" describe
      // block below).
      expect(getPreviewBoot).not.toHaveBeenCalled();
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
      // Fix round 1 (Finding 1): the 409 branch also short-circuits before
      // the row lookup — the third variant Finding 1 called out (a
      // workspace-less session turning an existing row's 404 into a 409).
      expect(getPreviewBoot).not.toHaveBeenCalled();
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

    // Fix round 1 (review Finding 1, coordinator-requested proof): a
    // resolvable, valid session ("eve-session-1" -> ws-1) must produce a
    // BYTE-IDENTICAL response whether the requested row belongs to a
    // different workspace or doesn't exist at all — neither existence nor
    // ownership is a distinguishable oracle to a valid caller.
    it("[ORACLE] byte-identical 404 for a valid session against a FOREIGN row vs. a NONEXISTENT row", async () => {
      vi.mocked(getPreviewBoot).mockResolvedValueOnce({ ...PENDING_ROW, workspaceId: "some-other-ws" } as never);
      const foreignRes = await GET(getReq({ eveSessionId: "eve-session-1" }), params("boot-1"));
      const foreignBody = await foreignRes.json();

      vi.mocked(getPreviewBoot).mockResolvedValueOnce(null as never);
      const absentRes = await GET(getReq({ eveSessionId: "eve-session-1" }), params("unknown-id"));
      const absentBody = await absentRes.json();

      expect(foreignRes.status).toBe(absentRes.status);
      expect(foreignBody).toEqual(absentBody);
      expect(foreignRes.status).toBe(404);
      expect(foreignBody).toEqual({ error: "boot not found" });
    });

    it("a resolvable, OWNING session still gets the full {status, url, reason} — the fix doesn't over-hide legitimate access", async () => {
      vi.mocked(getPreviewBoot).mockResolvedValue({ ...PENDING_ROW, workspaceId: "ws-1" } as never);
      const res = await GET(getReq({ eveSessionId: "eve-session-1" }), params("boot-1"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "pending",
        url: null,
        reason: null,
        bootLogKey: null,
      });
    });
  });

  // ---------------------------------------------------------------------
  // Fix round 1 — Finding 1 (CRITICAL): cross-tenant EXISTENCE oracle.
  // The bug: the pre-fix route called getPreviewBoot(id) BEFORE resolving
  // the caller's own session, so an UNRESOLVABLE eveSessionId produced a
  // DIFFERENT 404 body depending on whether the row existed
  // ({error:"Session not found"} either way is the FIXED behavior; pre-fix,
  // a nonexistent row short-circuited to {error:"boot not found"} instead,
  // one step earlier, before resolveWorkspaceId ever ran) — a live oracle
  // for row existence that required no proof of tenancy at all, just the
  // shared JACE_CONSOLE_TOKEN. These tests pin the closed behavior: with the
  // session resolved FIRST, the row is never even looked up once session
  // resolution has already failed, so there is nothing left that COULD vary
  // between the two sub-cases below.
  // ---------------------------------------------------------------------
  describe("cross-tenant existence oracle (Fix round 1, Finding 1)", () => {
    it("[ORACLE] an UNRESOLVABLE eveSessionId produces byte-identical output whether the row exists or not", async () => {
      vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null as never); // unresolvable in both sub-cases

      // getPreviewBoot's mocked return value deliberately does NOT vary
      // between the two calls below (unlike the "OWNING session" tests
      // above) — the whole point of this test is that it can't matter,
      // since session resolution now fails before the row is ever looked
      // up. Queuing distinct mockResolvedValueOnce values here would be
      // pointless AND would leave unconsumed queued values that leak into
      // later tests (vi.clearAllMocks() in beforeEach clears call history,
      // not a mock's queued-but-unconsumed return values) — asserting
      // `.not.toHaveBeenCalled()` below is the real proof, not varying what
      // it WOULD have returned.
      const existingRes = await GET(getReq({ eveSessionId: "garbage-session" }), params("boot-1"));
      const existingBody = await existingRes.json();

      const absentRes = await GET(getReq({ eveSessionId: "garbage-session" }), params("unknown-id"));
      const absentBody = await absentRes.json();

      expect(existingRes.status).toBe(absentRes.status);
      expect(existingBody).toEqual(absentBody);
      expect(existingRes.status).toBe(404);
      expect(existingBody).toEqual({ error: "Session not found" });

      // The row is never looked up once session resolution has already
      // failed — this IS why the two sub-cases above can never diverge.
      expect(getPreviewBoot).not.toHaveBeenCalled();
    });

    it("a workspace-less (409) session also short-circuits before the row lookup — the 409-vs-404 variant Finding 1 called out is closed too", async () => {
      vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
        ...PINNED_SESSION,
        workspaceId: null,
      } as never);
      vi.mocked(getChatIdentityById).mockResolvedValue({ ...BOUND_IDENTITY, workspaceId: null } as never);

      // Same reasoning as the test above: getPreviewBoot's return value is
      // irrelevant (and deliberately left unconfigured beyond the beforeEach
      // default) since it must never be called here either.
      const existingRes = await GET(getReq({ eveSessionId: "eve-session-1" }), params("boot-1"));
      const absentRes = await GET(getReq({ eveSessionId: "eve-session-1" }), params("unknown-id"));

      expect(existingRes.status).toBe(409);
      expect(absentRes.status).toBe(409);
      expect(await existingRes.json()).toEqual(await absentRes.json());
      expect(getPreviewBoot).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // happy path — 200 {status, url, reason}
  // -------------------------------------------------------------------------
  describe("happy path", () => {
    it("200 {status, url:null, reason:null} for a pending boot with neither set", async () => {
      const res = await GET(getReq({ eveSessionId: "eve-session-1" }), params("boot-1"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "pending",
        url: null,
        reason: null,
        bootLogKey: null,
      });
    });

    it("200 surfaces a live url on a ready boot", async () => {
      vi.mocked(getPreviewBoot).mockResolvedValue({
        ...PENDING_ROW,
        status: "ready",
        url: "http://127.0.0.1:41234",
        port: 41234,
      } as never);
      const res = await GET(getReq({ eveSessionId: "eve-session-1" }), params("boot-1"));
      expect(await res.json()).toEqual({
        status: "ready",
        url: "http://127.0.0.1:41234",
        reason: null,
        bootLogKey: null,
      });
    });

    it("200 surfaces a reason on a failed boot", async () => {
      vi.mocked(getPreviewBoot).mockResolvedValue({
        ...PENDING_ROW,
        status: "failed",
        reason: "stale",
      } as never);
      const res = await GET(getReq({ eveSessionId: "eve-session-1" }), params("boot-1"));
      expect(await res.json()).toEqual({
        status: "failed",
        url: null,
        reason: "stale",
        bootLogKey: null,
      });
    });

    it("200 surfaces bootLogKey when present", async () => {
      vi.mocked(getPreviewBoot).mockResolvedValue({
        ...PENDING_ROW,
        status: "ready",
        bootLogKey: "review-evidence/ws-1/ada__widgets/98/deadbeefcafe/boot.log",
      } as never);
      const res = await GET(getReq({ eveSessionId: "eve-session-1" }), params("boot-1"));
      expect(await res.json()).toEqual({
        status: "ready",
        url: null,
        reason: null,
        bootLogKey: "review-evidence/ws-1/ada__widgets/98/deadbeefcafe/boot.log",
      });
    });

    it("never leaks internal fields (workerId, attempts, expiresAt, ...)", async () => {
      const res = await GET(getReq({ eveSessionId: "eve-session-1" }), params("boot-1"));
      const json = await res.json();
      expect(Object.keys(json).sort()).toEqual(["bootLogKey", "reason", "status", "url"]);
    });

    // Fix round 1 (review Finding 3, Minor): pending/ready/failed were
    // already covered above; this closes the remaining three status values.
    // Pure passthrough (`status: row.status`, no branching in the route), so
    // this is a coverage pin, not new route logic under test.
    it.each(["claimed", "booting", "torn_down"] as const)(
      "200 passes the '%s' status straight through",
      async (status) => {
        vi.mocked(getPreviewBoot).mockResolvedValue({ ...PENDING_ROW, status } as never);
        const res = await GET(getReq({ eveSessionId: "eve-session-1" }), params("boot-1"));
        expect(res.status).toBe(200);
        expect((await res.json()).status).toBe(status);
      }
    );
  });
});
