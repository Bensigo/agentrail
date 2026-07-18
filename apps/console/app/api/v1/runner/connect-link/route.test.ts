import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getChatIdentity: vi.fn(),
  setChatIdentityLinkToken: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import { POST } from "./route";
import { getChatIdentity, setChatIdentityLinkToken } from "@agentrail/db-postgres";
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
  it("401 when requireBearer rejects, and never touches the identity lookup", async () => {
    const { NextResponse } = await import("next/server");
    vi.mocked(requireBearer).mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as never
    );

    const res = await POST(
      req({ platform: "telegram", platformUserId: "tg-123" }, false)
    );

    expect(res.status).toBe(401);
    expect(getChatIdentity).not.toHaveBeenCalled();
    expect(setChatIdentityLinkToken).not.toHaveBeenCalled();
  });

  it("400 when the body is missing platform/platformUserId", async () => {
    const res = await POST(req({ platform: "telegram" }));
    expect(res.status).toBe(400);
    expect(getChatIdentity).not.toHaveBeenCalled();
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
    expect(getChatIdentity).not.toHaveBeenCalled();
  });

  it("404 when no chat identity exists for (platform, platformUserId) — mints only for identities that already messaged", async () => {
    vi.mocked(getChatIdentity).mockResolvedValue(null as never);

    const res = await POST(
      req({ platform: "telegram", platformUserId: "unknown-user" })
    );

    expect(res.status).toBe(404);
    expect(getChatIdentity).toHaveBeenCalledWith("telegram", "unknown-user");
    expect(setChatIdentityLinkToken).not.toHaveBeenCalled();
  });

  it("404 when the identity is already linked to a user — refuses to re-mint/hijack, body byte-identical to the unknown-identity 404", async () => {
    vi.mocked(getChatIdentity).mockResolvedValueOnce({
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

    const res = await POST(
      req({ platform: "telegram", platformUserId: "tg-123" })
    );
    const text = await res.text();

    expect(res.status).toBe(404);
    expect(getChatIdentity).toHaveBeenCalledWith("telegram", "tg-123");
    expect(setChatIdentityLinkToken).not.toHaveBeenCalled();
    expect(JSON.parse(text)).toEqual({ error: "Chat identity not found" });

    // Prove it byte-for-byte, not just structurally: same code path as the
    // genuinely-unknown-identity 404 above.
    vi.mocked(getChatIdentity).mockResolvedValueOnce(null as never);
    const unknownRes = await POST(
      req({ platform: "telegram", platformUserId: "unknown-user" })
    );
    const unknownText = await unknownRes.text();

    expect(text).toBe(unknownText);
  });

  it("404 when the identity has a workspace_id that differs from the bearer's own workspace — tenant scoping, body byte-identical to the unknown-identity 404", async () => {
    vi.mocked(getChatIdentity).mockResolvedValueOnce({
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
    const res = await POST(
      req({ platform: "telegram", platformUserId: "tg-123" })
    );
    const text = await res.text();

    expect(res.status).toBe(404);
    expect(getChatIdentity).toHaveBeenCalledWith("telegram", "tg-123");
    expect(setChatIdentityLinkToken).not.toHaveBeenCalled();
    expect(JSON.parse(text)).toEqual({ error: "Chat identity not found" });

    vi.mocked(getChatIdentity).mockResolvedValueOnce(null as never);
    const unknownRes = await POST(
      req({ platform: "telegram", platformUserId: "unknown-user" })
    );
    const unknownText = await unknownRes.text();

    expect(text).toBe(unknownText);
  });

  it("200: mints when the identity's workspace_id matches the bearer's OWN workspace (same tenant, not yet user-linked)", async () => {
    vi.mocked(getChatIdentity).mockResolvedValue({
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

    const res = await POST(
      req({ platform: "telegram", platformUserId: "tg-123" })
    );

    expect(res.status).toBe(200);
    expect(setChatIdentityLinkToken).toHaveBeenCalledWith(
      "chat-identity-1",
      expect.any(String),
      expect.any(Date)
    );
  });

  it("200: mints a 32+ hex char token, stores it with a 30-minute expiry, and returns the connect URL built from the request origin", async () => {
    vi.mocked(getChatIdentity).mockResolvedValue({
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

    const res = await POST(
      req({ platform: "telegram", platformUserId: "tg-123" })
    );

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
    vi.mocked(getChatIdentity).mockResolvedValue({
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

    const res = await POST(
      req({ platform: "telegram", platformUserId: "tg-123" })
    );
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
