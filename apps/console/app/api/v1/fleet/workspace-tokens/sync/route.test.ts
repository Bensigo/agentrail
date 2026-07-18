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
      failed: [],
    });
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it("reports an already-active hosted-eligible workspace in `active`, mints nothing", async () => {
    mockListState.mockResolvedValue([
      { workspaceId: "ws-2", slug: "beta", hostedExecution: true, hasActiveFleetKey: true, fleetKeyId: "key-2" },
    ]);

    const res = await POST(req(SECRET));
    const body = await res.json();

    expect(body).toEqual({ minted: [], active: ["ws-2"], revoked: [], failed: [] });
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
    expect(body).toEqual({ minted: [], active: [], revoked: ["ws-3"], failed: [] });
    expect(mockMint).not.toHaveBeenCalled();
  });

  it("does nothing for a self-hosted-only workspace with no fleet key — absent from every bucket", async () => {
    mockListState.mockResolvedValue([
      { workspaceId: "ws-4", slug: "delta", hostedExecution: false, hasActiveFleetKey: false, fleetKeyId: null },
    ]);

    const res = await POST(req(SECRET));
    const body = await res.json();

    expect(body).toEqual({ minted: [], active: [], revoked: [], failed: [] });
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
      failed: [],
    });
  });
});

describe("POST /api/v1/fleet/workspace-tokens/sync — mint race (unique violation)", () => {
  it("treats a unique-violation (err.code 23505) on mint as already-active, no 500, NOT failed", async () => {
    mockListState.mockResolvedValue([
      { workspaceId: "ws-5", slug: "race", hostedExecution: true, hasActiveFleetKey: false, fleetKeyId: null },
    ]);
    mockMint.mockRejectedValue(Object.assign(new Error("duplicate key"), { code: "23505" }));

    const res = await POST(req(SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ minted: [], active: ["ws-5"], revoked: [], failed: [] });
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
    expect(body).toEqual({ minted: [], active: ["ws-6"], revoked: [], failed: [] });
  });
});

describe("POST /api/v1/fleet/workspace-tokens/sync — per-row failure isolation (review fix)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The isolation path logs the caught error object; keep test output
    // pristine and capture what was logged for the no-token assertions.
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("a generic mint error on a LATER row still returns 200 with the EARLIER row's minted token; the later row lands in failed", async () => {
    mockListState.mockResolvedValue([
      { workspaceId: "ws-ok", slug: "ok", hostedExecution: true, hasActiveFleetKey: false, fleetKeyId: null },
      { workspaceId: "ws-broken", slug: "broken", hostedExecution: true, hasActiveFleetKey: false, fleetKeyId: null },
    ]);
    const EARLIER_TOKEN = "ar_earlier-rows-durably-minted-token";
    mockMint
      .mockResolvedValueOnce({ id: "key-ok", rawKey: EARLIER_TOKEN, keyPrefix: "ar_earlier" })
      .mockRejectedValueOnce(new Error("connection reset"));

    const res = await POST(req(SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      minted: [{ workspaceId: "ws-ok", slug: "ok", token: EARLIER_TOKEN }],
      active: [],
      revoked: [],
      failed: [{ workspaceId: "ws-broken", reason: "mint_failed" }],
    });
    // The isolation log must never carry the earlier row's raw token.
    const logged = errorSpy.mock.calls
      .flat()
      .map((arg: unknown) =>
        typeof arg === "string" ? arg : JSON.stringify(arg) ?? String(arg)
      )
      .join("\n");
    expect(logged).not.toContain(EARLIER_TOKEN);
  });

  it("a generic mint error on an EARLIER row does not stop later rows from minting", async () => {
    mockListState.mockResolvedValue([
      { workspaceId: "ws-broken", slug: "broken", hostedExecution: true, hasActiveFleetKey: false, fleetKeyId: null },
      { workspaceId: "ws-ok", slug: "ok", hostedExecution: true, hasActiveFleetKey: false, fleetKeyId: null },
    ]);
    mockMint
      .mockRejectedValueOnce(new Error("deadlock detected"))
      .mockResolvedValueOnce({ id: "key-ok", rawKey: "ar_later-token", keyPrefix: "ar_later-t" });

    const res = await POST(req(SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      minted: [{ workspaceId: "ws-ok", slug: "ok", token: "ar_later-token" }],
      active: [],
      revoked: [],
      failed: [{ workspaceId: "ws-broken", reason: "mint_failed" }],
    });
    expect(mockMint).toHaveBeenCalledTimes(2);
  });

  it("a revoke failure lands in failed as revoke_failed and does not disturb the rest of the sweep", async () => {
    mockListState.mockResolvedValue([
      { workspaceId: "ws-revoke-broken", slug: "rb", hostedExecution: false, hasActiveFleetKey: true, fleetKeyId: "key-rb" },
      { workspaceId: "ws-mint", slug: "m", hostedExecution: true, hasActiveFleetKey: false, fleetKeyId: null },
      { workspaceId: "ws-revoke-ok", slug: "ro", hostedExecution: false, hasActiveFleetKey: true, fleetKeyId: "key-ro" },
    ]);
    mockRevoke
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce({ id: "key-ro" } as never);
    mockMint.mockResolvedValue({ id: "key-m", rawKey: "ar_mint-token", keyPrefix: "ar_mint-to" });

    const res = await POST(req(SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      minted: [{ workspaceId: "ws-mint", slug: "m", token: "ar_mint-token" }],
      active: [],
      revoked: ["ws-revoke-ok"],
      failed: [{ workspaceId: "ws-revoke-broken", reason: "revoke_failed" }],
    });
  });

  it("failed entries carry ONLY {workspaceId, reason} — never a token and never raw error text", async () => {
    mockListState.mockResolvedValue([
      { workspaceId: "ws-broken", slug: "broken", hostedExecution: true, hasActiveFleetKey: false, fleetKeyId: null },
    ]);
    const SENSITIVE_ERROR_TEXT = "password=hunter2 in connection string";
    mockMint.mockRejectedValue(new Error(SENSITIVE_ERROR_TEXT));

    const res = await POST(req(SECRET));
    const bodyText = JSON.stringify(await res.json());

    expect(bodyText).not.toContain(SENSITIVE_ERROR_TEXT);
    expect(bodyText).toContain('"reason":"mint_failed"');
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
