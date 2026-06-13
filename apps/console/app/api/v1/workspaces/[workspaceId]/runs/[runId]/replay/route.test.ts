import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { AfkRunEventRecord } from "@agentrail/db-clickhouse";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
}));
vi.mock("@agentrail/db-clickhouse", () => ({
  getAfkRunEvents: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { getAfkRunEvents } from "@agentrail/db-clickhouse";
import { GET } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
const RUN = "run-569";
const USER = "user-1";

function req(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/runs/${RUN}/replay`,
    { method: "GET" }
  );
}

function params() {
  return Promise.resolve({ workspaceId: WS, runId: RUN });
}

function row(overrides: Partial<AfkRunEventRecord> = {}): AfkRunEventRecord {
  return {
    run_id: RUN,
    workspace_id: WS,
    slot: 0,
    event_type: "READ",
    ts: "2026-06-13T10:00:00.000Z",
    payload_json: "{}",
    digest: "aaa",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(getAfkRunEvents).mockResolvedValue([
    row({ slot: 0, event_type: "READ", ts: "2026-06-13T10:00:00.000Z" }),
    row({ slot: 0, event_type: "READ", ts: "2026-06-13T10:00:05.000Z", digest: "bbb" }),
  ] as never);
});

describe("GET /api/v1/workspaces/[workspaceId]/runs/[runId]/replay", () => {
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

  it("AC1: returns replay events and highlights for a run with AFK rows", async () => {
    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      events: [
        {
          ts: "2026-06-13T10:00:00.000Z",
          slot: 0,
          event_type: "READ",
          payload_json: "{}",
          digest: "aaa",
          stall_before_ms: null,
          is_retry: false,
          is_digest_mismatch: false,
        },
        {
          ts: "2026-06-13T10:00:05.000Z",
          slot: 0,
          event_type: "READ",
          payload_json: "{}",
          digest: "bbb",
          stall_before_ms: 5000,
          is_retry: true,
          is_digest_mismatch: true,
        },
      ],
      highlights: {
        longest_stall_ms: 5000,
        longest_stall_slot: 0,
        retry_loops: [{ slot: 0, event_type: "READ", count: 2 }],
        digest_mismatches: [{ ts: "2026-06-13T10:00:05.000Z", slot: 0 }],
      },
    });
    expect(getAfkRunEvents).toHaveBeenCalledWith(WS, RUN);
  });

  it("AC2: returns an empty replay shape when the run has no AFK rows", async () => {
    vi.mocked(getAfkRunEvents).mockResolvedValue([]);

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      events: [],
      highlights: {
        longest_stall_ms: null,
        longest_stall_slot: null,
        retry_loops: [],
        digest_mismatches: [],
      },
    });
  });

  it("500 when the ClickHouse query fails", async () => {
    vi.mocked(getAfkRunEvents).mockRejectedValue(new Error("CH down"));

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Failed to load replay timeline",
    });
  });
});
