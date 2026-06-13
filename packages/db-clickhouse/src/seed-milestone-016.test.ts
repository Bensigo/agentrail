import { describe, expect, it } from "vitest";
import {
  buildMilestone016Fixtures,
  MILESTONE_016_COST_ANOMALY_RUN_ID,
  MILESTONE_016_MISSING_COST_RUN_ID,
  seedMilestone016Fixtures,
  type Milestone016SeedTable,
} from "./seed-milestone-016";

function fakeSeedClient() {
  const idColumns: Record<Milestone016SeedTable, string> = {
    run_events: "event_id",
    cost_events: "event_id",
    failure_events: "event_id",
    context_packs: "context_pack_id",
    context_events: "context_pack_id",
    index_snapshots: "event_id",
  };
  const inserted = new Map<Milestone016SeedTable, Set<string>>(
    Object.keys(idColumns).map((table) => [
      table as Milestone016SeedTable,
      new Set<string>(),
    ])
  );
  const inserts: Array<{ table: Milestone016SeedTable; values: unknown[] }> = [];

  return {
    inserts,
    client: {
      async query({
        query,
        query_params,
      }: {
        query: string;
        query_params?: Record<string, unknown>;
        format: "JSONEachRow";
      }) {
        const table = (Object.keys(idColumns) as Milestone016SeedTable[]).find(
          (candidate) => query.includes(`FROM ${candidate}`)
        );
        if (!table) throw new Error(`Unexpected query: ${query}`);

        const requested =
          (query_params?.eventIds as string[] | undefined) ??
          (query_params?.packIds as string[] | undefined) ??
          [];
        const column = idColumns[table];
        const rows = requested
          .filter((id) => inserted.get(table)?.has(id))
          .map((id) => ({ [column]: id }));

        return {
          async json<T>() {
            return rows as T[];
          },
        };
      },
      async insert({
        table,
        values,
      }: {
        table: Milestone016SeedTable;
        values: Array<Record<string, unknown>>;
        format: "JSONEachRow";
      }) {
        inserts.push({ table, values });
        const column = idColumns[table];
        const tableIds = inserted.get(table)!;
        for (const value of values) {
          tableIds.add(String(value[column]));
        }
      },
    },
  };
}

describe("buildMilestone016Fixtures", () => {
  it("builds a missing-cost telemetry fixture with every other health signal present", () => {
    const fixtures = buildMilestone016Fixtures({
      now: new Date("2026-06-13T08:00:00.000Z"),
    });

    expect(fixtures.workspaceId).toBe("00000000-0000-0000-0000-000000000001");
    expect(fixtures.missingTelemetryRunId).toBe(
      MILESTONE_016_MISSING_COST_RUN_ID
    );
    expect(fixtures.missingTelemetryRunId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(
      fixtures.costEvents.filter(
        (event) => event.run_id === fixtures.missingTelemetryRunId
      )
    ).toHaveLength(0);
    expect(
      fixtures.runEvents
        .filter((event) => event.run_id === fixtures.missingTelemetryRunId)
        .map((event) => event.event_type)
    ).toEqual([
      "run_start",
      "context_pack",
      "review_gate.passed",
      "failure_event",
      "memory_items.pushed",
      "index_snapshot",
      "outbox_flushed",
    ]);
    expect(
      fixtures.contextPacks.some(
        (pack) => pack.run_id === fixtures.missingTelemetryRunId
      )
    ).toBe(true);
    expect(
      fixtures.failureEvents.some(
        (event) => event.run_id === fixtures.missingTelemetryRunId
      )
    ).toBe(true);
    expect(fixtures.indexSnapshots).toHaveLength(1);
  });

  it("builds baseline cost events and a matching cost_anomaly run event", () => {
    const fixtures = buildMilestone016Fixtures({
      now: new Date("2026-06-13T08:00:00.000Z"),
    });

    const baseline = fixtures.costEvents.filter((event) =>
      event.run_id.startsWith("fixture-016-cost-baseline-")
    );
    const observed = fixtures.costEvents.find(
      (event) => event.run_id === fixtures.costAnomalyRunId
    );
    const anomaly = fixtures.runEvents.find(
      (event) => event.event_type === "cost_anomaly"
    );

    expect(baseline).toHaveLength(30);
    expect(fixtures.costAnomalyRunId).toBe(MILESTONE_016_COST_ANOMALY_RUN_ID);
    expect(fixtures.costAnomalyRunId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(
      baseline.every(
        (event) =>
          event.model === "claude-sonnet-4-6" &&
          event.phase === "execute" &&
          event.repository_id === "fixture-repo"
      )
    ).toBe(true);
    expect(observed?.cost_usd).toBe(0.5);
    expect(anomaly?.run_id).toBe(fixtures.costAnomalyRunId);

    const payload = JSON.parse(anomaly!.payload) as {
      model: string;
      cost_usd: number;
      mean: number;
      stddev: number;
      deviation_sigmas: number;
    };
    expect(payload.model).toBe("claude-sonnet-4-6");
    expect(payload.cost_usd).toBe(0.5);
    expect(payload.mean).toBeCloseTo(0.05, 4);
    expect(payload.stddev).toBeGreaterThan(0);
    expect(payload.deviation_sigmas).toBeGreaterThan(2);
  });
});

describe("seedMilestone016Fixtures", () => {
  it("uses stable row ids so re-running does not insert duplicates", async () => {
    const { client, inserts } = fakeSeedClient();

    const first = await seedMilestone016Fixtures(client, {
      now: new Date("2026-06-13T08:00:00.000Z"),
    });
    const second = await seedMilestone016Fixtures(client, {
      now: new Date("2026-06-13T08:00:00.000Z"),
    });

    expect(first.inserted.run_events).toBe(first.runEvents.length);
    expect(first.inserted.cost_events).toBe(first.costEvents.length);
    expect(first.inserted.context_packs).toBe(first.contextPacks.length);
    expect(first.inserted.context_events).toBe(first.contextEvents.length);
    expect(first.inserted.failure_events).toBe(first.failureEvents.length);
    expect(first.inserted.index_snapshots).toBe(first.indexSnapshots.length);
    expect(Object.values(second.inserted).every((count) => count === 0)).toBe(
      true
    );
    expect(inserts.map((insert) => insert.table)).toEqual([
      "run_events",
      "context_packs",
      "context_events",
      "failure_events",
      "index_snapshots",
      "cost_events",
    ]);
  });
});
