import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  getChatIdentityById: vi.fn(),
  setChatIdentityLinkToken: vi.fn(),
}));

import { POST } from "./route";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  setChatIdentityLinkToken,
} from "@agentrail/db-postgres";

const NOW = new Date("2026-07-18T00:00:00.000Z");

// Central-secret auth (2026-07-20 fix): the route now authenticates via
// requireJaceConsoleSecret / JACE_CONSOLE_TOKEN instead of a per-workspace
// bearer api_key. Real helper, real env var, real header — same idiom as
// fleet/workspace-tokens/sync/route.test.ts uses for its own shared secret.
const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function req(body?: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/connect-link", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${SECRET}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const MOCK_SESSION_ROW = {
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env[ENV_KEY] = SECRET;
  vi.mocked(setChatIdentityLinkToken).mockResolvedValue(undefined as never);
});

afterEach(() => {
  vi.useRealTimers();
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("POST /api/v1/runner/connect-link", () => {
  it("401 when no Authorization header is sent, and never touches session/identity lookups", async () => {
    const res = await POST(req({ eveSessionId: "eve-session-1" }, false));

    expect(res.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    expect(getChatIdentityById).not.toHaveBeenCalled();
    expect(setChatIdentityLinkToken).not.toHaveBeenCalled();
  });

  it("401 when JACE_CONSOLE_TOKEN is unset (fail closed, never 'open') — even the objectively correct secret is rejected", async () => {
    delete process.env[ENV_KEY];

    const res = await POST(req({ eveSessionId: "eve-session-1" }, true));

    expect(res.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("401 on a wrong secret", async () => {
    const request = new NextRequest("http://localhost/api/v1/runner/connect-link", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer wrong-secret" },
      body: JSON.stringify({ eveSessionId: "eve-session-1" }),
    });

    const res = await POST(request);

    expect(res.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when the body is missing eveSessionId", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when eveSessionId is present but empty", async () => {
    const res = await POST(req({ eveSessionId: "" }));
    expect(res.status).toBe(400);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when the request body is invalid JSON", async () => {
    const request = new NextRequest("http://localhost/api/v1/runner/connect-link", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${SECRET}`,
      },
      body: "{not valid json",
    });

    const res = await POST(request);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON" });
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("404 when no jace_sessions row is bound to this eveSessionId — mints only for a ledgered conversation", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null as never);

    const res = await POST(req({ eveSessionId: "unknown-eve-session" }));

    expect(res.status).toBe(404);
    expect(getJaceSessionByEveSessionId).toHaveBeenCalledWith("unknown-eve-session");
    expect(getChatIdentityById).not.toHaveBeenCalled();
    expect(setChatIdentityLinkToken).not.toHaveBeenCalled();
  });

  it("404 when the ledgered session row has a null chat_identity_id — same indistinguishable 404, no identity lookup attempted", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
      ...MOCK_SESSION_ROW,
      chatIdentityId: null,
    } as never);

    const res = await POST(req({ eveSessionId: "eve-session-1" }));
    const text = await res.text();

    expect(res.status).toBe(404);
    expect(getChatIdentityById).not.toHaveBeenCalled();
    expect(setChatIdentityLinkToken).not.toHaveBeenCalled();

    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null as never);
    const unknownRes = await POST(req({ eveSessionId: "unknown-eve-session" }));
    expect(await unknownRes.text()).toBe(text);
  });

  it("404 when the resolved chat identity is already linked to a user — refuses to re-mint/hijack, body byte-identical to the unknown-session 404", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(
      MOCK_SESSION_ROW as never
    );
    vi.mocked(getChatIdentityById).mockResolvedValue({
      id: "chat-identity-1",
      platform: "telegram",
      platformUserId: "tg-123",
      displayName: "Ada",
      userId: "user-already-linked",
      workspaceId: null,
      linkToken: null,
      linkTokenExpiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as never);

    const res = await POST(req({ eveSessionId: "eve-session-1" }));
    const text = await res.text();

    expect(res.status).toBe(404);
    expect(getChatIdentityById).toHaveBeenCalledWith("chat-identity-1");
    expect(setChatIdentityLinkToken).not.toHaveBeenCalled();
    expect(JSON.parse(text)).toEqual({ error: "Chat identity not found" });

    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null as never);
    const unknownRes = await POST(req({ eveSessionId: "unknown-eve-session" }));
    expect(await unknownRes.text()).toBe(text);
  });

  it("BEHAVIOR CHANGE (accepted, central-secret model — see route doc-comment): the resolved chat identity's workspace_id no longer needs to match anything — there is no bearer-own workspace left to cross-check against (JACE_CONSOLE_TOKEN is ONE shared secret for the whole deployment). An identity already resolved to SOME workspace now mints successfully (200), where the old per-workspace-bearer model would have refused a mismatch (404).", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(
      MOCK_SESSION_ROW as never
    );
    vi.mocked(getChatIdentityById).mockResolvedValue({
      id: "chat-identity-1",
      platform: "telegram",
      platformUserId: "tg-123",
      displayName: "Ada",
      userId: null,
      workspaceId: "ws-some-other-tenant",
      linkToken: null,
      linkTokenExpiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as never);

    const res = await POST(req({ eveSessionId: "eve-session-1" }));

    expect(res.status).toBe(200);
    expect(setChatIdentityLinkToken).toHaveBeenCalledWith(
      "chat-identity-1",
      expect.any(String),
      expect.any(Date)
    );
  });

  it("BEHAVIOR CHANGE (accepted, central-secret model — see route doc-comment): the ledgered session row's workspace_id no longer needs to match anything either, same reasoning as the identity-side case above. Mints successfully (200) where the old per-workspace-bearer model would have refused it (404).", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
      ...MOCK_SESSION_ROW,
      workspaceId: "ws-other",
    } as never);
    vi.mocked(getChatIdentityById).mockResolvedValue({
      id: "chat-identity-1",
      platform: "telegram",
      platformUserId: "tg-123",
      displayName: "Ada",
      userId: null,
      workspaceId: null,
      linkToken: null,
      linkTokenExpiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as never);

    const res = await POST(req({ eveSessionId: "eve-session-1" }));

    expect(res.status).toBe(200);
    expect(setChatIdentityLinkToken).toHaveBeenCalledWith(
      "chat-identity-1",
      expect.any(String),
      expect.any(Date)
    );
  });

  it("200: mints for the common case — a normal resolved-workspace session", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
      ...MOCK_SESSION_ROW,
      workspaceId: "ws-1",
    } as never);
    vi.mocked(getChatIdentityById).mockResolvedValue({
      id: "chat-identity-1",
      platform: "telegram",
      platformUserId: "tg-123",
      displayName: "Ada",
      userId: null,
      workspaceId: null,
      linkToken: null,
      linkTokenExpiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as never);

    const res = await POST(req({ eveSessionId: "eve-session-1" }));

    expect(res.status).toBe(200);
    expect(setChatIdentityLinkToken).toHaveBeenCalledWith(
      "chat-identity-1",
      expect.any(String),
      expect.any(Date)
    );
  });

  it("200: mints for the common case — a normal resolved-workspace identity, not yet user-linked", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(
      MOCK_SESSION_ROW as never
    );
    vi.mocked(getChatIdentityById).mockResolvedValue({
      id: "chat-identity-1",
      platform: "telegram",
      platformUserId: "tg-123",
      displayName: "Ada",
      userId: null,
      workspaceId: "ws-1",
      linkToken: null,
      linkTokenExpiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as never);

    const res = await POST(req({ eveSessionId: "eve-session-1" }));

    expect(res.status).toBe(200);
    expect(setChatIdentityLinkToken).toHaveBeenCalledWith(
      "chat-identity-1",
      expect.any(String),
      expect.any(Date)
    );
  });

  it("200: mints when the identity has no workspace_id yet (intro identity, cold-start flow) regardless of which bearer asks", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(
      MOCK_SESSION_ROW as never
    );
    vi.mocked(getChatIdentityById).mockResolvedValue({
      id: "chat-identity-1",
      platform: "telegram",
      platformUserId: "tg-123",
      displayName: "Ada",
      userId: null,
      workspaceId: null,
      linkToken: null,
      linkTokenExpiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as never);

    const res = await POST(req({ eveSessionId: "eve-session-1" }));

    expect(res.status).toBe(200);
  });

  it("resolves the identity via the session chain with exact arguments: getJaceSessionByEveSessionId(eveSessionId) then getChatIdentityById(session.chatIdentityId)", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(
      MOCK_SESSION_ROW as never
    );
    vi.mocked(getChatIdentityById).mockResolvedValue({
      id: "chat-identity-1",
      platform: "telegram",
      platformUserId: "tg-123",
      displayName: "Ada",
      userId: null,
      workspaceId: null,
      linkToken: null,
      linkTokenExpiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as never);

    await POST(req({ eveSessionId: "eve-session-1" }));

    expect(getJaceSessionByEveSessionId).toHaveBeenCalledWith("eve-session-1");
    expect(getChatIdentityById).toHaveBeenCalledWith("chat-identity-1");
  });

  it("200: mints a 32+ hex char token, stores it with a 30-minute expiry, and returns the connect URL built from the request origin", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(
      MOCK_SESSION_ROW as never
    );
    vi.mocked(getChatIdentityById).mockResolvedValue({
      id: "chat-identity-1",
      platform: "telegram",
      platformUserId: "tg-123",
      displayName: "Ada",
      userId: null,
      workspaceId: null,
      linkToken: null,
      linkTokenExpiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as never);

    const res = await POST(req({ eveSessionId: "eve-session-1" }));

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.url).toMatch(/^http:\/\/localhost\/connect\/[0-9a-f]{32,}$/);
    const token = body.url.split("/connect/")[1];

    expect(body.expiresAt).toBe(new Date(NOW.getTime() + 30 * 60 * 1000).toISOString());

    expect(setChatIdentityLinkToken).toHaveBeenCalledWith(
      "chat-identity-1",
      token,
      new Date(NOW.getTime() + 30 * 60 * 1000)
    );
  });

  it("mints a fresh token on every call, even for an identity that already has an unexpired one (last-write-wins re-mint)", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(
      MOCK_SESSION_ROW as never
    );
    vi.mocked(getChatIdentityById).mockResolvedValue({
      id: "chat-identity-1",
      platform: "telegram",
      platformUserId: "tg-123",
      displayName: "Ada",
      userId: null,
      workspaceId: null,
      linkToken: "tok-old-still-valid",
      linkTokenExpiresAt: new Date(NOW.getTime() + 10 * 60 * 1000),
      createdAt: NOW,
      updatedAt: NOW,
    } as never);

    const res = await POST(req({ eveSessionId: "eve-session-1" }));
    const body = await res.json();
    const newToken = body.url.split("/connect/")[1];

    expect(newToken).not.toBe("tok-old-still-valid");
    expect(setChatIdentityLinkToken).toHaveBeenCalledWith(
      "chat-identity-1",
      newToken,
      expect.any(Date)
    );
  });
});
