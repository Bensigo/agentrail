import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  getProductionHumanFalseGreen: vi.fn(),
  getWorkspaceMembership: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import {
  getProductionHumanFalseGreen,
  getWorkspaceMembership,
} from "@agentrail/db-postgres";
import { GET } from "./route";

const WORKSPACE_ID = "ws-1";
const FROM = "2026-08-01T00:00:00Z";
const TO = "2026-08-02T00:00:00Z";
const OBSERVED_UNTIL = "2026-08-03T00:00:00Z";

function request(query: Record<string, string | undefined> = {}) {
  const url = new URL(
    "http://localhost/api/v1/workspaces/ws-1/review-metrics/human-false-green"
  );
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return new NextRequest(url, { method: "GET" });
}

function params() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ workspaceId: WORKSPACE_ID } as never);
  vi.mocked(getProductionHumanFalseGreen).mockResolvedValue({
    dateRange: { from: new Date(FROM), to: new Date(TO) },
    observedUntil: new Date(OBSERVED_UNTIL),
    successfulRuns: 3,
    knownSampleSize: 1,
    falseGreenCount: 1,
    falseGreenRate: 1,
    unknown: {
      missingPr: 1,
      missingPublishedHead: 0,
      malformedPr: 0,
      noMatchingHumanOutcome: 1,
    },
    limitations: ["explicit human outcomes only"],
  } as never);
});

describe("GET /api/v1/workspaces/[workspaceId]/review-metrics/human-false-green", () => {
  it("returns 401 without a session", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    expect((await GET(request({ from: FROM, to: TO }), params())).status).toBe(401);
  });

  it("returns 403 for a non-member", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    expect((await GET(request({ from: FROM, to: TO }), params())).status).toBe(403);
  });

  it.each([
    { from: "not-a-date", to: TO },
    { from: FROM, to: FROM },
    { from: FROM, to: TO, observedUntil: "not-a-date" },
    { from: FROM, to: TO, observedUntil: "2026-08-01T12:00:00Z" },
  ])("returns 400 for an invalid report window: %j", async (query) => {
    const response = await GET(request(query), params());
    expect(response.status).toBe(400);
    expect(getProductionHumanFalseGreen).not.toHaveBeenCalled();
  });

  it("returns dated rates with explicit unknown reason counts", async () => {
    const response = await GET(
      request({ from: FROM, to: TO, observedUntil: OBSERVED_UNTIL }),
      params()
    );

    expect(response.status).toBe(200);
    expect(getProductionHumanFalseGreen).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      from: new Date(FROM),
      to: new Date(TO),
      observedUntil: new Date(OBSERVED_UNTIL),
    });
    expect(await response.json()).toMatchObject({
      dateRange: {
        from: new Date(FROM).toISOString(),
        to: new Date(TO).toISOString(),
      },
      observedUntil: new Date(OBSERVED_UNTIL).toISOString(),
      falseGreenRate: 1,
      unknown: { missingPr: 1, noMatchingHumanOutcome: 1 },
    });
  });
});
