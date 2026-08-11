import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  readAcceptanceRecordSummaries: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, readAcceptanceRecordSummaries } from "@agentrail/db-postgres";
import { GET } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
const USER = "user-1";
const record = {
  recordId: "00000000-0000-4000-8000-000000000111",
  workspaceId: WS,
  repo: "ada/widgets",
  issueNumber: 42,
  createdAt: new Date("2026-08-03T12:00:00.000Z"),
  updatedAt: new Date("2026-08-03T12:05:00.000Z"),
  requestedWork: { kind: "unknown" as const },
  suppliedContext: { kind: "unknown" as const },
  pullRequest: { kind: "not_attached" as const },
  proof: { kind: "unknown" as const },
  unknownReasons: ["requested_work_not_confirmed" as const],
  neededDecision: {
    kind: "recorded" as const,
    eventId: "00000000-0000-4000-8000-000000000201",
    decision: "approved_with_exception" as const,
    decidedAt: new Date("2026-08-03T12:03:00.000Z"),
  },
  outcome: {
    kind: "signed_merge" as const,
    mergeEventId: "00000000-0000-4000-8000-000000000202",
    mergeSha: "a".repeat(40),
    mergedAt: new Date("2026-08-03T12:04:00.000Z"),
    decisionAlignment: "aligned" as const,
    postMerge: {
      deployment: "not_recorded" as const,
      incident: "not_recorded" as const,
      revert: "not_recorded" as const,
    },
  },
};

function request(url = `http://localhost/api/v1/workspaces/${WS}/change-records`) {
  return new NextRequest(url, { method: "GET" });
}

function params() {
  return Promise.resolve({ workspaceId: WS });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(readAcceptanceRecordSummaries).mockResolvedValue({
    kind: "records",
    records: [record],
  } as never);
});

describe("GET /api/v1/workspaces/[workspaceId]/change-records", () => {
  it("authenticates before listing", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const response = await GET(request(), { params: params() });
    expect(response.status).toBe(401);
    expect(readAcceptanceRecordSummaries).not.toHaveBeenCalled();
  });

  it("scopes the canonical server summary to the member workspace and optional repo filter", async () => {
    const response = await GET(
      request(`http://localhost/api/v1/workspaces/${WS}/change-records?repo=%20ada%2Fwidgets%20`),
      { params: params() }
    );
    expect(response.status).toBe(200);
    expect(readAcceptanceRecordSummaries).toHaveBeenCalledWith({
      workspaceId: WS,
      repo: "ada/widgets",
    });
    expect(await response.json()).toEqual({
      kind: "records",
      records: [{
        ...record,
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
        neededDecision: {
          ...record.neededDecision,
          decidedAt: record.neededDecision.decidedAt.toISOString(),
        },
        outcome: {
          ...record.outcome,
          mergedAt: record.outcome.mergedAt.toISOString(),
        },
      }],
    });
  });

  it("rejects an invalid repo filter before calling the exact DB input", async () => {
    const response = await GET(
      request(`http://localhost/api/v1/workspaces/${WS}/change-records?repo=..%2Fwidgets`),
      { params: params() },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid repository filter" });
    expect(readAcceptanceRecordSummaries).not.toHaveBeenCalled();
  });

  it("rejects repeated repo filters instead of selecting one implicitly", async () => {
    const response = await GET(
      request(`http://localhost/api/v1/workspaces/${WS}/change-records?repo=ada%2Fwidgets&repo=ada%2Fother`),
      { params: params() },
    );

    expect(response.status).toBe(400);
    expect(readAcceptanceRecordSummaries).not.toHaveBeenCalled();
  });

  it("derives workspace access before parsing or reading the filter", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);

    const response = await GET(request(), { params: params() });

    expect(response.status).toBe(403);
    expect(readAcceptanceRecordSummaries).not.toHaveBeenCalled();
  });
});
