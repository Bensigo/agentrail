import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  getRequirementDecisionReport: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import {
  getRequirementDecisionReport,
  getWorkspaceMembership,
} from "@agentrail/db-postgres";
import { GET } from "./route";

const mockAuth = vi.mocked(auth);
const mockMembership = vi.mocked(getWorkspaceMembership);
const mockReport = vi.mocked(getRequirementDecisionReport);

function request(url: string) {
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);
  mockMembership.mockResolvedValue({ role: "owner" } as never);
  mockReport.mockResolvedValue({
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-09-01T00:00:00.000Z",
    workspaceId: "ws-1",
    evaluatedDenominator: 0,
    refusalCount: 0,
    refusalRate: null,
    overrideCount: 0,
    overrideDenominator: 0,
    overrideRate: null,
    falseRefusalCount: 0,
    falseRefusalDenominator: 0,
    falseRefusalRate: null,
    falseAcceptCount: 0,
    falseAcceptDenominator: 0,
    falseAcceptRate: null,
    unknownFinalOutcomeCount: 0,
    nullTaskFamilyCount: 0,
    byTaskFamily: [],
  });
});

describe("GET requirement-decision report (#1583)", () => {
  it("requires membership and passes the requested half-open date range", async () => {
    const response = await GET(
      request(
        "http://localhost/api/v1/workspaces/ws-1/requirement-decisions?time_from=2026-08-01T00:00:00.000Z&time_to=2026-09-01T00:00:00.000Z"
      ),
      { params: Promise.resolve({ workspaceId: "ws-1" }) }
    );

    expect(response.status).toBe(200);
    expect(mockReport).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      from: new Date("2026-08-01T00:00:00.000Z"),
      to: new Date("2026-09-01T00:00:00.000Z"),
    });
  });

  it("returns 400 for an invalid date and never queries the report", async () => {
    const response = await GET(
      request("http://localhost/api/v1/workspaces/ws-1/requirement-decisions?time_from=nope"),
      { params: Promise.resolve({ workspaceId: "ws-1" }) }
    );

    expect(response.status).toBe(400);
    expect(mockReport).not.toHaveBeenCalled();
  });

  it("returns the report's null rates unchanged", async () => {
    const response = await GET(
      request("http://localhost/api/v1/workspaces/ws-1/requirement-decisions"),
      { params: Promise.resolve({ workspaceId: "ws-1" }) }
    );

    const body = await response.json();
    expect(body.falseRefusalRate).toBeNull();
    expect(body.falseAcceptRate).toBeNull();
    expect(body.overrideRate).toBeNull();
  });
});
