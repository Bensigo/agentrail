import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-clickhouse", () => ({
  insertFlightRecorderEvents: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import { POST } from "./route";
import { insertFlightRecorderEvents } from "@agentrail/db-clickhouse";
import { requireBearer } from "../../../../../lib/bearer-auth";

const WS = "00000000-0000-0000-0000-000000000001";
const KEY = "k1";
const TEAM = "t1";

function req(body: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/ingest/afk-events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(withAuth ? { Authorization: "Bearer ar_test" } : {}),
    },
    body: JSON.stringify(body),
  });
}

function makeEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    v: 1,
    session: "sess-abc123",
    seq: 1,
    ts: "2026-06-13T10:00:00.000Z",
    kind: "action",
    action: { type: "TOOL_CALL", slot: 0 },
    digest: "deadbeef",
    ...overrides,
  };
}

function makeBatch(n: number) {
  return Array.from({ length: n }, (_, i) =>
    makeEvent({ seq: i + 1, ts: `2026-06-13T10:00:0${String(i).padStart(1, "0")}.000Z` })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireBearer).mockResolvedValue({
    workspaceId: WS,
    apiKeyId: KEY,
    teamId: TEAM,
  } as never);
  vi.mocked(insertFlightRecorderEvents).mockResolvedValue({ accepted: 0, duplicate: 0 });
});

describe("POST /api/v1/ingest/afk-events", () => {
  // AC4: missing/invalid bearer → 401
  it("401 when requireBearer rejects", async () => {
    const { NextResponse } = await import("next/server");
    vi.mocked(requireBearer).mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as never
    );
    const res = await POST(req(makeEvent(), false));
    expect(res.status).toBe(401);
  });

  // AC1: 5-event batch → 202 { accepted: 5, duplicate: 0 }
  it("202 { accepted: 5, duplicate: 0 } on first ingestion", async () => {
    vi.mocked(insertFlightRecorderEvents).mockResolvedValue({ accepted: 5, duplicate: 0 });
    const res = await POST(req(makeBatch(5)));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 5, duplicate: 0 });
  });

  // AC2: replay same batch → 202 { accepted: 0, duplicate: 5 }
  it("AC6 idempotency: replaying the same batch returns duplicate: N", async () => {
    // Stateful mock: tracks seen (session, ts, slot) keys.
    const seen = new Set<string>();
    vi.mocked(insertFlightRecorderEvents).mockImplementation(async (events) => {
      let accepted = 0;
      let duplicate = 0;
      for (const ev of events) {
        const slot = (ev.action?.slot as number | undefined) ?? 0;
        const key = `${ev.session}|${ev.ts}|${slot}`;
        if (seen.has(key)) {
          duplicate++;
        } else {
          seen.add(key);
          accepted++;
        }
      }
      return { accepted, duplicate };
    });

    const batch = makeBatch(5);

    // First POST: all accepted.
    const first = await POST(req(batch));
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ accepted: 5, duplicate: 0 });

    // Second POST (replay): all duplicates.
    const second = await POST(req(batch));
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ accepted: 0, duplicate: 5 });

    // insert function was called twice.
    expect(insertFlightRecorderEvents).toHaveBeenCalledTimes(2);
  });

  // AC3: >100 events → 400
  it("400 when batch exceeds 100 events", async () => {
    const res = await POST(req(makeBatch(101)));
    expect(res.status).toBe(400);
    expect(insertFlightRecorderEvents).not.toHaveBeenCalled();
  });

  // AC5: workspace_id comes from bearer context, not request body
  it("uses workspace_id from bearer context, not request body", async () => {
    vi.mocked(insertFlightRecorderEvents).mockResolvedValue({ accepted: 1, duplicate: 0 });
    const eventWithFakeWs = { ...makeEvent(), workspace_id: "attacker-ws" };
    await POST(req(eventWithFakeWs));
    expect(insertFlightRecorderEvents).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ workspace_id: WS }),
      ])
    );
    // Ensure no call used the attacker workspace.
    const calls = vi.mocked(insertFlightRecorderEvents).mock.calls;
    for (const [events] of calls) {
      for (const ev of events) {
        expect(ev.workspace_id).toBe(WS);
        expect(ev.workspace_id).not.toBe("attacker-ws");
      }
    }
  });

  it("400 on invalid event schema (missing required field)", async () => {
    const res = await POST(req({ session: "x", seq: 1, ts: "2026-01-01T00:00:00Z" }));
    expect(res.status).toBe(400);
  });

  it("400 on empty array", async () => {
    const res = await POST(req([]));
    expect(res.status).toBe(400);
  });

  it("202 for single event (non-array body)", async () => {
    vi.mocked(insertFlightRecorderEvents).mockResolvedValue({ accepted: 1, duplicate: 0 });
    const res = await POST(req(makeEvent()));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1, duplicate: 0 });
  });
});
