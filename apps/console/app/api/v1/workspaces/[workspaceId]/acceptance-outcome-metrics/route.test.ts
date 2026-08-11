import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  readAcceptanceOutcomeHistory: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  readAcceptanceOutcomeHistory,
} from "@agentrail/db-postgres";
import { GET } from "./route";

const WORKSPACE_ID = "ws-1";
const FROM = "2026-08-01T00:00:00Z";
const TO = "2026-08-02T00:00:00Z";
const OBSERVED_UNTIL = "2026-08-03T00:00:00Z";

function request(query: Record<string, string | undefined> = {}) {
  const url = new URL("http://localhost/api/v1/workspaces/ws-1/acceptance-outcome-metrics");
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return new NextRequest(url, { method: "GET" });
}

function params() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) };
}

const projection = {
  cohort: {
    from: new Date(FROM),
    to: new Date(TO),
    observedUntil: new Date(OBSERVED_UNTIL),
  },
  counts: {
    eligible: 3,
    approved: 0,
    approvedWithException: 1,
    changesRequested: 0,
    rejected: 0,
    notRecorded: 2,
    excludedUnknown: 4,
    signedMerged: 1,
    deploymentObserved: 0,
    incidentObserved: 1,
    reverted: 0,
  },
  samples: [],
  definitions: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ workspaceId: WORKSPACE_ID } as never);
  vi.mocked(readAcceptanceOutcomeHistory).mockResolvedValue(projection as never);
});

describe("GET /api/v1/workspaces/[workspaceId]/acceptance-outcome-metrics", () => {
  it("rejects unauthenticated and non-member callers", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    expect((await GET(request({ from: FROM, to: TO, observedUntil: OBSERVED_UNTIL }), params())).status).toBe(401);

    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    expect((await GET(request({ from: FROM, to: TO, observedUntil: OBSERVED_UNTIL }), params())).status).toBe(403);
    expect(readAcceptanceOutcomeHistory).not.toHaveBeenCalled();
  });

  it.each([
    { from: "bad", to: TO, observedUntil: OBSERVED_UNTIL },
    { from: "2026-02-30T00:00:00Z", to: TO, observedUntil: OBSERVED_UNTIL },
    { from: TO, to: FROM, observedUntil: OBSERVED_UNTIL },
    { from: FROM, to: TO, observedUntil: "2026-08-01T23:59:59Z" },
    { from: "2025-07-31T00:00:00Z", to: TO, observedUntil: OBSERVED_UNTIL },
    { from: FROM, to: TO, observedUntil: "2027-08-04T00:00:00Z" },
  ])("rejects invalid or unbounded observation windows: %j", async (query) => {
    expect((await GET(request(query), params())).status).toBe(400);
    expect(readAcceptanceOutcomeHistory).not.toHaveBeenCalled();
  });

  it("returns zero, not-recorded, and unknown/excluded counts without collapsing them", async () => {
    const response = await GET(request({ from: FROM, to: TO, observedUntil: OBSERVED_UNTIL }), params());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(readAcceptanceOutcomeHistory).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      from: new Date(FROM),
      to: new Date(TO),
      observedUntil: new Date(OBSERVED_UNTIL),
    });
    expect(await response.json()).toEqual({
      cohort: {
        from: new Date(FROM).toISOString(),
        to: new Date(TO).toISOString(),
        observedUntil: new Date(OBSERVED_UNTIL).toISOString(),
      },
      counts: projection.counts,
    });
  });

  it("returns a sanitized temporary-unavailable response without exposing projection details", async () => {
    vi.mocked(readAcceptanceOutcomeHistory).mockRejectedValue(new Error("database unavailable"));
    const response = await GET(request({ from: FROM, to: TO, observedUntil: OBSERVED_UNTIL }), params());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Acceptance outcome metrics are temporarily unavailable" });
  });
});
