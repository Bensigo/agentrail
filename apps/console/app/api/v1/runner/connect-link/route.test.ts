import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  getChatIdentityById: vi.fn(),
  setChatIdentityLinkToken: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import { POST } from "./route";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  setChatIdentityLinkToken,
} from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

const NOW = new Date("2026-07-18T00:00:00.000Z");

function req(body?: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/connect-link", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withAuth ? { Authorization: "Bearer ar_test" } : {}),
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
  vi.mocked(requireBearer).mockResolvedValue({
    apiKeyId: "key-1",
    workspaceId: "ws-1",
    teamId: null,
  } as never);
  vi.mocked(setChatIdentityLinkToken).mockResolvedValue(undefined as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/v1/runner/connect-link", () => {
  it("401 when requireBearer rejects, and never touches session/identity lookups", async () => {
    const { NextResponse } = await import("next/server");
    vi.mocked(requireBearer).mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as never
    );

    const res = await POST(req({ eveSessionId: "eve-session-1" }, false));

    expect(res.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    expect(getChatIdentityById).not.toHaveBeenCalled();
    expect(setChatIdentityLinkToken).not.toHaveBeenCalled();
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
        Authorization: "Bearer ar_test",
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

  it("404 when the resolved chat identity has a workspace_id that differs from the bearer's own — tenant scoping, byte-identical to the unknown-session 404", async () => {
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

    // beforeEach mocks requireBearer's workspaceId as "ws-1" — deliberately
    // different from "ws-some-other-tenant" above.
    const res = await POST(req({ eveSessionId: "eve-session-1" }));
    const text = await res.text();

    expect(res.status).toBe(404);
    expect(setChatIdentityLinkToken).not.toHaveBeenCalled();
    expect(JSON.parse(text)).toEqual({ error: "Chat identity not found" });

    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null as never);
    const unknownRes = await POST(req({ eveSessionId: "unknown-eve-session" }));
    expect(await unknownRes.text()).toBe(text);
  });

  it("200: mints when the resolved identity's workspace_id matches the bearer's OWN workspace (same tenant, not yet user-linked)", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(
      MOCK_SESSION_ROW as never
    );
    vi.mocked(getChatIdentityById).mockResolvedValue({
      id: "chat-identity-1",
      platform: "telegram",
      platformUserId: "tg-123",
      displayName: "Ada",
      userId: null,
      workspaceId: "ws-1", // same as requireBearer's mocked workspaceId
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
