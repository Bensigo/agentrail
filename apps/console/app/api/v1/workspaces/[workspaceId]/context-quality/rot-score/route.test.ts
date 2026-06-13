import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
}));
vi.mock("../../../../../../../lib/rot-scorer", () => ({
  getRotScore: vi.fn(),
}));

import { GET } from "./route";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { getRotScore } from "../../../../../../../lib/rot-scorer";

const WS = "00000000-0000-0000-0000-000000000001";
const USER = "user-1";

function req(search = "") {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/context-quality/rot-score${search}`,
    { method: "GET" }
  );
}

function params() {
  return Promise.resolve({ workspaceId: WS });
}

const sampleResult = {
  rot_score: 42,
  contributors: [
    {
      type: "memory_item" as const,
      id: "mem-1",
      label: "docs/context.md",
      staleness_days: 35,
      score_contribution: 15,
    },
    {
      type: "index_snapshot" as const,
      id: "repo-1",
      label: "main-repo",
      staleness_days: 20,
      score_contribution: 20,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(getRotScore).mockResolvedValue(sampleResult);
});

describe("GET /api/v1/workspaces/[workspaceId]/context-quality/rot-score", () => {
  it("401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("403 when user not a member", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("200 with rot_score and contributors", async () => {
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.rot_score).toBe("number");
    expect(Array.isArray(json.contributors)).toBe(true);
    expect(json.rot_score).toBe(42);
    expect(json.contributors).toHaveLength(2);
    expect(getRotScore).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS })
    );
  });

  it("400 when asOf is invalid ISO date", async () => {
    const res = await GET(req("?asOf=not-a-date"), { params: params() });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("400 when thresholdDays is non-numeric", async () => {
    const res = await GET(req("?thresholdDays=abc"), { params: params() });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("400 when thresholdDays is a float", async () => {
    const res = await GET(req("?thresholdDays=30.5"), { params: params() });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("502 on DB error", async () => {
    vi.mocked(getRotScore).mockRejectedValue(new Error("DB down"));
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("passes repositoryId when provided", async () => {
    const res = await GET(req("?repositoryId=repo-1"), { params: params() });
    expect(res.status).toBe(200);
    expect(getRotScore).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryId: "repo-1" })
    );
  });

  it("passes thresholdDays when provided", async () => {
    const res = await GET(req("?thresholdDays=60"), { params: params() });
    expect(res.status).toBe(200);
    expect(getRotScore).toHaveBeenCalledWith(
      expect.objectContaining({ thresholdDays: 60 })
    );
  });

  it("passes asOf when provided", async () => {
    const asOf = "2026-01-01T00:00:00.000Z";
    const res = await GET(req(`?asOf=${asOf}`), { params: params() });
    expect(res.status).toBe(200);
    expect(getRotScore).toHaveBeenCalledWith(
      expect.objectContaining({ asOf: new Date(asOf) })
    );
  });
});
