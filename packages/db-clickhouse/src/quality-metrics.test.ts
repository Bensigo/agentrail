import { describe, it, expect } from "vitest";
import { computeQualityMetrics, type QualityPackRow } from "./quality-metrics";

/** Build a fixture row with sensible stable defaults; override any field as needed. */
function row(
  date: string,
  overrides: Partial<Omit<QualityPackRow, "occurred_at">> = {}
): QualityPackRow {
  return {
    occurred_at: new Date(`${date}T12:00:00.000Z`),
    precision_at_budget: 0.9,
    citation_coverage: 0.95,
    stale_count: 1,
    denied_count: 0,
    ...overrides,
  };
}

const from = new Date("2026-05-01T00:00:00.000Z");
const to = new Date("2026-05-30T00:00:00.000Z");

// ─── Baseline readiness: < 5 runs → insufficient_data, but data still returned ──

describe("baseline readiness (insufficient_data)", () => {
  it("0 runs → insufficient, empty-ish series, null latest/baseline", () => {
    const result = computeQualityMetrics([], { from, to });
    expect(result.insufficient_data).toBe(true);
    expect(result.run_count).toBe(0);
    expect(result.latest_date).toBeNull();
    expect(result.latest.precision_at_budget).toBeNull();
    expect(result.baseline.precision_at_budget).toBeNull();
    // Series still spans every calendar day, all gaps null.
    expect(result.series.length).toBe(30);
    expect(result.series.every((p) => p.precision_at_budget === null)).toBe(true);
  });

  it("4 runs → insufficient, but latest + series are populated (graceful)", () => {
    const rows = [
      row("2026-05-05"),
      row("2026-05-10"),
      row("2026-05-15"),
      row("2026-05-25"),
    ];
    const result = computeQualityMetrics(rows, { from, to });
    expect(result.insufficient_data).toBe(true);
    expect(result.run_count).toBe(4);
    expect(result.latest_date).toBe("2026-05-25");
    expect(result.latest.precision_at_budget).toBeCloseTo(0.9);
    // No trustworthy baseline yet.
    expect(result.baseline.precision_at_budget).toBeNull();
    expect(result.regression.precision_at_budget).toBe(false);
  });

  it("5 runs across distinct days → sufficient", () => {
    const rows = [
      row("2026-05-01"),
      row("2026-05-05"),
      row("2026-05-10"),
      row("2026-05-15"),
      row("2026-05-20"),
    ];
    const result = computeQualityMetrics(rows, { from, to });
    expect(result.insufficient_data).toBe(false);
    expect(result.baseline.precision_at_budget).not.toBeNull();
  });

  it("5 runs all on the same day → insufficient (no prior-day baseline)", () => {
    const rows = [
      row("2026-05-20"),
      row("2026-05-20"),
      row("2026-05-20"),
      row("2026-05-20"),
      row("2026-05-20"),
    ];
    const result = computeQualityMetrics(rows, { from, to });
    expect(result.insufficient_data).toBe(true);
    expect(result.latest.precision_at_budget).toBeCloseTo(0.9);
    expect(result.baseline.precision_at_budget).toBeNull();
  });
});

// ─── Stable series → no regression flags ─────────────────────────────────────

describe("stable series, no regression", () => {
  it("all flags false for a stable series", () => {
    const rows = [
      row("2026-05-01"),
      row("2026-05-05"),
      row("2026-05-10"),
      row("2026-05-15"),
      row("2026-05-20"),
      row("2026-05-25"),
      row("2026-05-29"),
    ];
    const result = computeQualityMetrics(rows, { from, to });
    expect(result.insufficient_data).toBe(false);
    expect(result.regression.precision_at_budget).toBe(false);
    expect(result.regression.citation_coverage).toBe(false);
    expect(result.regression.stale_count).toBe(false);
    expect(result.regression.denied_count).toBe(false);
  });

  it("does not flag precision when latest is within 5pp of baseline", () => {
    const rows = [
      row("2026-05-01", { precision_at_budget: 0.9 }),
      row("2026-05-05", { precision_at_budget: 0.9 }),
      row("2026-05-10", { precision_at_budget: 0.9 }),
      row("2026-05-15", { precision_at_budget: 0.9 }),
      row("2026-05-20", { precision_at_budget: 0.9 }),
      row("2026-05-25", { precision_at_budget: 0.9 }),
      row("2026-05-29", { precision_at_budget: 0.86 }),
    ];
    const result = computeQualityMetrics(rows, { from, to });
    expect(result.regression.precision_at_budget).toBe(false);
  });
});

