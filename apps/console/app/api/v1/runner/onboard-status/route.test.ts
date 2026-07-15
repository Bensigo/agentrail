import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getLatestOnboardMemoryAt: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import { GET } from "./route";
import { getLatestOnboardMemoryAt } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

const WS = "00000000-0000-0000-0000-000000000001";
const KEY = "k1";
const TEAM = "t1";
const REPO = "acme/widgets";

function req(repo?: string, withAuth = true): NextRequest {
  const qs = repo === undefined ? "" : `?repo=${encodeURIComponent(repo)}`;
  return new NextRequest(`http://localhost/api/v1/runner/onboard-status${qs}`, {
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
  vi.mocked(getLatestOnboardMemoryAt).mockResolvedValue({
    onboardedAt: null,
    count: 0,
  } as never);
});

describe("GET /api/v1/runner/onboard-status (#1149)", () => {
  it("401 when requireBearer rejects, and never touches the store", async () => {
    const { NextResponse } = await import("next/server");
    vi.mocked(requireBearer).mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as never
    );
    const res = await GET(req(REPO, false));
    expect(res.status).toBe(401);
    expect(getLatestOnboardMemoryAt).not.toHaveBeenCalled();
  });

  it("400 when repo is missing, and never touches the store", async () => {
    const res = await GET(req(undefined));
    expect(res.status).toBe(400);
    expect(getLatestOnboardMemoryAt).not.toHaveBeenCalled();
  });

  it("200 with an ISO onboardedAt + count when notes exist", async () => {
    const onboardedAt = new Date("2026-07-15T12:34:56.000Z");
    vi.mocked(getLatestOnboardMemoryAt).mockResolvedValue({
      onboardedAt,
      count: 7,
    } as never);

    const res = await GET(req(REPO));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      onboardedAt: "2026-07-15T12:34:56.000Z",
      count: 7,
    });
    // Scoped to the key's workspace + the query's repo.
    expect(getLatestOnboardMemoryAt).toHaveBeenCalledWith(WS, REPO);
  });

  it("200 with onboardedAt: null when the repo was never onboarded", async () => {
    vi.mocked(getLatestOnboardMemoryAt).mockResolvedValue({
      onboardedAt: null,
      count: 0,
    } as never);

    const res = await GET(req(REPO));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ onboardedAt: null, count: 0 });
    expect(getLatestOnboardMemoryAt).toHaveBeenCalledWith(WS, REPO);
  });

  it("502 when the store errors", async () => {
    vi.mocked(getLatestOnboardMemoryAt).mockRejectedValue(new Error("pg down"));
    const res = await GET(req(REPO));
    expect(res.status).toBe(502);
  });
});
