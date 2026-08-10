import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  listChangeRecords: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listChangeRecords } from "@agentrail/db-postgres";
import { GET } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
const USER = "user-1";
const record = {
  id: "00000000-0000-0000-0000-000000000111",
  workspaceId: WS,
  repo: "ada/widgets",
  issueNumber: 42,
  prNumber: 98,
  headShas: ["deadbeef"],
  currentPrHeadSha: "deadbeef",
  currentPrHeadCycleId: "cycle-1",
  currentPrHeadAuthoritative: true,
  mergedSha: null,
  state: "open",
  createdAt: new Date("2026-08-03T12:00:00.000Z"),
  updatedAt: new Date("2026-08-03T12:05:00.000Z"),
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
  vi.mocked(listChangeRecords).mockResolvedValue([record] as never);
});

describe("GET /api/v1/workspaces/[workspaceId]/change-records", () => {
  it("authenticates before listing", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const response = await GET(request(), { params: params() });
    expect(response.status).toBe(401);
    expect(listChangeRecords).not.toHaveBeenCalled();
  });

  it("scopes the list to the workspace and optional repo filter", async () => {
    const response = await GET(
      request(`http://localhost/api/v1/workspaces/${WS}/change-records?repo=ada%2Fwidgets`),
      { params: params() }
    );
    expect(response.status).toBe(200);
    expect(listChangeRecords).toHaveBeenCalledWith({
      workspaceId: WS,
      repo: "ada/widgets",
    });
    expect(await response.json()).toEqual({
      repo: "ada/widgets",
      records: [{
        ...record,
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
      }],
    });
  });
});