// ─── Deteriorating precision_at_budget → flag only that metric ───────────────

describe("deteriorating precision_at_budget", () => {
  it("flags precision when last run drops > 5pp, other flags remain false", () => {
    const rows = [
      row("2026-05-01", { precision_at_budget: 0.92 }),
      row("2026-05-05", { precision_at_budget: 0.91 }),
      row("2026-05-10", { precision_at_budget: 0.93 }),
      row("2026-05-15", { precision_at_budget: 0.9 }),
      row("2026-05-20", { precision_at_budget: 0.91 }),
      row("2026-05-25", { precision_at_budget: 0.89 }),
      row("2026-05-29", { precision_at_budget: 0.8 }),
    ];
    const result = computeQualityMetrics(rows, { from, to });
    expect(result.insufficient_data).toBe(false);
    expect(result.regression.precision_at_budget).toBe(true);
    expect(result.regression.citation_coverage).toBe(false);
    expect(result.regression.stale_count).toBe(false);
    expect(result.regression.denied_count).toBe(false);
  });

  it("flags precision just over the 5pp boundary", () => {
    // Baseline median = 0.90; latest = 0.849 → drop 0.051 > 0.05 → regresses
    const rows = [
      row("2026-05-01", { precision_at_budget: 0.9 }),
      row("2026-05-05", { precision_at_budget: 0.9 }),
      row("2026-05-10", { precision_at_budget: 0.9 }),
      row("2026-05-15", { precision_at_budget: 0.9 }),
      row("2026-05-20", { precision_at_budget: 0.9 }),
      row("2026-05-25", { precision_at_budget: 0.9 }),
      row("2026-05-29", { precision_at_budget: 0.849 }),
    ];
    const result = computeQualityMetrics(rows, { from, to });
    expect(result.regression.precision_at_budget).toBe(true);
  });
});

// ─── Series gap policy: null on no-run days, per-day run_count ────────────────

describe("series gap policy: null gaps, one entry per day", () => {
  const rows = [
    row("2026-05-01", { precision_at_budget: 0.88 }),
    row("2026-05-10"),
    row("2026-05-15"),
    row("2026-05-20"),
    row("2026-05-25"),
  ];

  it("series length equals the number of days in [from, to] inclusive", () => {
    const result = computeQualityMetrics(rows, { from, to });
    expect(result.series.length).toBe(30);
  });

  it("days without runs carry null metrics (NOT zero) and run_count 0", () => {
    const result = computeQualityMetrics(rows, { from, to });
    const gap = result.series.find((s) => s.date === "2026-05-03")!;
    expect(gap.precision_at_budget).toBeNull();
    expect(gap.citation_coverage).toBeNull();
    expect(gap.stale_count).toBeNull();
    expect(gap.denied_count).toBeNull();
    expect(gap.run_count).toBe(0);
  });

  it("days with runs carry that day's average and run_count", () => {
    const result = computeQualityMetrics(rows, { from, to });
    const runDay = result.series.find((s) => s.date === "2026-05-01")!;
    expect(runDay.precision_at_budget).toBeCloseTo(0.88);
    expect(runDay.run_count).toBe(1);
  });

  it("first and last series entries match from/to", () => {
    const result = computeQualityMetrics(rows, { from, to });
    expect(result.series[0]!.date).toBe("2026-05-01");
    expect(result.series[result.series.length - 1]!.date).toBe("2026-05-30");
  });

  it("aggregates multiple runs on the same day into one point", () => {
    const sameDay = [
      row("2026-05-01"),
      row("2026-05-05", { precision_at_budget: 0.8 }),
      row("2026-05-05", { precision_at_budget: 0.9 }),
      row("2026-05-10"),
      row("2026-05-15"),
      row("2026-05-20"),
    ];
    const result = computeQualityMetrics(sameDay, { from, to });
    const day = result.series.find((s) => s.date === "2026-05-05")!;
    expect(day.run_count).toBe(2);
    expect(day.precision_at_budget).toBeCloseTo(0.85);
  });
});

