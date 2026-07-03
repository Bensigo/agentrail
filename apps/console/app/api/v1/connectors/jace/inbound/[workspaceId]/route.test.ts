import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// The route imports the REAL kill-switch helpers from the db-postgres barrel.
// We mock `findEnabledJaceWorkspace` + `getConnector` (they touch the DB) but
// keep `jaceInboundAllowed` as the true pure implementation so the reason text
// is exercised for real.
vi.mock("@agentrail/db-postgres", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@agentrail/db-postgres")
  >();
  return {
    ...actual,
    getConnector: vi.fn(),
    findEnabledJaceWorkspace: vi.fn(),
  };
});

import { POST } from "./route";
import { getConnector, findEnabledJaceWorkspace } from "@agentrail/db-postgres";

const mockGetConnector = vi.mocked(getConnector);
const mockFindEnabled = vi.mocked(findEnabledJaceWorkspace);

const WS = "ws-1";

function req(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/connectors/jace/inbound/${WS}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

const params = Promise.resolve({ workspaceId: WS });

// Stub the sidecar fetch so an "allowed" request never needs a live sidecar.
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify({ sessionId: "s-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe("jace inbound route — kill switch", () => {
  it("HALTS and never forwards to the sidecar when the jace connector is DISABLED", async () => {
    // Kill switch active: no enabled jace workspace resolves...
    mockFindEnabled.mockResolvedValue(null);
    // ...and the connector row exists but is disabled (drives the reason text).
    mockGetConnector.mockResolvedValue({
      provider: "jace",
      enabled: false,
      config: {
        repos: [],
        triggerLabel: "",
        pollIntervalSeconds: 60,
      },
      hasSecret: false,
      updatedAt: null,
    } as unknown as Awaited<ReturnType<typeof getConnector>>);

    const res = await POST(req({ message: "hi jace" }), { params });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      halted: true,
      reason: "jace connector is disabled",
    });
    // The critical assertion: a disabled connector NEVER reaches the sidecar.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HALTS when there is NO jace connector at all (never forwards)", async () => {
    mockFindEnabled.mockResolvedValue(null);
    mockGetConnector.mockResolvedValue(null);

    const res = await POST(req({ message: "hi jace" }), { params });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      halted: true,
      reason: "no jace connector for workspace",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("FORWARDS the inbound message to the sidecar when the jace connector is ENABLED", async () => {
    // Kill switch off: an enabled jace workspace resolves.
    mockFindEnabled.mockResolvedValue(WS);

    const res = await POST(req({ message: "hi jace" }), { params });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sessionId: "s-1" });
    // The gate passed, so we forwarded exactly once to the Eve sidecar.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("/eve/v1/session");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("returns 502 (not 500) when the gate passes but the sidecar is unreachable", async () => {
    mockFindEnabled.mockResolvedValue(WS);
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await POST(req({ message: "hi jace" }), { params });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ forwarded: false });
  });
});
