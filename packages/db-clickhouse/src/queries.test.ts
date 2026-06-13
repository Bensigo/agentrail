import { describe, it, expect } from "vitest";
import {
  deriveSnapshotEventId,
  deriveContextPackId,
  getRunTelemetryHealth,
  listCostAnomalies,
} from "./queries";

function fakeQueryClient(responses: Array<Record<string, unknown>[]>) {
  const calls: Array<{
    query: string;
    query_params?: Record<string, unknown>;
    format: "JSONEachRow";
  }> = [];
  return {
    calls,
    client: {
      async query(args: {
        query: string;
        query_params?: Record<string, unknown>;
        format: "JSONEachRow";
      }) {
        calls.push(args);
        const rows = responses.shift() ?? [];
        return {
          async json<T>() {
            return rows as T[];
          },
        };
      },
    },
  };
}

describe("deriveSnapshotEventId", () => {
  it("is deterministic for the same inputs", () => {
    const a = deriveSnapshotEventId("ws", "repo", "abc123", "2026-06-12T00:00:00.000Z");
    const b = deriveSnapshotEventId("ws", "repo", "abc123", "2026-06-12T00:00:00.000Z");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });

  it("differs when any field differs", () => {
    const base = deriveSnapshotEventId("ws", "repo", "abc123", "2026-06-12T00:00:00.000Z");
    expect(deriveSnapshotEventId("ws", "repo", "abc123", "2026-06-12T00:00:01.000Z")).not.toBe(base);
    expect(deriveSnapshotEventId("ws", "repo2", "abc123", "2026-06-12T00:00:00.000Z")).not.toBe(base);
    expect(deriveSnapshotEventId("ws2", "repo", "abc123", "2026-06-12T00:00:00.000Z")).not.toBe(base);
    expect(deriveSnapshotEventId("ws", "repo", "def456", "2026-06-12T00:00:00.000Z")).not.toBe(base);
  });
});

describe("deriveContextPackId", () => {
  it("is deterministic for the same inputs", () => {
    const a = deriveContextPackId("ws", "run-1", "2026-06-12T00:00:00.000Z");
    const b = deriveContextPackId("ws", "run-1", "2026-06-12T00:00:00.000Z");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });

  it("differs when any field differs", () => {
    const base = deriveContextPackId("ws", "run-1", "2026-06-12T00:00:00.000Z");
    expect(deriveContextPackId("ws", "run-1", "2026-06-12T00:00:01.000Z")).not.toBe(base);
    expect(deriveContextPackId("ws", "run-2", "2026-06-12T00:00:00.000Z")).not.toBe(base);
    expect(deriveContextPackId("ws2", "run-1", "2026-06-12T00:00:00.000Z")).not.toBe(base);
  });
});

describe("getRunTelemetryHealth", () => {
  it("returns exactly eight stable signal rows", async () => {
    const { client } = fakeQueryClient([
      [{ occurred_at: "2026-06-13 08:00:00.000" }],
      [{ count: 1 }],
      [{ count: 0 }],
      [{ count: 1 }],
      [{ count: 0 }],
      [{ count: 1 }],
      [{ count: 0 }],
      [{ count: 1 }],
    ]);

    const signals = await getRunTelemetryHealth("ws-1", "run-1", client);

    expect(signals).toEqual([
      { signal: "run_start", present: true, missing_since: null },
      { signal: "context_pack", present: true, missing_since: null },
      {
        signal: "cost_event",
        present: false,
        missing_since: "2026-06-13T08:00:00.000Z",
      },
      { signal: "review_gate", present: true, missing_since: null },
      {
        signal: "failure_event",
        present: false,
        missing_since: "2026-06-13T08:00:00.000Z",
      },
      { signal: "memory_items", present: true, missing_since: null },
      { signal: "index_snapshot", present: true, missing_since: null },
      {
        signal: "outbox_flush",
        present: false,
        missing_since: "2026-06-13T08:00:00.000Z",
      },
    ]);
  });

  it("returns eight absent signals when ClickHouse has no rows for the run", async () => {
    const { client, calls } = fakeQueryClient([
      [],
      [{ count: 0 }],
      [{ count: 0 }],
      [{ count: 0 }],
      [{ count: 0 }],
      [{ count: 0 }],
      [{ count: 0 }],
    ]);

    const signals = await getRunTelemetryHealth("ws-1", "missing-run", client);

    expect(signals).toHaveLength(8);
    expect(signals.every((signal) => signal.present === false)).toBe(true);
    expect(signals.every((signal) => signal.missing_since === null)).toBe(true);
    expect(calls).toHaveLength(7);
  });
});

describe("listCostAnomalies", () => {
  it("maps cost_anomaly run events and forwards time filters", async () => {
    const { client, calls } = fakeQueryClient([
      [
        {
          run_id: "run-1",
          repository_id: "repo-1",
          phase: "execute",
          occurred_at: "2026-06-13 08:00:00.000",
          payload: JSON.stringify({
            model: "gpt-5.5",
            cost_usd: "12.5",
            mean: 3.1,
            stddev: "1.2",
            deviation_sigmas: "7.83",
          }),
        },
      ],
    ]);

    const anomalies = await listCostAnomalies(
      "ws-1",
      {
        timeFrom: new Date("2026-06-13T08:00:00.000Z"),
        timeTo: new Date("2026-06-13T09:00:00.000Z"),
      },
      client
    );

    expect(anomalies).toEqual([
      {
        run_id: "run-1",
        model: "gpt-5.5",
        phase: "execute",
        repository_id: "repo-1",
        cost_usd: 12.5,
        mean: 3.1,
        stddev: 1.2,
        deviation_sigmas: 7.83,
        occurred_at: "2026-06-13T08:00:00.000Z",
      },
    ]);
    expect(calls[0]?.query).toContain("event_type = 'cost_anomaly'");
    expect(calls[0]?.query_params).toEqual({
      workspaceId: "ws-1",
      timeFrom: "2026-06-13 08:00:00.000",
      timeTo: "2026-06-13 09:00:00.000",
    });
  });
});
