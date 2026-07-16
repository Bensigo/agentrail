import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  listQueueEntries: vi.fn(),
  listRunsWithCursor: vi.fn(),
}));
vi.mock("@agentrail/db-clickhouse", () => ({
  aggregateWorkspaceCosts: vi.fn(),
}));

import { GET } from "./route";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  listQueueEntries,
  listRunsWithCursor,
} from "@agentrail/db-postgres";
import { aggregateWorkspaceCosts } from "@agentrail/db-clickhouse";

const WS = "00000000-0000-0000-0000-000000000001";
const USER = "user-1";

function req(search = ""): NextRequest {
  return new NextRequest(`http://localhost/api/v1/workspaces/${WS}/digest${search}`, {
    method: "GET",
  });
}
function params() {
  return Promise.resolve({ workspaceId: WS });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(listRunsWithCursor).mockResolvedValue({ runs: [], nextCursor: null });
  vi.mocked(listQueueEntries).mockResolvedValue([]);
  vi.mocked(aggregateWorkspaceCosts).mockResolvedValue([]);
});

describe("GET /api/v1/workspaces/[workspaceId]/digest", () => {
  it("401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(401);
  });

  it("403 when not a workspace member", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(403);
  });

  it("400 when week is not a valid date", async () => {
    const res = await GET(req("?week=not-a-date"), { params: params() });
    expect(res.status).toBe(400);
  });

  it("returns the four-block digest payload on a happy path (AC1)", async () => {
    vi.mocked(listRunsWithCursor).mockResolvedValue({
      runs: [
        {
          id: "r1",
          workspaceId: WS,
          repositoryId: "repo-1",
          agent: "claude",
          branch: "feat/x",
          title: "Ship the thing",
          status: "success",
          startedAt: new Date("2026-07-14T09:00:00.000Z"),
          finishedAt: new Date("2026-07-14T10:00:00.000Z"),
          createdAt: new Date("2026-07-14T09:00:00.000Z"),
          prUrl: "https://github.com/acme/repo/pull/7",
        },
      ],
      nextCursor: null,
    } as never);
    vi.mocked(listQueueEntries).mockImplementation((async (
      _workspaceId: string,
      opts?: { states?: string[] }
    ) => {
      if (opts?.states?.includes("running")) {
        return [
          {
            id: "qe1",
            externalId: "acme/repo#9",
            title: "Add retries",
            tier: 0,
            remainingBudget: 2,
            state: "running",
            updatedAt: "2026-07-15T00:00:00.000Z",
          },
        ];
      }
      if (opts?.states?.includes("parked")) {
        return [
          {
            id: "qe2",
            externalId: "acme/repo#3",
            title: "Blocked issue",
            tier: 0,
            remainingBudget: 1,
            state: "parked",
            updatedAt: "2026-07-15T00:00:00.000Z",
          },
          {
            id: "qe3",
            externalId: "acme/repo#4",
            title: "Escalated issue",
            tier: 1,
            remainingBudget: 0,
            state: "escalated-to-human",
            updatedAt: "2026-07-15T00:00:00.000Z",
          },
        ];
      }
      return [];
    }) as never);
    vi.mocked(aggregateWorkspaceCosts).mockResolvedValue([
      { total_cost_usd: 12.5 } as never,
    ]);

    const res = await GET(req("?week=2026-07-15"), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.shipped).toEqual([
      {
        id: "r1",
        title: "Ship the thing",
        prUrl: "https://github.com/acme/repo/pull/7",
        finishedAt: "2026-07-14T10:00:00.000Z",
      },
    ]);
    expect(json.inProgress).toEqual([
      { id: "qe1", title: "Add retries", state: "running" },
    ]);
    expect(json.needsYou).toEqual({
      count: 2,
      breakdown: { escalatedToHuman: 1, parked: 1 },
    });
    expect(json.cost.thisWeekUsd).toBeCloseTo(12.5);
    expect(json.week).toEqual({
      start: "2026-07-13T00:00:00.000Z",
      end: "2026-07-20T00:00:00.000Z",
    });
  });

  it("fetches in-progress and needs-you with distinct, targeted state filters", async () => {
    await GET(req(), { params: params() });
    const calls = vi.mocked(listQueueEntries).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toEqual({ states: ["queued", "running"] });
    expect(calls[1][1]).toEqual({ states: ["escalated-to-human", "parked"] });
  });

  it("degrades cost to null instead of 500ing when ClickHouse throws (AC1)", async () => {
    vi.mocked(aggregateWorkspaceCosts).mockRejectedValue(new Error("ClickHouse down"));

    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.cost).toEqual({
      thisWeekUsd: null,
      previousWeekUsd: null,
      trendPct: null,
    });
  });

  it("returns empty-but-valid blocks for a quiet week (AC4)", async () => {
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.shipped).toEqual([]);
    expect(json.inProgress).toEqual([]);
    expect(json.needsYou).toEqual({ count: 0, breakdown: { escalatedToHuman: 0, parked: 0 } });
  });
});
