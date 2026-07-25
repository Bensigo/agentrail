import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  selfHealFleetKey: vi.fn(),
}));

import { POST } from "./route";
import { selfHealFleetKey } from "@agentrail/db-postgres";

const mockSelfHeal = vi.mocked(selfHealFleetKey);

const ENV_KEY = "FLEET_CONSOLE_TOKEN";
const SECRET = "fleet-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];
const COOLDOWN_ENV_KEY = "FLEET_SELF_HEAL_COOLDOWN_SECONDS";
const ORIGINAL_COOLDOWN_ENV = process.env[COOLDOWN_ENV_KEY];

function req(
  token: string | undefined,
  body: unknown | undefined = { workspaceId: "ws-1", fleetInstanceId: "fleet-host-abc123" }
): NextRequest {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
  return new NextRequest("http://localhost/api/v1/fleet/workspace-tokens/self-heal", {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = SECRET;
  delete process.env[COOLDOWN_ENV_KEY];
  mockSelfHeal.mockResolvedValue({
    ok: true,
    workspaceId: "ws-1",
    slug: "acme",
    token: "ar_freshtoken",
    keyId: "key-new",
  });
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
  if (ORIGINAL_COOLDOWN_ENV === undefined) delete process.env[COOLDOWN_ENV_KEY];
  else process.env[COOLDOWN_ENV_KEY] = ORIGINAL_COOLDOWN_ENV;
});

describe("POST /api/v1/fleet/workspace-tokens/self-heal — auth", () => {
  it("404s when FLEET_CONSOLE_TOKEN is unset (fail closed, never 'open')", async () => {
    delete process.env[ENV_KEY];

    const res = await POST(req(SECRET));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    expect(mockSelfHeal).not.toHaveBeenCalled();
  });

  it("404s when no Authorization header is sent", async () => {
    const res = await POST(req(undefined));

    expect(res.status).toBe(404);
    expect(mockSelfHeal).not.toHaveBeenCalled();
  });

  it("404s on a wrong token of the SAME length as the real secret", async () => {
    const wrongSameLength = "x".repeat(SECRET.length);

    const res = await POST(req(wrongSameLength));

    expect(res.status).toBe(404);
    expect(mockSelfHeal).not.toHaveBeenCalled();
  });

  it("404s (not 500) on a wrong token of a DIFFERENT length", async () => {
    const res = await POST(req("short"));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("succeeds with the correct token", async () => {
    const res = await POST(req(SECRET));

    expect(res.status).toBe(200);
    expect(mockSelfHeal).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/v1/fleet/workspace-tokens/self-heal — request body validation", () => {
  it("400s when workspaceId is missing", async () => {
    const res = await POST(req(SECRET, { fleetInstanceId: "fleet-host-abc123" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, reason: "invalid_request" });
    expect(mockSelfHeal).not.toHaveBeenCalled();
  });

  it("400s when fleetInstanceId is missing", async () => {
    const res = await POST(req(SECRET, { workspaceId: "ws-1" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, reason: "invalid_request" });
    expect(mockSelfHeal).not.toHaveBeenCalled();
  });

  it("400s when workspaceId is not a string", async () => {
    const res = await POST(req(SECRET, { workspaceId: 123, fleetInstanceId: "fleet-host-abc123" }));

    expect(res.status).toBe(400);
    expect(mockSelfHeal).not.toHaveBeenCalled();
  });

  it("400s when the body is not valid JSON", async () => {
    const badReq = new NextRequest("http://localhost/api/v1/fleet/workspace-tokens/self-heal", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
      body: "not json",
    });

    const res = await POST(badReq);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, reason: "invalid_request" });
    expect(mockSelfHeal).not.toHaveBeenCalled();
  });

  it("400s when no body is sent at all", async () => {
    // NOT req(SECRET, undefined) — a default parameter kicks in for an
    // explicitly-passed `undefined` too, silently falling back to req()'s
    // valid default body instead of constructing a genuinely bodyless
    // request. Build the request directly to actually omit `body`.
    const noBodyReq = new NextRequest("http://localhost/api/v1/fleet/workspace-tokens/self-heal", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    });

    const res = await POST(noBodyReq);

    expect(res.status).toBe(400);
    expect(mockSelfHeal).not.toHaveBeenCalled();
  });

  it("trims whitespace off workspaceId/fleetInstanceId before forwarding", async () => {
    await POST(req(SECRET, { workspaceId: "  ws-1  ", fleetInstanceId: "  fleet-1  " }));

    expect(mockSelfHeal).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", fleetInstanceId: "fleet-1" })
    );
  });
});

describe("POST /api/v1/fleet/workspace-tokens/self-heal — success", () => {
  it("forwards workspaceId, fleetInstanceId, and the resolved cooldown to selfHealFleetKey", async () => {
    await POST(req(SECRET, { workspaceId: "ws-9", fleetInstanceId: "fleet-host-xyz" }));

    expect(mockSelfHeal).toHaveBeenCalledWith({
      workspaceId: "ws-9",
      fleetInstanceId: "fleet-host-xyz",
      cooldownSeconds: 60,
    });
  });

  it("honors FLEET_SELF_HEAL_COOLDOWN_SECONDS", async () => {
    process.env[COOLDOWN_ENV_KEY] = "120";

    await POST(req(SECRET));

    expect(mockSelfHeal).toHaveBeenCalledWith(
      expect.objectContaining({ cooldownSeconds: 120 })
    );
  });

  it("a non-numeric cooldown env falls back to the default (60s), never disables the guard", async () => {
    process.env[COOLDOWN_ENV_KEY] = "not-a-number";

    await POST(req(SECRET));

    expect(mockSelfHeal).toHaveBeenCalledWith(
      expect.objectContaining({ cooldownSeconds: 60 })
    );
  });

  it("a zero cooldown env falls back to the default rather than disabling the guard", async () => {
    process.env[COOLDOWN_ENV_KEY] = "0";

    await POST(req(SECRET));

    expect(mockSelfHeal).toHaveBeenCalledWith(
      expect.objectContaining({ cooldownSeconds: 60 })
    );
  });

  it("returns 200 with the raw token on success", async () => {
    mockSelfHeal.mockResolvedValue({
      ok: true,
      workspaceId: "ws-1",
      slug: "acme",
      token: "ar_freshtoken",
      keyId: "key-new",
    });

    const res = await POST(req(SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      workspaceId: "ws-1",
      slug: "acme",
      token: "ar_freshtoken",
      keyId: "key-new",
    });
  });
});

describe("POST /api/v1/fleet/workspace-tokens/self-heal — refusals stay 200 with a discriminant", () => {
  it("reports not_found without a 404 or 500 (that status is reserved for auth)", async () => {
    mockSelfHeal.mockResolvedValue({ ok: false, reason: "not_found" });

    const res = await POST(req(SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: false, reason: "not_found" });
  });

  it("reports not_hosted", async () => {
    mockSelfHeal.mockResolvedValue({ ok: false, reason: "not_hosted" });

    const res = await POST(req(SECRET));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: "not_hosted" });
  });

  it("reports cooldown with retryAfterSeconds", async () => {
    mockSelfHeal.mockResolvedValue({ ok: false, reason: "cooldown", retryAfterSeconds: 42 });

    const res = await POST(req(SECRET));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: false, reason: "cooldown", retryAfterSeconds: 42 });
  });
});

describe("POST /api/v1/fleet/workspace-tokens/self-heal — token never logged", () => {
  it("never writes the minted raw token to console.log/warn/error", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const RAW_TOKEN = "ar_super-secret-self-heal-token";
    mockSelfHeal.mockResolvedValue({
      ok: true,
      workspaceId: "ws-1",
      slug: "secretive",
      token: RAW_TOKEN,
      keyId: "key-1",
    });

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
