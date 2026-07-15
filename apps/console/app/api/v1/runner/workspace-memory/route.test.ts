import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  retrieveMemory: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import { GET } from "./route";
import { retrieveMemory } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

const WS = "00000000-0000-0000-0000-000000000001";
const KEY = "k1";
const TEAM = "t1";

function req(query?: string, withAuth = true): NextRequest {
  const qs = query === undefined ? "" : `?query=${encodeURIComponent(query)}`;
  return new NextRequest(`http://localhost/api/v1/runner/workspace-memory${qs}`, {
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
  vi.mocked(retrieveMemory).mockResolvedValue([] as never);
});

describe("GET /api/v1/runner/workspace-memory", () => {
  it("returns 200 with retrieveMemory's ranked items, scoped to the key's workspace + the query", async () => {
    const rows = [
      { id: "m1", source: "human", content: "prefer squash merges", type: "preference" },
      { id: "m2", source: "jace", content: "flag defaults OFF", type: "decision" },
    ];
    vi.mocked(retrieveMemory).mockResolvedValue(rows as never);

    const res = await GET(req("merge strategy"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({ id: "m1" });
    // workspace comes from the token, never from input; the query rides through.
    expect(retrieveMemory).toHaveBeenCalledWith(
      WS,
      "merge strategy",
      expect.objectContaining({ k: expect.any(Number) })
    );
  });

  it("passes an empty string to retrieveMemory when query is missing", async () => {
    const res = await GET(req(undefined));
    expect(res.status).toBe(200);
    expect(retrieveMemory).toHaveBeenCalledWith(WS, "", expect.any(Object));
  });

  it("401 when requireBearer rejects, and never touches the DB", async () => {
    const { NextResponse } = await import("next/server");
    vi.mocked(requireBearer).mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as never
    );

    const res = await GET(req("anything", false));
    expect(res.status).toBe(401);
    expect(retrieveMemory).not.toHaveBeenCalled();
  });

  it("502 when the store errors", async () => {
    vi.mocked(retrieveMemory).mockRejectedValue(new Error("pg down"));
    const res = await GET(req("merge strategy"));
    expect(res.status).toBe(502);
  });
});
