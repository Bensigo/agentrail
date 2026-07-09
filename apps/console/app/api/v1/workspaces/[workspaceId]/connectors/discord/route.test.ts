import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  setDiscordWebhookUrl: vi.fn(),
  upsertConnector: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  setDiscordWebhookUrl,
  upsertConnector,
} from "@agentrail/db-postgres";
import { PUT } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
const USER = "user-1";
const GOOD = "https://discord.com/api/webhooks/123456/super-secret-token";

function params() {
  return Promise.resolve({ workspaceId: WS });
}

function putReq(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/connectors/discord`,
    { method: "PUT", body: JSON.stringify(body) }
  );
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.mocked(auth).mockReset();
  vi.mocked(getWorkspaceMembership).mockReset();
  vi.mocked(setDiscordWebhookUrl).mockReset();
  vi.mocked(upsertConnector).mockReset();
  vi.mocked(upsertConnector).mockResolvedValue({} as never);
  // The connect path best-effort GETs the webhook URL to resolve channel_id
  // (#1050) — default to a failed probe so tests that don't care about it stay
  // deterministic and never hit the real network.
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("{}", { status: 401 })
  );
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe("PUT /connectors/discord", () => {
  it("401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await PUT(putReq({ webhookUrl: GOOD }), { params: params() });
    expect(res.status).toBe(401);
    expect(setDiscordWebhookUrl).not.toHaveBeenCalled();
  });

  it("403 when not a workspace member", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await PUT(putReq({ webhookUrl: GOOD }), { params: params() });
    expect(res.status).toBe(403);
    expect(setDiscordWebhookUrl).not.toHaveBeenCalled();
  });

  it("403 when a member but not owner/admin", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "member" } as never);
    const res = await PUT(putReq({ webhookUrl: GOOD }), { params: params() });
    expect(res.status).toBe(403);
    expect(setDiscordWebhookUrl).not.toHaveBeenCalled();
  });

  it("connects a valid Discord webhook (AC3)", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "admin" } as never);
    vi.mocked(setDiscordWebhookUrl).mockResolvedValue(undefined as never);

    const res = await PUT(putReq({ webhookUrl: GOOD }), { params: params() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true });
    expect(setDiscordWebhookUrl).toHaveBeenCalledWith(WS, GOOD);
    // Self-configure (AC2): connecting enables the discord connector row.
    // The channelId probe failed (default mock), so no config is persisted.
    expect(upsertConnector).toHaveBeenCalledWith(WS, "discord", {
      enabled: true,
    });
  });

  it("resolves and persists the webhook's channelId on connect (#1050)", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "admin" } as never);
    vi.mocked(setDiscordWebhookUrl).mockResolvedValue(undefined as never);
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ channel_id: "C-DISCORD" }), {
        status: 200,
      })
    );

    const res = await PUT(putReq({ webhookUrl: GOOD }), { params: params() });
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(GOOD, expect.anything());
    // Jace's native outbound path (notify.ts) reads config.channelId — it must
    // round-trip through upsertConnector, not just get computed and dropped.
    expect(upsertConnector).toHaveBeenCalledWith(WS, "discord", {
      enabled: true,
      config: { channelId: "C-DISCORD" },
    });
  });

  it("saves the webhook even when the channelId probe fails (best-effort)", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "admin" } as never);
    vi.mocked(setDiscordWebhookUrl).mockResolvedValue(undefined as never);
    fetchSpy.mockRejectedValue(new Error("network down"));

    const res = await PUT(putReq({ webhookUrl: GOOD }), { params: params() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true });
    expect(upsertConnector).toHaveBeenCalledWith(WS, "discord", {
      enabled: true,
    });
  });

  it("disconnects when webhookUrl is null", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "owner" } as never);
    vi.mocked(setDiscordWebhookUrl).mockResolvedValue(undefined as never);

    const res = await PUT(putReq({ webhookUrl: null }), { params: params() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
    expect(setDiscordWebhookUrl).toHaveBeenCalledWith(WS, null);
    // Disconnecting disables the connector row.
    expect(upsertConnector).toHaveBeenCalledWith(WS, "discord", {
      enabled: false,
    });
  });

  it("400 for a non-Discord URL", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "admin" } as never);

    const res = await PUT(putReq({ webhookUrl: "https://evil.example.com/x" }), {
      params: params(),
    });
    expect(res.status).toBe(400);
    expect(setDiscordWebhookUrl).not.toHaveBeenCalled();
  });

  it("400 for an http (non-https) Discord URL", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "admin" } as never);

    const res = await PUT(
      putReq({ webhookUrl: "http://discord.com/api/webhooks/1/abc" }),
      { params: params() }
    );
    expect(res.status).toBe(400);
    expect(setDiscordWebhookUrl).not.toHaveBeenCalled();
  });
});
