import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
}));
vi.mock("@agentrail/db-clickhouse", () => ({
  listFailureClusters: vi.fn(),
}));

import { GET } from "./route";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { listFailureClusters } from "@agentrail/db-clickhouse";

const WS = "00000000-0000-0000-0000-000000000001";
const USER = "user-1";

function req(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/failures/clusters`,
    { method: "GET" }
  );
}

function params() {
  return Promise.resolve({ workspaceId: WS });
}

const sampleClusters = [
  {
    fingerprint: "sha256:abc",
    phase: "execute",
    failure_type: "test_error",
    count: 3,
    first_seen: "2026-06-13T08:00:00.000Z",
    last_seen: "2026-06-13T08:05:00.000Z",
    run_ids: ["run-a", "run-b", "run-c"],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(listFailureClusters).mockResolvedValue(sampleClusters as never);
});

describe("GET /api/v1/workspaces/[workspaceId]/failures/clusters", () => {
  it("401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(401);
  });

  it("403 when user is not a workspace member", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(403);
  });

  it("200 with cluster array for workspace members", async () => {
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sampleClusters);
    expect(listFailureClusters).toHaveBeenCalledWith(WS);
  });
});