// ─── Count metric regression ─────────────────────────────────────────────────

describe("count metric regression", () => {
  it("flags stale_count when last run exceeds baseline median by > 10%", () => {
    const rows = [
      row("2026-05-01", { stale_count: 2 }),
      row("2026-05-05", { stale_count: 2 }),
      row("2026-05-10", { stale_count: 2 }),
      row("2026-05-15", { stale_count: 2 }),
      row("2026-05-20", { stale_count: 2 }),
      row("2026-05-25", { stale_count: 2 }),
      row("2026-05-29", { stale_count: 5 }),
    ];
    const result = computeQualityMetrics(rows, { from, to });
    expect(result.regression.stale_count).toBe(true);
  });

  it("does not flag stale_count when latest is within 10% of baseline", () => {
    const rows = [
      row("2026-05-01", { stale_count: 4 }),
      row("2026-05-05", { stale_count: 4 }),
      row("2026-05-10", { stale_count: 4 }),
      row("2026-05-15", { stale_count: 4 }),
      row("2026-05-20", { stale_count: 4 }),
      row("2026-05-25", { stale_count: 4 }),
      row("2026-05-29", { stale_count: 4 }),
    ];
    const result = computeQualityMetrics(rows, { from, to });
    expect(result.regression.stale_count).toBe(false);
  });

  it("flags denied_count when baseline is 0 and latest > 0", () => {
    const rows = [
      row("2026-05-01", { denied_count: 0 }),
      row("2026-05-05", { denied_count: 0 }),
      row("2026-05-10", { denied_count: 0 }),
      row("2026-05-15", { denied_count: 0 }),
      row("2026-05-20", { denied_count: 0 }),
      row("2026-05-25", { denied_count: 0 }),
      row("2026-05-29", { denied_count: 1 }),
    ];
    const result = computeQualityMetrics(rows, { from, to });
    expect(result.regression.denied_count).toBe(true);
  });

  it("does not flag denied_count when both baseline and latest are 0", () => {
    const rows = [
      row("2026-05-01", { denied_count: 0 }),
      row("2026-05-05", { denied_count: 0 }),
      row("2026-05-10", { denied_count: 0 }),
      row("2026-05-15", { denied_count: 0 }),
      row("2026-05-20", { denied_count: 0 }),
      row("2026-05-25", { denied_count: 0 }),
      row("2026-05-29", { denied_count: 0 }),
    ];
    const result = computeQualityMetrics(rows, { from, to });
    expect(result.regression.denied_count).toBe(false);
  });
});

// ─── Baseline value correctness ──────────────────────────────────────────────

describe("baseline computation", () => {
  it("baseline is the median of all runs before the latest run day", () => {
    // Prior runs precision: 0.80, 0.90, 0.85, 0.95, 0.75, 0.90
    // Sorted: [0.75, 0.80, 0.85, 0.90, 0.90, 0.95] → median = 0.875
    const rows = [
      row("2026-05-01", { precision_at_budget: 0.8 }),
      row("2026-05-05", { precision_at_budget: 0.9 }),
      row("2026-05-10", { precision_at_budget: 0.85 }),
      row("2026-05-15", { precision_at_budget: 0.95 }),
      row("2026-05-20", { precision_at_budget: 0.75 }),
      row("2026-05-25", { precision_at_budget: 0.9 }),
      row("2026-05-29", { precision_at_budget: 0.87 }),
    ];
    const result = computeQualityMetrics(rows, { from, to });
    expect(result.baseline.precision_at_budget).toBeCloseTo(0.875);
    expect(result.latest.precision_at_budget).toBeCloseTo(0.87);
    expect(result.regression.precision_at_budget).toBe(false);
  });
});
