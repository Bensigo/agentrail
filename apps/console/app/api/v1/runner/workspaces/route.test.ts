import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  getChatIdentityById: vi.fn(),
  createWorkspace: vi.fn(),
  pinConversationWorkspace: vi.fn(),
  setChatIdentitySignupToken: vi.fn(),
}));

import { POST } from "./route";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  createWorkspace,
  pinConversationWorkspace,
  setChatIdentitySignupToken,
} from "@agentrail/db-postgres";

const NOW = new Date("2026-07-18T00:00:00.000Z");

// Central-secret auth (2026-07-20 fix): the route now authenticates via
// requireJaceConsoleSecret / JACE_CONSOLE_TOKEN instead of a per-workspace
// bearer api_key — this route never used the bearer's own workspaceId for
// anything (see the route's own doc-comment), so this is a pure auth-guard
// swap; every non-auth test below is unchanged. Real helper, real env var,
// real header — same idiom as fleet/workspace-tokens/sync/route.test.ts uses
// for its own shared secret.
const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function req(body?: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/workspaces", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${SECRET}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// An "intro" (workspace-less) session — the common case create_workspace
// exists for: no session-level pin yet.
const INTRO_SESSION = {
  id: "session-1",
  workspaceId: null,
  chatIdentityId: "chat-identity-1",
  channel: "telegram",
  conversationKey: "tg-chat-42",
  eveSessionId: "eve-session-1",
  status: "active",
  lastActivityAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

// Not yet linked to a user — issue #1364 PR②'s sign-up gate now applies.
const UNBOUND_IDENTITY = {
  id: "chat-identity-1",
  platform: "telegram",
  platformUserId: "tg-123",
  displayName: "Ada",
  userId: null,
  workspaceId: null,
  linkToken: null,
  linkTokenExpiresAt: null,
  signupToken: null,
  signupTokenExpiresAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

// Already linked to a user -> the immediately-owned path, unaffected by #1364.
const USER_BOUND_IDENTITY = {
  ...UNBOUND_IDENTITY,
  userId: "user-1",
};

const MOCK_WORKSPACE = {
  id: "ws-new-1",
  name: "Acme Co",
  slug: "acme-co",
  createdAt: NOW,
  updatedAt: NOW,
  baselineWindowDays: 30,
  discordWebhookUrl: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env[ENV_KEY] = SECRET;
  vi.mocked(pinConversationWorkspace).mockResolvedValue({
    ok: true,
    sessionId: "session-1",
  } as never);
  vi.mocked(setChatIdentitySignupToken).mockResolvedValue(undefined as never);
});

afterEach(() => {
  vi.useRealTimers();
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("POST /api/v1/runner/workspaces", () => {
  // ---------------------------------------------------------------------
  // auth
  // ---------------------------------------------------------------------

  it("401 when no Authorization header is sent, and never touches session/identity/create/pin", async () => {
    const res = await POST(req({ eveSessionId: "eve-session-1", name: "Acme" }, false));

    expect(res.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    expect(getChatIdentityById).not.toHaveBeenCalled();
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(pinConversationWorkspace).not.toHaveBeenCalled();
  });

  it("401 when JACE_CONSOLE_TOKEN is unset (fail closed, never 'open') — even the objectively correct secret is rejected", async () => {
    delete process.env[ENV_KEY];

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "Acme" }, true));

    expect(res.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("401 on a wrong secret", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/v1/runner/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer wrong-secret" },
        body: JSON.stringify({ eveSessionId: "eve-session-1", name: "Acme" }),
      })
    );

    expect(res.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // body / name validation (400) — cheap checks, before any DB call
  // ---------------------------------------------------------------------

  it("400 when the request body is invalid JSON", async () => {
    const request = new NextRequest("http://localhost/api/v1/runner/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${SECRET}` },
      body: "{not valid json",
    });

    const res = await POST(request);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON" });
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when eveSessionId is missing", async () => {
    const res = await POST(req({ name: "Acme" }));
    expect(res.status).toBe(400);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when eveSessionId is present but empty", async () => {
    const res = await POST(req({ eveSessionId: "", name: "Acme" }));
    expect(res.status).toBe(400);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when name is missing", async () => {
    const res = await POST(req({ eveSessionId: "eve-session-1" }));
    expect(res.status).toBe(400);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when name is empty after trimming (whitespace-only)", async () => {
    const res = await POST(req({ eveSessionId: "eve-session-1", name: "   " }));
    expect(res.status).toBe(400);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when name exceeds 80 characters", async () => {
    const res = await POST(req({ eveSessionId: "eve-session-1", name: "x".repeat(81) }));
    expect(res.status).toBe(400);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("accepts a name at exactly the 80-character boundary (no DB-call assertion needed, just no 400) — user-bound path", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(INTRO_SESSION as never);
    vi.mocked(getChatIdentityById).mockResolvedValue(USER_BOUND_IDENTITY as never);
    vi.mocked(createWorkspace).mockResolvedValue(MOCK_WORKSPACE as never);

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "x".repeat(80) }));

    expect(res.status).toBe(201);
  });

  // ---------------------------------------------------------------------
  // resolution (404) — same indistinguishable posture as connect-link
  // ---------------------------------------------------------------------

  it("404 when no jace_sessions row is bound to this eveSessionId", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null as never);

    const res = await POST(req({ eveSessionId: "unknown-eve-session", name: "Acme" }));

    expect(res.status).toBe(404);
    expect(getJaceSessionByEveSessionId).toHaveBeenCalledWith("unknown-eve-session");
    expect(getChatIdentityById).not.toHaveBeenCalled();
  });

  it("404 when the ledgered session has a null chat_identity_id — byte-identical to the unknown-session 404", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
      ...INTRO_SESSION,
      chatIdentityId: null,
    } as never);

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "Acme" }));
    const text = await res.text();

    expect(res.status).toBe(404);
    expect(getChatIdentityById).not.toHaveBeenCalled();

    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null as never);
    const unknownRes = await POST(req({ eveSessionId: "unknown-eve-session", name: "Acme" }));
    expect(await unknownRes.text()).toBe(text);
  });

  it("resolves via the session chain with exact arguments: getJaceSessionByEveSessionId(eveSessionId) then getChatIdentityById(session.chatIdentityId)", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(INTRO_SESSION as never);
    vi.mocked(getChatIdentityById).mockResolvedValue(USER_BOUND_IDENTITY as never);
    vi.mocked(createWorkspace).mockResolvedValue(MOCK_WORKSPACE as never);

    await POST(req({ eveSessionId: "eve-session-1", name: "Acme Co" }));

    expect(getJaceSessionByEveSessionId).toHaveBeenCalledWith("eve-session-1");
    expect(getChatIdentityById).toHaveBeenCalledWith("chat-identity-1");
  });

  // ---------------------------------------------------------------------
  // refusals (409) — honest, distinct from the 404s above
  // ---------------------------------------------------------------------

  it("409 when the SESSION already has a workspace — this conversation is already attached", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
      ...INTRO_SESSION,
      workspaceId: "ws-existing",
    } as never);
    vi.mocked(getChatIdentityById).mockResolvedValue(USER_BOUND_IDENTITY as never);

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "Acme" }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "this conversation is already attached to a workspace",
    });
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(pinConversationWorkspace).not.toHaveBeenCalled();
  });

  it("409 when the IDENTITY already has a workspace (session itself has none) — same refusal class", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(INTRO_SESSION as never);
    vi.mocked(getChatIdentityById).mockResolvedValue({
      ...USER_BOUND_IDENTITY,
      workspaceId: "ws-existing",
    } as never);

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "Acme" }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "this conversation is already attached to a workspace",
    });
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(pinConversationWorkspace).not.toHaveBeenCalled();
  });

  it("the already-attached check runs BEFORE the sign-up gate: an unbound identity with an existing workspaceId gets the already-attached 409, not a signup link", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(INTRO_SESSION as never);
    vi.mocked(getChatIdentityById).mockResolvedValue({
      ...UNBOUND_IDENTITY,
      workspaceId: "ws-existing-owner-elect",
    } as never);

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "Acme" }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "this conversation is already attached to a workspace",
    });
    expect(setChatIdentitySignupToken).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // issue #1364 PR②: sign-up gate for an UNBOUND sender (AC1 wire-in)
  // ---------------------------------------------------------------------

  describe("sign-up gate (AC1: unbound sender triggers the link instead of creating a workspace)", () => {
    it("409 with a signupUrl + expiresAt instead of creating anything; createWorkspace and pinConversationWorkspace are never called", async () => {
      vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(INTRO_SESSION as never);
      vi.mocked(getChatIdentityById).mockResolvedValue(UNBOUND_IDENTITY as never);

      const res = await POST(req({ eveSessionId: "eve-session-1", name: "Acme Co" }));

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe("sign up to create a workspace");
      expect(body.signupUrl).toMatch(/^http:\/\/localhost\/signup\/[0-9a-f]{32,}$/);
      expect(body.expiresAt).toBe(new Date(NOW.getTime() + 30 * 60 * 1000).toISOString());
      expect(createWorkspace).not.toHaveBeenCalled();
      expect(pinConversationWorkspace).not.toHaveBeenCalled();
    });

    it("mints the signup token for the resolved chat identity's own id, with a 30-minute expiry", async () => {
      vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(INTRO_SESSION as never);
      vi.mocked(getChatIdentityById).mockResolvedValue(UNBOUND_IDENTITY as never);

      const res = await POST(req({ eveSessionId: "eve-session-1", name: "Acme Co" }));
      const body = await res.json();
      const token = body.signupUrl.split("/signup/")[1];

      expect(setChatIdentitySignupToken).toHaveBeenCalledWith(
        "chat-identity-1",
        token,
        new Date(NOW.getTime() + 30 * 60 * 1000)
      );
    });

    it("mints a fresh signup link on every call for a still-unbound identity (never caches/reuses)", async () => {
      vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(INTRO_SESSION as never);
      vi.mocked(getChatIdentityById).mockResolvedValue(UNBOUND_IDENTITY as never);

      const res1 = await POST(req({ eveSessionId: "eve-session-1", name: "Acme Co" }));
      const res2 = await POST(req({ eveSessionId: "eve-session-1", name: "Acme Co" }));
      const token1 = (await res1.json()).signupUrl.split("/signup/")[1];
      const token2 = (await res2.json()).signupUrl.split("/signup/")[1];

      expect(token1).not.toBe(token2);
    });

    it("AC2: an already-known (user-bound) sender is completely unaffected — no signup mint attempted at all", async () => {
      vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(INTRO_SESSION as never);
      vi.mocked(getChatIdentityById).mockResolvedValue(USER_BOUND_IDENTITY as never);
      vi.mocked(createWorkspace).mockResolvedValue(MOCK_WORKSPACE as never);

      const res = await POST(req({ eveSessionId: "eve-session-1", name: "Acme Co" }));

      expect(res.status).toBe(201);
      expect(setChatIdentitySignupToken).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // creation (user-bound path only — the sole remaining creation branch)
  // ---------------------------------------------------------------------

  it("creates the OWNED workspace with exact args: {name, slug, userId}", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(INTRO_SESSION as never);
    vi.mocked(getChatIdentityById).mockResolvedValue(USER_BOUND_IDENTITY as never);
    vi.mocked(createWorkspace).mockResolvedValue(MOCK_WORKSPACE as never);

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "Acme Co" }));

    expect(res.status).toBe(201);
    expect(createWorkspace).toHaveBeenCalledWith({
      name: "Acme Co",
      slug: "acme-co",
      userId: "user-1",
    });
  });

  it("pins the conversation to the new workspace with exact args", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(INTRO_SESSION as never);
    vi.mocked(getChatIdentityById).mockResolvedValue(USER_BOUND_IDENTITY as never);
    vi.mocked(createWorkspace).mockResolvedValue(MOCK_WORKSPACE as never);

    await POST(req({ eveSessionId: "eve-session-1", name: "Acme Co" }));

    expect(pinConversationWorkspace).toHaveBeenCalledWith({
      chatIdentityId: "chat-identity-1",
      channel: "telegram",
      conversationKey: "tg-chat-42",
      workspaceId: "ws-new-1",
    });
  });

  // ---------------------------------------------------------------------
  // slug derivation + collision retry
  // ---------------------------------------------------------------------

  it("derives the slug from name: lowercase, hyphenated, non-alnum stripped", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(INTRO_SESSION as never);
    vi.mocked(getChatIdentityById).mockResolvedValue(USER_BOUND_IDENTITY as never);
    vi.mocked(createWorkspace).mockResolvedValue(MOCK_WORKSPACE as never);

    await POST(req({ eveSessionId: "eve-session-1", name: "  Ada's Café & Co!!  " }));

    const call = vi.mocked(createWorkspace).mock.calls[0]![0];
    expect(call.slug).toMatch(/^[a-z0-9-]+$/);
    expect(call.slug).not.toMatch(/^-|-$/);
  });

  it("on a slug collision, retries ONCE with a random suffix and succeeds on the retry", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(INTRO_SESSION as never);
    vi.mocked(getChatIdentityById).mockResolvedValue(USER_BOUND_IDENTITY as never);
    const conflict = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
    });
    vi.mocked(createWorkspace)
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(MOCK_WORKSPACE as never);

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "Acme Co" }));

    expect(res.status).toBe(201);
    expect(createWorkspace).toHaveBeenCalledTimes(2);
    const firstSlug = vi.mocked(createWorkspace).mock.calls[0]![0].slug;
    const secondSlug = vi.mocked(createWorkspace).mock.calls[1]![0].slug;
    expect(firstSlug).toBe("acme-co");
    expect(secondSlug).toMatch(/^acme-co-[0-9a-f]+$/);
    expect(secondSlug).not.toBe(firstSlug);
  });

  it("falls back to a generated 'workspace-<hex>' slug when a non-Latin name slugifies to empty (Chinese)", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(INTRO_SESSION as never);
    vi.mocked(getChatIdentityById).mockResolvedValue(USER_BOUND_IDENTITY as never);
    vi.mocked(createWorkspace).mockResolvedValue(MOCK_WORKSPACE as never);

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "你好世界" }));

    expect(res.status).toBe(201);
    const call = vi.mocked(createWorkspace).mock.calls[0]![0];
    expect(call.slug).toMatch(/^workspace-[0-9a-f]{6}$/);
    expect(call.name).toBe("你好世界");
  });

  it("falls back to a generated slug when a punctuation-only name slugifies to empty", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(INTRO_SESSION as never);
    vi.mocked(getChatIdentityById).mockResolvedValue(USER_BOUND_IDENTITY as never);
    vi.mocked(createWorkspace).mockResolvedValue(MOCK_WORKSPACE as never);

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "!!! ??? ---" }));

    expect(res.status).toBe(201);
    const call = vi.mocked(createWorkspace).mock.calls[0]![0];
    expect(call.slug).toMatch(/^workspace-[0-9a-f]{6}$/);
    expect(call.name).toBe("!!! ??? ---");
  });

  it("two different non-Latin names both succeed with different fallback slugs, never a 409", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(INTRO_SESSION as never);
    vi.mocked(getChatIdentityById).mockResolvedValue(USER_BOUND_IDENTITY as never);
    vi.mocked(createWorkspace).mockResolvedValue(MOCK_WORKSPACE as never);

    const res1 = await POST(req({ eveSessionId: "eve-session-1", name: "你好世界" }));
    const res2 = await POST(req({ eveSessionId: "eve-session-1", name: "Здравствуй" }));

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    const slug1 = vi.mocked(createWorkspace).mock.calls[0]![0].slug;
    const slug2 = vi.mocked(createWorkspace).mock.calls[1]![0].slug;
    expect(slug1).toMatch(/^workspace-[0-9a-f]{6}$/);
    expect(slug2).toMatch(/^workspace-[0-9a-f]{6}$/);
    expect(slug1).not.toBe(slug2);
  });

  it("recognizes a unique-violation nested under err.cause.code (drizzle's wrapping shape), not just err.code", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(INTRO_SESSION as never);
    vi.mocked(getChatIdentityById).mockResolvedValue(USER_BOUND_IDENTITY as never);
    const conflict = Object.assign(new Error("duplicate key"), {
      cause: { code: "23505" },
    });
    vi.mocked(createWorkspace)
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(MOCK_WORKSPACE as never);

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "Acme Co" }));

    expect(res.status).toBe(201);
    expect(createWorkspace).toHaveBeenCalledTimes(2);
  });

  it("409 (honest, not 500) when BOTH the original slug and the retry collide", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(INTRO_SESSION as never);
    vi.mocked(getChatIdentityById).mockResolvedValue(USER_BOUND_IDENTITY as never);
    const conflict = Object.assign(new Error("duplicate key"), { code: "23505" });
    vi.mocked(createWorkspace).mockRejectedValue(conflict);

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "Acme Co" }));

    expect(res.status).toBe(409);
    expect(createWorkspace).toHaveBeenCalledTimes(2);
    expect(pinConversationWorkspace).not.toHaveBeenCalled();
  });

  it("propagates a non-unique-violation creation error rather than treating it as a slug collision", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(INTRO_SESSION as never);
    vi.mocked(getChatIdentityById).mockResolvedValue(USER_BOUND_IDENTITY as never);
    const dbDown = new Error("connection terminated unexpectedly");
    vi.mocked(createWorkspace).mockRejectedValue(dbDown);

    await expect(
      POST(req({ eveSessionId: "eve-session-1", name: "Acme Co" }))
    ).rejects.toThrow(/connection terminated/);
    expect(createWorkspace).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------
  // pin refusal — should be impossible; fail loudly rather than 201 a lie
  // ---------------------------------------------------------------------

  it("throws rather than returning 201 when pinConversationWorkspace unexpectedly refuses", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(INTRO_SESSION as never);
    vi.mocked(getChatIdentityById).mockResolvedValue(USER_BOUND_IDENTITY as never);
    vi.mocked(createWorkspace).mockResolvedValue(MOCK_WORKSPACE as never);
    vi.mocked(pinConversationWorkspace).mockResolvedValue({
      ok: false,
      reason: "not_reachable",
    } as never);

    await expect(
      POST(req({ eveSessionId: "eve-session-1", name: "Acme Co" }))
    ).rejects.toThrow(/pinConversationWorkspace refused/);
  });

  // ---------------------------------------------------------------------
  // success shape
  // ---------------------------------------------------------------------

  it("201 with { workspaceId, name, slug, url } — url built from the request origin", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(INTRO_SESSION as never);
    vi.mocked(getChatIdentityById).mockResolvedValue(USER_BOUND_IDENTITY as never);
    vi.mocked(createWorkspace).mockResolvedValue(MOCK_WORKSPACE as never);

    const res = await POST(req({ eveSessionId: "eve-session-1", name: "Acme Co" }));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      workspaceId: "ws-new-1",
      name: "Acme Co",
      slug: "acme-co",
      url: "http://localhost/dashboard/ws-new-1",
    });
  });
});
