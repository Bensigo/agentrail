import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
}));
vi.mock("@agentrail/db-clickhouse", () => ({
  AgentBehaviorLinter: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { AgentBehaviorLinter } from "@agentrail/db-clickhouse";
import { GET } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
const RUN = "run-554";
const USER = "user-1";

function req(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/runs/${RUN}/behavior-lint`,
    { method: "GET" }
  );
}

function params() {
  return Promise.resolve({ workspaceId: WS, runId: RUN });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(AgentBehaviorLinter).mockResolvedValue([
    {
      rule: "full_file_read",
      severity: "warning",
      evidence_event_id: "evt-full",
    },
  ] as never);
});

describe("GET /api/v1/workspaces/[workspaceId]/runs/[runId]/behavior-lint", () => {
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

  it("200 with findings from AgentBehaviorLinter", async () => {
    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      findings: [
        {
          rule: "full_file_read",
          severity: "warning",
          evidence_event_id: "evt-full",
        },
      ],
    });
    expect(AgentBehaviorLinter).toHaveBeenCalledWith(WS, RUN);
  });

  it("500 when ClickHouse query fails", async () => {
    vi.mocked(AgentBehaviorLinter).mockRejectedValue(new Error("CH down"));

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Failed to load behavior findings",
    });
  });
});
