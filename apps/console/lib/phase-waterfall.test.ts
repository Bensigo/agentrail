import { describe, it, expect } from "vitest";
import { buildWaterfall } from "./phase-waterfall";
import type { PhaseEvent, CostRow } from "./phase-waterfall";

// Convenience builder for events.
function ev(phase: string, occurred_at: string): PhaseEvent {
  return { event_type: "phase_event", phase, occurred_at };
}

describe("buildWaterfall — normal case", () => {
  // Three phases: plan (10s), execute (30s), verify (5s).
  // Total = 45s.  execute is slowest and most expensive.
  const t0 = "2026-01-01T00:00:00.000Z";
  const events: PhaseEvent[] = [
    ev("plan", "2026-01-01T00:00:00.000Z"),
    ev("plan", "2026-01-01T00:00:10.000Z"),
    ev("execute", "2026-01-01T00:00:10.000Z"),
    ev("execute", "2026-01-01T00:00:40.000Z"),
    ev("verify", "2026-01-01T00:00:40.000Z"),
    ev("verify", "2026-01-01T00:00:45.000Z"),
  ];

  const costRows: CostRow[] = [
    { phase: "plan", tokens: 1000, cost_usd: 0.001 },
    { phase: "execute", tokens: 5000, cost_usd: 0.05 },
    { phase: "verify", tokens: 500, cost_usd: 0.0005 },
  ];

  const result = buildWaterfall(events, costRows);

  it("returns one entry per phase", () => {
    expect(result).toHaveLength(3);
  });

  it("phases are ordered by first event timestamp", () => {
    expect(result.map((p) => p.name)).toEqual(["plan", "execute", "verify"]);
  });

  it("durationMs is correct for each phase", () => {
    expect(result[0].durationMs).toBe(10_000); // plan
    expect(result[1].durationMs).toBe(30_000); // execute
    expect(result[2].durationMs).toBe(5_000);  // verify
  });

  it("share sums to 1", () => {
    const total = result.reduce((s, p) => s + p.share, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("execute has the correct share (~0.667)", () => {
    expect(result[1].share).toBeCloseTo(30 / 45, 10);
  });

  it("flags execute as slowest", () => {
    expect(result[1].isSlowest).toBe(true);
    expect(result[0].isSlowest).toBe(false);
    expect(result[2].isSlowest).toBe(false);
  });

  it("flags execute as most expensive", () => {
    expect(result[1].isMostExpensive).toBe(true);
    expect(result[0].isMostExpensive).toBe(false);
    expect(result[2].isMostExpensive).toBe(false);
  });

  it("maps tokens and cost correctly", () => {
    expect(result[0].tokens).toBe(1000);
    expect(result[0].costUsd).toBe(0.001);
    expect(result[1].tokens).toBe(5000);
    expect(result[1].costUsd).toBe(0.05);
  });
});

describe("buildWaterfall — missing-cost case", () => {
  // Two phases; only 'execute' has a cost row.
  const events: PhaseEvent[] = [
    ev("plan", "2026-01-01T00:00:00.000Z"),
    ev("plan", "2026-01-01T00:00:05.000Z"),
    ev("execute", "2026-01-01T00:00:05.000Z"),
    ev("execute", "2026-01-01T00:00:25.000Z"),
  ];

  const costRows: CostRow[] = [
    { phase: "execute", tokens: 3000, cost_usd: 0.03 },
  ];

  const result = buildWaterfall(events, costRows);

  it("plan phase has zero tokens and zero cost", () => {
    const plan = result.find((p) => p.name === "plan");
    expect(plan?.tokens).toBe(0);
    expect(plan?.costUsd).toBe(0);
  });

  it("plan is not flagged as most expensive", () => {
    const plan = result.find((p) => p.name === "plan");
    expect(plan?.isMostExpensive).toBe(false);
  });

  it("execute is most expensive", () => {
    const exec = result.find((p) => p.name === "execute");
    expect(exec?.isMostExpensive).toBe(true);
  });

  it("cost row phase name matching is case-insensitive", () => {
    // Cost row uses uppercase phase name.
    const result2 = buildWaterfall(events, [
      { phase: "EXECUTE", tokens: 3000, cost_usd: 0.03 },
    ]);
    const exec = result2.find((p) => p.name === "execute");
    expect(exec?.tokens).toBe(3000);
    expect(exec?.costUsd).toBe(0.03);
  });
});

describe("buildWaterfall — single-phase case", () => {
  const events: PhaseEvent[] = [
    ev("plan", "2026-01-01T00:00:00.000Z"),
    ev("plan", "2026-01-01T00:00:10.000Z"),
  ];

  const costRows: CostRow[] = [
    { phase: "plan", tokens: 500, cost_usd: 0.0005 },
  ];

  const result = buildWaterfall(events, costRows);

  it("returns exactly one phase", () => {
    expect(result).toHaveLength(1);
  });

  it("single phase has share = 1 when it has non-zero duration", () => {
    expect(result[0].share).toBe(1);
  });

  it("single phase is both slowest and most expensive", () => {
    expect(result[0].isSlowest).toBe(true);
    expect(result[0].isMostExpensive).toBe(true);
  });
});

describe("buildWaterfall — edge cases", () => {
  it("returns empty array for empty events", () => {
    expect(buildWaterfall([], [])).toEqual([]);
  });

  it("events without a phase are skipped", () => {
    const events: PhaseEvent[] = [
      { event_type: "run_start", phase: "", occurred_at: "2026-01-01T00:00:00Z" },
      ev("plan", "2026-01-01T00:00:01Z"),
      ev("plan", "2026-01-01T00:00:11Z"),
    ];
    const result = buildWaterfall(events, []);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("plan");
  });

  it("single-event phase has durationMs = 0 and share = 0 (total > 0)", () => {
    const events: PhaseEvent[] = [
      ev("plan", "2026-01-01T00:00:00Z"),
      ev("plan", "2026-01-01T00:00:10Z"), // 10s
      ev("execute", "2026-01-01T00:00:10Z"), // only one event
    ];
    const result = buildWaterfall(events, []);
    const exec = result.find((p) => p.name === "execute");
    expect(exec?.durationMs).toBe(0);
    expect(exec?.share).toBe(0);
  });
});
