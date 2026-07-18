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

  it("404 when no chat identity exists for (platform, platformUserId) — mints only for identities that already messaged", async () => {
    vi.mocked(getChatIdentity).mockResolvedValue(null as never);

    const res = await POST(
      req({ platform: "telegram", platformUserId: "unknown-user" })
    );

    expect(res.status).toBe(404);
    expect(getChatIdentity).toHaveBeenCalledWith("telegram", "unknown-user");
    expect(setChatIdentityLinkToken).not.toHaveBeenCalled();
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
