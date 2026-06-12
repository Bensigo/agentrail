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

// ─── AC3: Fewer than 5 runs → insufficient_data ─────────────────────────────

describe("AC3 – insufficient data", () => {
  it("returns { insufficient_data: true } for zero runs", () => {
    expect(computeQualityMetrics([], { from, to })).toEqual({ insufficient_data: true });
  });

  it("returns { insufficient_data: true } for exactly 4 runs", () => {
    const rows = [
      row("2026-05-05"),
      row("2026-05-10"),
      row("2026-05-15"),
      row("2026-05-25"),
    ];
    expect(computeQualityMetrics(rows, { from, to })).toEqual({ insufficient_data: true });
  });

  it("returns insufficient_data: false for exactly 5 runs", () => {
    const rows = [
      row("2026-05-01"),
      row("2026-05-05"),
      row("2026-05-10"),
      row("2026-05-15"),
      row("2026-05-20"),
    ];
    const result = computeQualityMetrics(rows, { from, to });
    expect(result.insufficient_data).toBe(false);
  });
});

// ─── AC1: Stable series → no regression flags ────────────────────────────────

describe("AC1 – stable series, no regression", () => {
  it("returns insufficient_data: false and all flags false for a stable series", () => {
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
    if (result.insufficient_data) return;
    expect(result.regression.precision_at_budget).toBe(false);
    expect(result.regression.citation_coverage).toBe(false);
    expect(result.regression.stale_count).toBe(false);
    expect(result.regression.denied_count).toBe(false);
  });

  it("does not flag precision when latest is within 5pp of baseline", () => {
    // Baseline median ≈ 0.90; latest = 0.86 (4pp drop, below 5pp threshold)
    const rows = [
      row("2026-05-01", { precision_at_budget: 0.90 }),
      row("2026-05-05", { precision_at_budget: 0.90 }),
      row("2026-05-10", { precision_at_budget: 0.90 }),
      row("2026-05-15", { precision_at_budget: 0.90 }),
      row("2026-05-20", { precision_at_budget: 0.90 }),
      row("2026-05-25", { precision_at_budget: 0.90 }),
      row("2026-05-29", { precision_at_budget: 0.86 }),
    ];
    const result = computeQualityMetrics(rows, { from, to });
    if (result.insufficient_data) return;
    expect(result.regression.precision_at_budget).toBe(false);
  });
});

// ─── AC2: Deteriorating precision_at_budget → flag only that metric ──────────

describe("AC2 – deteriorating precision_at_budget", () => {
  it("flags precision_at_budget when last run drops > 5pp, other flags remain false", () => {
    // Baseline (runs before May 29): precision ~0.90–0.93 → median ≈ 0.91
    // Last run on May 29: precision = 0.80 (11pp drop → regresses)
    const rows = [
      row("2026-05-01", { precision_at_budget: 0.92 }),
      row("2026-05-05", { precision_at_budget: 0.91 }),
      row("2026-05-10", { precision_at_budget: 0.93 }),
      row("2026-05-15", { precision_at_budget: 0.90 }),
      row("2026-05-20", { precision_at_budget: 0.91 }),
      row("2026-05-25", { precision_at_budget: 0.89 }),
      row("2026-05-29", { precision_at_budget: 0.80 }),
    ];
    const result = computeQualityMetrics(rows, { from, to });
    expect(result.insufficient_data).toBe(false);
    if (result.insufficient_data) return;
    expect(result.regression.precision_at_budget).toBe(true);
    expect(result.regression.citation_coverage).toBe(false);
    expect(result.regression.stale_count).toBe(false);
    expect(result.regression.denied_count).toBe(false);
  });

  it("flags precision exactly 5pp below median baseline (boundary: just over)", () => {
    // Baseline median = 0.90; latest = 0.849 → drop of 0.051 > 0.05 → regresses
    const rows = [
      row("2026-05-01", { precision_at_budget: 0.90 }),
      row("2026-05-05", { precision_at_budget: 0.90 }),
      row("2026-05-10", { precision_at_budget: 0.90 }),
      row("2026-05-15", { precision_at_budget: 0.90 }),
      row("2026-05-20", { precision_at_budget: 0.90 }),
      row("2026-05-25", { precision_at_budget: 0.90 }),
      row("2026-05-29", { precision_at_budget: 0.849 }),
    ];
    const result = computeQualityMetrics(rows, { from, to });
    if (result.insufficient_data) return;
    expect(result.regression.precision_at_budget).toBe(true);
  });
});

// ─── AC4: Series continuity and zero-fill ────────────────────────────────────

