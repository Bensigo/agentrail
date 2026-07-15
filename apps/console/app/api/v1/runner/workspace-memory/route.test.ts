import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  listMemoryItems: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import { GET } from "./route";
import { listMemoryItems } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

const WS = "00000000-0000-0000-0000-000000000001";
const KEY = "k1";
const TEAM = "t1";

function req(withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/workspace-memory", {
    method: "GET",
    headers: withAuth ? { Authorization: "Bearer ar_test" } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireBearer).mockResolvedValue({
    workspaceId: WS,
    apiKeyId: KEY,
    teamId: TEAM,
  } as never);
  vi.mocked(listMemoryItems).mockResolvedValue([] as never);
});

describe("GET /api/v1/runner/workspace-memory", () => {
  it("returns 200 with the workspace's memory items, scoped to the key's workspace", async () => {
    const rows = [
      { id: "m1", source: "human", content: "prefer squash merges", type: "preference" },
      { id: "m2", source: "jace", content: "flag defaults OFF", type: "decision" },
    ];
    vi.mocked(listMemoryItems).mockResolvedValue(rows as never);

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({ id: "m1" });
    // workspace comes from the token, never from input
    expect(listMemoryItems).toHaveBeenCalledWith(WS);
  });

  it("401 when requireBearer rejects, and never touches the DB", async () => {
    const { NextResponse } = await import("next/server");
    vi.mocked(requireBearer).mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as never
    );

    const res = await GET(req(false));
    expect(res.status).toBe(401);
    expect(listMemoryItems).not.toHaveBeenCalled();
  });
});
