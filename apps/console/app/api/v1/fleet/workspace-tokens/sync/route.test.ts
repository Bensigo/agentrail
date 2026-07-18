import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  listFleetProvisionState: vi.fn(),
  mintApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
}));

import { POST } from "./route";
import {
  listFleetProvisionState,
  mintApiKey,
  revokeApiKey,
} from "@agentrail/db-postgres";

const mockListState = vi.mocked(listFleetProvisionState);
const mockMint = vi.mocked(mintApiKey);
const mockRevoke = vi.mocked(revokeApiKey);

const ENV_KEY = "FLEET_CONSOLE_TOKEN";
const SECRET = "fleet-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function req(token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
  return new NextRequest("http://localhost/api/v1/fleet/workspace-tokens/sync", {
    method: "POST",
    headers,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = SECRET;
  mockListState.mockResolvedValue([]);
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("POST /api/v1/fleet/workspace-tokens/sync — auth (#1267 PR ①)", () => {
  it("404s when FLEET_CONSOLE_TOKEN is unset (fail closed, never 'open')", async () => {
    delete process.env[ENV_KEY];

    const res = await POST(req(SECRET));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    expect(mockListState).not.toHaveBeenCalled();
  });

  it("404s when no Authorization header is sent", async () => {
    const res = await POST(req());

    expect(res.status).toBe(404);
    expect(mockListState).not.toHaveBeenCalled();
  });

  it("404s on a wrong token of the SAME length as the real secret", async () => {
    const wrongSameLength = "x".repeat(SECRET.length);

    const res = await POST(req(wrongSameLength));

    expect(res.status).toBe(404);
    expect(mockListState).not.toHaveBeenCalled();
  });

  it("404s (not 500) on a wrong token of a DIFFERENT length — timingSafeEqual would throw a RangeError if called on mismatched-length buffers directly; the route must guard the length check first", async () => {
    const res = await POST(req("short"));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("404s on an empty bearer token", async () => {
    const res = await POST(req(""));

    expect(res.status).toBe(404);
    expect(mockListState).not.toHaveBeenCalled();
  });

  it("succeeds with the correct token", async () => {
    const res = await POST(req(SECRET));

    expect(res.status).toBe(200);
    expect(mockListState).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/v1/fleet/workspace-tokens/sync — mint/active/revoke buckets", () => {
  it("mints for a hosted-eligible workspace with no active fleet key", async () => {
    mockListState.mockResolvedValue([
      { workspaceId: "ws-1", slug: "acme", hostedExecution: true, hasActiveFleetKey: false, fleetKeyId: null },
    ]);
    mockMint.mockResolvedValue({ id: "key-1", rawKey: "ar_rawtoken1", keyPrefix: "ar_rawtoke" });

    const res = await POST(req(SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockMint).toHaveBeenCalledWith({ workspaceId: "ws-1", name: "Hosted fleet", kind: "fleet" });
    expect(body).toEqual({
      minted: [{ workspaceId: "ws-1", slug: "acme", token: "ar_rawtoken1" }],
      active: [],
      revoked: [],
    });
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it("reports an already-active hosted-eligible workspace in `active`, mints nothing", async () => {
    mockListState.mockResolvedValue([
      { workspaceId: "ws-2", slug: "beta", hostedExecution: true, hasActiveFleetKey: true, fleetKeyId: "key-2" },
    ]);

    const res = await POST(req(SECRET));
    const body = await res.json();

    expect(body).toEqual({ minted: [], active: ["ws-2"], revoked: [] });
    expect(mockMint).not.toHaveBeenCalled();
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it("revokes the fleet key for a workspace that flipped hosted_execution to false", async () => {
    mockListState.mockResolvedValue([
      { workspaceId: "ws-3", slug: "gamma", hostedExecution: false, hasActiveFleetKey: true, fleetKeyId: "key-3" },
    ]);
    mockRevoke.mockResolvedValue({ id: "key-3" } as never);

    const res = await POST(req(SECRET));
    const body = await res.json();

    expect(mockRevoke).toHaveBeenCalledWith("ws-3", "key-3");
    expect(body).toEqual({ minted: [], active: [], revoked: ["ws-3"] });
    expect(mockMint).not.toHaveBeenCalled();
  });

  it("does nothing for a self-hosted-only workspace with no fleet key — absent from every bucket", async () => {
    mockListState.mockResolvedValue([
      { workspaceId: "ws-4", slug: "delta", hostedExecution: false, hasActiveFleetKey: false, fleetKeyId: null },
    ]);

    const res = await POST(req(SECRET));
    const body = await res.json();

    expect(body).toEqual({ minted: [], active: [], revoked: [] });
    expect(mockMint).not.toHaveBeenCalled();
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it("handles a mixed sweep across many workspaces, one commit per bucket", async () => {
    mockListState.mockResolvedValue([
      { workspaceId: "ws-1", slug: "a", hostedExecution: true, hasActiveFleetKey: false, fleetKeyId: null },
      { workspaceId: "ws-2", slug: "b", hostedExecution: true, hasActiveFleetKey: true, fleetKeyId: "key-2" },
      { workspaceId: "ws-3", slug: "c", hostedExecution: false, hasActiveFleetKey: true, fleetKeyId: "key-3" },
      { workspaceId: "ws-4", slug: "d", hostedExecution: false, hasActiveFleetKey: false, fleetKeyId: null },
    ]);
    mockMint.mockResolvedValue({ id: "key-1", rawKey: "ar_freshtoken", keyPrefix: "ar_freshtok" });
    mockRevoke.mockResolvedValue({ id: "key-3" } as never);

    const res = await POST(req(SECRET));
    const body = await res.json();

    expect(body).toEqual({
      minted: [{ workspaceId: "ws-1", slug: "a", token: "ar_freshtoken" }],
      active: ["ws-2"],
      revoked: ["ws-3"],
    });
  });
});

describe("POST /api/v1/fleet/workspace-tokens/sync — mint race (unique violation)", () => {
  it("treats a unique-violation (err.code 23505) on mint as already-active, no 500", async () => {
    mockListState.mockResolvedValue([
      { workspaceId: "ws-5", slug: "race", hostedExecution: true, hasActiveFleetKey: false, fleetKeyId: null },
    ]);
    mockMint.mockRejectedValue(Object.assign(new Error("duplicate key"), { code: "23505" }));

    const res = await POST(req(SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ minted: [], active: ["ws-5"], revoked: [] });
  });

  it("treats a DRIZZLE-WRAPPED unique-violation (err.cause.code 23505) as already-active too", async () => {
    mockListState.mockResolvedValue([
      { workspaceId: "ws-6", slug: "race2", hostedExecution: true, hasActiveFleetKey: false, fleetKeyId: null },
    ]);
    mockMint.mockRejectedValue(
      Object.assign(new Error("Failed query"), { cause: { code: "23505" } })
    );

    const res = await POST(req(SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ minted: [], active: ["ws-6"], revoked: [] });
  });

  it("rethrows a non-unique-violation mint error (does not silently swallow real failures)", async () => {
    mockListState.mockResolvedValue([
      { workspaceId: "ws-7", slug: "broken", hostedExecution: true, hasActiveFleetKey: false, fleetKeyId: null },
    ]);
    mockMint.mockRejectedValue(new Error("connection reset"));

    await expect(POST(req(SECRET))).rejects.toThrow("connection reset");
  });
});

describe("POST /api/v1/fleet/workspace-tokens/sync — token never logged", () => {
  it("never writes the minted raw token to console.log/warn/error", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockListState.mockResolvedValue([
      { workspaceId: "ws-8", slug: "secretive", hostedExecution: true, hasActiveFleetKey: false, fleetKeyId: null },
    ]);
    const RAW_TOKEN = "ar_super-secret-raw-token-value";
    mockMint.mockResolvedValue({ id: "key-8", rawKey: RAW_TOKEN, keyPrefix: "ar_super-s" });

    await POST(req(SECRET));

    const allLoggedText = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .flat()
      .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
      .join("\n");
    expect(allLoggedText).not.toContain(RAW_TOKEN);

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