describe("AC4 – series gap policy: zero-filled, one entry per day", () => {
  it("series length equals the number of days in [from, to] inclusive", () => {
    // 2026-05-01 to 2026-05-30 = 30 calendar days
    const rows = [
      row("2026-05-01"),
      row("2026-05-10"),
      row("2026-05-15"),
      row("2026-05-20"),
      row("2026-05-25"),
    ];
    const result = computeQualityMetrics(rows, { from, to });
    expect(result.insufficient_data).toBe(false);
    if (result.insufficient_data) return;
    expect(result.series.length).toBe(30);
  });

  it("days without runs have all-zero metrics", () => {
    const rows = [
      row("2026-05-01"),
      row("2026-05-10"),
      row("2026-05-15"),
      row("2026-05-20"),
      row("2026-05-25"),
    ];
    const result = computeQualityMetrics(rows, { from, to });
    if (result.insufficient_data) return;
    const gapDay = result.series.find((s) => s.date === "2026-05-03");
    expect(gapDay).toBeDefined();
    expect(gapDay!.precision_at_budget).toBe(0);
    expect(gapDay!.citation_coverage).toBe(0);
    expect(gapDay!.stale_count).toBe(0);
    expect(gapDay!.denied_count).toBe(0);
  });

  it("first series entry date matches `from`", () => {
    const rows = [
      row("2026-05-01"),
      row("2026-05-10"),
      row("2026-05-15"),
      row("2026-05-20"),
      row("2026-05-25"),
    ];
    const result = computeQualityMetrics(rows, { from, to });
    if (result.insufficient_data) return;
    expect(result.series[0]!.date).toBe("2026-05-01");
  });

  it("last series entry date matches `to`", () => {
    const rows = [
      row("2026-05-01"),
      row("2026-05-10"),
      row("2026-05-15"),
      row("2026-05-20"),
      row("2026-05-25"),
    ];
    const result = computeQualityMetrics(rows, { from, to });
    if (result.insufficient_data) return;
    expect(result.series[result.series.length - 1]!.date).toBe("2026-05-30");
  });

  it("days with runs carry non-zero metrics", () => {
    const rows = [
      row("2026-05-01", { precision_at_budget: 0.88 }),
      row("2026-05-10"),
      row("2026-05-15"),
      row("2026-05-20"),
      row("2026-05-25"),
    ];
    const result = computeQualityMetrics(rows, { from, to });
    if (result.insufficient_data) return;
    const runDay = result.series.find((s) => s.date === "2026-05-01");
    expect(runDay).toBeDefined();
    expect(runDay!.precision_at_budget).toBeCloseTo(0.88);
  });
});

// ─── Count metric regression ─────────────────────────────────────────────────

describe("count metric regression", () => {
  it("flags stale_count when last run exceeds baseline median by > 10%", () => {
    // Baseline median stale_count = 2; latest = 5 → 5 > 2 * 1.1 = 2.2 → regresses
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
    if (result.insufficient_data) return;
    expect(result.regression.stale_count).toBe(true);
  });

  it("does not flag stale_count when latest is within 10% of baseline", () => {
    // Baseline median stale_count = 4; latest = 4 → no regression
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
    if (result.insufficient_data) return;
    expect(result.regression.stale_count).toBe(false);
  });

  it("flags denied_count when baseline is 0 and latest > 0", () => {
    // All baseline runs have denied_count=0; last run gets denied_count=1
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
    if (result.insufficient_data) return;
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
    if (result.insufficient_data) return;
    expect(result.regression.denied_count).toBe(false);
  });
});

// ─── Baseline value correctness ──────────────────────────────────────────────

describe("baseline computation", () => {
  it("baseline is the median of all runs before the latest run day", () => {
    // Runs on days 1, 5, 10, 15, 20, 25 have precision = 0.80, 0.90, 0.85, 0.95, 0.75, 0.90
    // Sorted: [0.75, 0.80, 0.85, 0.90, 0.90, 0.95] → median = (0.85 + 0.90) / 2 = 0.875
    // Latest run (May 29): precision = 0.87 → drop = 0.875 - 0.87 = 0.005 < 0.05 → no regression
    const rows = [
      row("2026-05-01", { precision_at_budget: 0.80 }),
      row("2026-05-05", { precision_at_budget: 0.90 }),
      row("2026-05-10", { precision_at_budget: 0.85 }),
      row("2026-05-15", { precision_at_budget: 0.95 }),
      row("2026-05-20", { precision_at_budget: 0.75 }),
      row("2026-05-25", { precision_at_budget: 0.90 }),
      row("2026-05-29", { precision_at_budget: 0.87 }),
    ];
    const result = computeQualityMetrics(rows, { from, to });
    if (result.insufficient_data) return;
    expect(result.baseline.precision_at_budget).toBeCloseTo(0.875);
    expect(result.regression.precision_at_budget).toBe(false);
  });
});
