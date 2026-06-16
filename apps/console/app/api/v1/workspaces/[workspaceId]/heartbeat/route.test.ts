import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", async () => {
  // Keep the real pure validator; mock only the I/O functions.
  const validate = (update: Record<string, unknown>) => {
    const value: Record<string, unknown> = {};
    if (update.enabled !== undefined) {
      if (typeof update.enabled !== "boolean")
        return { ok: false, error: "enabled must be a boolean" };
      value.enabled = update.enabled;
    }
    if (update.pollIntervalSeconds !== undefined) {
      const n = update.pollIntervalSeconds as number;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 10 || n > 86400)
        return { ok: false, error: "bad interval" };
      value.pollIntervalSeconds = n;
    }
    if (update.triggerLabel !== undefined) {
      const s = String(update.triggerLabel).trim();
      if (!s || s.length > 50) return { ok: false, error: "bad label" };
      value.triggerLabel = s;
    }
    return { ok: true, value };
  };
  return {
    getWorkspaceMembership: vi.fn(),
    getHeartbeatConfig: vi.fn(),
    setHeartbeatConfig: vi.fn(),
    validateHeartbeatConfigUpdate: vi.fn(validate),
  };
});

import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  getHeartbeatConfig,
  setHeartbeatConfig,
} from "@agentrail/db-postgres";
import { GET, PUT } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
const USER = "user-1";
const DEFAULT_CONFIG = {
  enabled: false,
  pollIntervalSeconds: 60,
  triggerLabel: "ready-for-agent",
  updatedAt: null,
};

function params() {
  return Promise.resolve({ workspaceId: WS });
}

function putReq(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/workspaces/${WS}/heartbeat`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

function getReq(): NextRequest {
  return new NextRequest(`http://localhost/api/v1/workspaces/${WS}/heartbeat`);
}

beforeEach(() => {
  vi.mocked(auth).mockReset();
  vi.mocked(getWorkspaceMembership).mockReset();
  vi.mocked(getHeartbeatConfig).mockReset();
  vi.mocked(setHeartbeatConfig).mockReset();
});

describe("GET /heartbeat", () => {
  it("401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(getReq(), { params: params() });
    expect(res.status).toBe(401);
  });

  it("403 when not a member", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await GET(getReq(), { params: params() });
    expect(res.status).toBe(403);
  });

  it("returns config + role for a member (AC1)", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      role: "member",
    } as never);
    vi.mocked(getHeartbeatConfig).mockResolvedValue(DEFAULT_CONFIG as never);

    const res = await GET(getReq(), { params: params() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      config: DEFAULT_CONFIG,
      role: "member",
    });
  });
});

describe("PUT /heartbeat", () => {
  it("401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await PUT(putReq({ enabled: true }), { params: params() });
    expect(res.status).toBe(401);
    expect(setHeartbeatConfig).not.toHaveBeenCalled();
  });

  it("403 when a member but not owner/admin (AC2)", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      role: "member",
    } as never);
    const res = await PUT(putReq({ enabled: true }), { params: params() });
    expect(res.status).toBe(403);
    expect(setHeartbeatConfig).not.toHaveBeenCalled();
  });

  it("persists a valid update as admin and returns the new config (AC2)", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      role: "admin",
    } as never);
    const updated = {
      enabled: true,
      pollIntervalSeconds: 30,
      triggerLabel: "afk",
      updatedAt: "2026-06-16T00:00:00.000Z",
    };
    vi.mocked(setHeartbeatConfig).mockResolvedValue(updated as never);

    const res = await PUT(
      putReq({ enabled: true, pollIntervalSeconds: 30, triggerLabel: "afk" }),
      { params: params() }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ config: updated });
    expect(setHeartbeatConfig).toHaveBeenCalledWith(WS, {
      enabled: true,
      pollIntervalSeconds: 30,
      triggerLabel: "afk",
    });
  });

  it("400 for an out-of-range interval", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      role: "owner",
    } as never);

    const res = await PUT(putReq({ pollIntervalSeconds: 1 }), {
      params: params(),
    });
    expect(res.status).toBe(400);
    expect(setHeartbeatConfig).not.toHaveBeenCalled();
  });

  it("400 for an empty label", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      role: "owner",
    } as never);

    const res = await PUT(putReq({ triggerLabel: "   " }), { params: params() });
    expect(res.status).toBe(400);
    expect(setHeartbeatConfig).not.toHaveBeenCalled();
  });
});
