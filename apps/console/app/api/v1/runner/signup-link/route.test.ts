import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  getChatIdentityById: vi.fn(),
  setChatIdentitySignupToken: vi.fn(),
}));

import { POST } from "./route";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  setChatIdentitySignupToken,
} from "@agentrail/db-postgres";

const NOW = new Date("2026-07-22T00:00:00.000Z");

// Central-secret auth, identical contract to connect-link/route.test.ts.
const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function req(body?: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/signup-link", {
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env[ENV_KEY] = SECRET;
  vi.mocked(setChatIdentitySignupToken).mockResolvedValue(undefined as never);
});

afterEach(() => {
  vi.useRealTimers();
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("POST /api/v1/runner/signup-link", () => {
  it("401 when no Authorization header is sent, and never touches session/identity lookups", async () => {
    const res = await POST(req({ eveSessionId: "eve-session-1" }, false));

    expect(res.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    expect(getChatIdentityById).not.toHaveBeenCalled();
    expect(setChatIdentitySignupToken).not.toHaveBeenCalled();
  });

  it("401 when JACE_CONSOLE_TOKEN is unset (fail closed)", async () => {
    delete process.env[ENV_KEY];

    const res = await POST(req({ eveSessionId: "eve-session-1" }, true));

    expect(res.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("401 on a wrong secret", async () => {
    const request = new NextRequest("http://localhost/api/v1/runner/signup-link", {
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
    const request = new NextRequest("http://localhost/api/v1/runner/signup-link", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${SECRET}` },
      body: "{not valid json",
    });

    const res = await POST(request);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON" });
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("404 when no jace_sessions row is bound to this eveSessionId", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null as never);

    const res = await POST(req({ eveSessionId: "unknown-eve-session" }));

    expect(res.status).toBe(404);
    expect(getChatIdentityById).not.toHaveBeenCalled();
    expect(setChatIdentitySignupToken).not.toHaveBeenCalled();
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

    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null as never);
    const unknownRes = await POST(req({ eveSessionId: "unknown-eve-session" }));
    expect(await unknownRes.text()).toBe(text);
  });

  it("404 when the resolved chat identity is already linked to a user — nothing to sign up, body byte-identical to the unknown-session 404", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(MOCK_SESSION_ROW as never);
    vi.mocked(getChatIdentityById).mockResolvedValue({
      ...UNBOUND_IDENTITY,
      userId: "user-already-signed-up",
    } as never);

    const res = await POST(req({ eveSessionId: "eve-session-1" }));
    const text = await res.text();

    expect(res.status).toBe(404);
    expect(getChatIdentityById).toHaveBeenCalledWith("chat-identity-1");
    expect(setChatIdentitySignupToken).not.toHaveBeenCalled();
    expect(JSON.parse(text)).toEqual({ error: "Chat identity not found" });

    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null as never);
    const unknownRes = await POST(req({ eveSessionId: "unknown-eve-session" }));
    expect(await unknownRes.text()).toBe(text);
  });

  it("resolves the identity via the session chain with exact arguments: getJaceSessionByEveSessionId(eveSessionId) then getChatIdentityById(session.chatIdentityId)", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(MOCK_SESSION_ROW as never);
    vi.mocked(getChatIdentityById).mockResolvedValue(UNBOUND_IDENTITY as never);

    await POST(req({ eveSessionId: "eve-session-1" }));

    expect(getJaceSessionByEveSessionId).toHaveBeenCalledWith("eve-session-1");
    expect(getChatIdentityById).toHaveBeenCalledWith("chat-identity-1");
  });

  it("200: mints a 32+ hex char token, stores it with a 30-minute expiry, and returns the signup URL built from the request origin", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(MOCK_SESSION_ROW as never);
    vi.mocked(getChatIdentityById).mockResolvedValue(UNBOUND_IDENTITY as never);

    const res = await POST(req({ eveSessionId: "eve-session-1" }));

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.url).toMatch(/^http:\/\/localhost\/signup\/[0-9a-f]{32,}$/);
    const token = body.url.split("/signup/")[1];

    expect(body.expiresAt).toBe(new Date(NOW.getTime() + 30 * 60 * 1000).toISOString());
    expect(setChatIdentitySignupToken).toHaveBeenCalledWith(
      "chat-identity-1",
      token,
      new Date(NOW.getTime() + 30 * 60 * 1000)
    );
  });

  it("mints a fresh token on every call, even for an identity that already has an unexpired one (last-write-wins re-mint)", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(MOCK_SESSION_ROW as never);
    vi.mocked(getChatIdentityById).mockResolvedValue({
      ...UNBOUND_IDENTITY,
      signupToken: "tok-old-still-valid",
      signupTokenExpiresAt: new Date(NOW.getTime() + 10 * 60 * 1000),
    } as never);

    const res = await POST(req({ eveSessionId: "eve-session-1" }));
    const body = await res.json();
    const newToken = body.url.split("/signup/")[1];

    expect(newToken).not.toBe("tok-old-still-valid");
    expect(setChatIdentitySignupToken).toHaveBeenCalledWith(
      "chat-identity-1",
      newToken,
      expect.any(Date)
    );
  });

  it("never mints a /connect/ url — this is a distinct token/route from the GitHub-connect flow", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(MOCK_SESSION_ROW as never);
    vi.mocked(getChatIdentityById).mockResolvedValue(UNBOUND_IDENTITY as never);

    const res = await POST(req({ eveSessionId: "eve-session-1" }));
    const body = await res.json();

    expect(body.url).not.toMatch(/\/connect\//);
  });
});
