import { describe, it, expect } from "vitest";
import { computeRotScore } from "./rot-scorer";
import type { RotScorerSignals } from "./rot-scorer";

// Reference date used across all tests (UTC midnight, easy arithmetic).
const AS_OF = new Date("2026-06-13T00:00:00.000Z");
const THRESHOLD = 30;

function daysAgo(n: number): Date {
  return new Date(AS_OF.getTime() - n * 86_400_000);
}

function makeSignals(overrides: Partial<RotScorerSignals> = {}): RotScorerSignals {
  return {
    memoryRows: [],
    snapshot: null,
    churn: { distinctLists: 0, runCount: 0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC3: Empty memory + fresh snapshot → rot_score === 0
// ---------------------------------------------------------------------------
describe("AC3: zero state", () => {
  it("returns rot_score 0 when no memory items and snapshot is fresh (staleness = 0)", () => {
    const signals = makeSignals({
      snapshot: {
        repositoryId: "repo-fresh",
        indexedAt: AS_OF, // 0 days stale → decay = 0
      },
      churn: { distinctLists: 1, runCount: 10 }, // distinct ≤ 1 → churn = 0
    });
    const result = computeRotScore(signals, { asOf: AS_OF, thresholdDays: THRESHOLD });
    expect(result.rot_score).toBe(0);
    expect(result.contributors).toHaveLength(0);
  });

  it("returns rot_score 0 when all inputs are absent", () => {
    const result = computeRotScore(makeSignals(), { asOf: AS_OF, thresholdDays: THRESHOLD });
    expect(result.rot_score).toBe(0);
    expect(result.contributors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC1: Known fixture ages → expected rot_score within ±1
// ---------------------------------------------------------------------------
describe("AC1: known fixture ages → expected rot_score", () => {
  it("computes the expected score from two memory items, a snapshot, and hash churn", () => {
    // Memory: item A = 20 days stale (decay 20/30 ≈ 0.667),
    //         item B = 10 days stale (decay 10/30 ≈ 0.333).
    // Mean memory decay = (0.667 + 0.333) / 2 = 0.5  → memory component = 0.5
    // Snapshot: 15 days stale → decay = 15/30 = 0.5  → snapshot component = 0.5
    // Churn: distinct=2, runs=5 → (2-1)/max(5-1,1) = 1/4 = 0.25 → churn component = 0.25
    // rot_score = round((0.4*0.5 + 0.4*0.5 + 0.2*0.25) * 100)
    //           = round((0.20 + 0.20 + 0.05) * 100) = round(45) = 45
    const expected = 45;
    const signals = makeSignals({
      memoryRows: [
        { id: "mem-a", source: "docs/readme.md", lastUsedAt: daysAgo(20) },
        { id: "mem-b", source: "src/main.ts",    lastUsedAt: daysAgo(10) },
      ],
      snapshot: {
        repositoryId: "repo-x",
        repositoryName: "my-repo",
        indexedAt: daysAgo(15),
      },
      churn: { distinctLists: 2, runCount: 5 },
    });
    const { rot_score } = computeRotScore(signals, { asOf: AS_OF, thresholdDays: THRESHOLD });
    expect(Math.abs(rot_score - expected)).toBeLessThanOrEqual(1);
  });

  it("null lastUsedAt is treated as maximally stale (same as thresholdDays stale)", () => {
    // One item with null lastUsedAt → decay = 1.0 (threshold days stale).
    // No snapshot, no churn.
    // rot_score = round(0.4 * 1.0 * 100) = 40
    const result = computeRotScore(
      makeSignals({ memoryRows: [{ id: "m1", source: "x.ts", lastUsedAt: null }] }),
      { asOf: AS_OF, thresholdDays: THRESHOLD }
    );
    expect(Math.abs(result.rot_score - 40)).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// AC2: Contributors sorted descending by score_contribution
//      — oldest memory item appears before a fresher index snapshot
// ---------------------------------------------------------------------------
describe("AC2: contributor ordering", () => {
  it("memory item with full staleness (decay 1.0) ranks above a fresher snapshot", () => {
    // Memory item: 30 days stale → decay 1.0 → contribution = 1/1 * 40 = 40
    // Snapshot: 10 days stale → decay 10/30 ≈ 0.333 → contribution ≈ 0.333 * 40 = 13.3
    // Expect: memory item is contributors[0]
    const signals = makeSignals({
      memoryRows: [{ id: "mem-old", source: "lib/old.ts", lastUsedAt: daysAgo(30) }],
      snapshot: { repositoryId: "repo-y", indexedAt: daysAgo(10) },
    });
    const { contributors } = computeRotScore(signals, { asOf: AS_OF, thresholdDays: THRESHOLD });
    expect(contributors.length).toBeGreaterThanOrEqual(2);
    expect(contributors[0].type).toBe("memory_item");
    expect(contributors[0].id).toBe("mem-old");
    expect(contributors[1].type).toBe("index_snapshot");
  });

  it("contributors array is sorted strictly descending by score_contribution", () => {
    const signals = makeSignals({
      memoryRows: [
        { id: "m1", source: "a.ts", lastUsedAt: daysAgo(30) },
        { id: "m2", source: "b.ts", lastUsedAt: daysAgo(5) },
      ],
      snapshot: { repositoryId: "repo-z", indexedAt: daysAgo(20) },
      churn: { distinctLists: 3, runCount: 4 },
    });
    const { contributors } = computeRotScore(signals, { asOf: AS_OF, thresholdDays: THRESHOLD });
    for (let i = 1; i < contributors.length; i++) {
      expect(contributors[i].score_contribution).toBeLessThanOrEqual(
        contributors[i - 1].score_contribution
      );
    }
  });
});

// ---------------------------------------------------------------------------
// AC4: Decay is capped at 1.0 — 200-day-stale item same contribution as 30-day
// ---------------------------------------------------------------------------
describe("AC4: decay cap", () => {
  it("200-day-stale item with thresholdDays=30 has the same contribution as a 30-day-stale item", () => {
    const run200 = computeRotScore(
      makeSignals({ memoryRows: [{ id: "m200", source: "x.ts", lastUsedAt: daysAgo(200) }] }),
      { asOf: AS_OF, thresholdDays: 30 }
    );
    const run30 = computeRotScore(
      makeSignals({ memoryRows: [{ id: "m30", source: "x.ts", lastUsedAt: daysAgo(30) }] }),
      { asOf: AS_OF, thresholdDays: 30 }
    );
    expect(run200.rot_score).toBe(run30.rot_score);
    expect(run200.contributors[0].score_contribution).toBeCloseTo(
      run30.contributors[0].score_contribution,
      5
    );
  });

  it("decay is exactly 1.0 when staleness_days > thresholdDays", () => {
    const result = computeRotScore(
      makeSignals({ memoryRows: [{ id: "m999", source: "z.ts", lastUsedAt: daysAgo(999) }] }),
      { asOf: AS_OF, thresholdDays: 30 }
    );
    // With 1 item at full decay, memory component = 1.0 → score = round(0.4 * 100) = 40
    expect(result.rot_score).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// Additional edge cases
// ---------------------------------------------------------------------------
describe("edge cases", () => {
  it("thresholdDays defaults to 30", () => {
    const withDefault = computeRotScore(
      makeSignals({ memoryRows: [{ id: "m", source: "a.ts", lastUsedAt: daysAgo(30) }] }),
      { asOf: AS_OF }
    );
    const withExplicit = computeRotScore(
      makeSignals({ memoryRows: [{ id: "m", source: "a.ts", lastUsedAt: daysAgo(30) }] }),
      { asOf: AS_OF, thresholdDays: 30 }
    );
    expect(withDefault.rot_score).toBe(withExplicit.rot_score);
  });

  it("hash churn with distinct_lists=1 contributes 0", () => {
    const result = computeRotScore(
      makeSignals({ churn: { distinctLists: 1, runCount: 100 } }),
      { asOf: AS_OF, thresholdDays: THRESHOLD }
    );
    expect(result.rot_score).toBe(0);
    expect(result.contributors.find((c) => c.type === "hash_churn")).toBeUndefined();
  });

  it("hash churn is capped at 20 even with very high churn", () => {
    const result = computeRotScore(
      makeSignals({ churn: { distinctLists: 1000, runCount: 2 } }),
      { asOf: AS_OF, thresholdDays: THRESHOLD }
    );
    // churn decay capped at 1.0 → contribution = 1.0 * 20 = 20
    const churnRow = result.contributors.find((c) => c.type === "hash_churn");
    expect(churnRow?.score_contribution).toBeCloseTo(20, 5);
    expect(result.rot_score).toBe(20);
  });

  it("ClickHouse-format timestamp string is parsed as UTC", () => {
    // snapshot indexed exactly at asOf → staleness 0 → decay 0 → no contribution
    const result = computeRotScore(
      makeSignals({
        snapshot: {
          repositoryId: "repo-ch",
          indexedAt: "2026-06-13 00:00:00.000", // space-separated, no TZ
        },
      }),
      { asOf: AS_OF, thresholdDays: THRESHOLD }
    );
    expect(result.rot_score).toBe(0);
  });

  it("zero-contribution contributors are excluded from the list", () => {
    // snapshot exactly at asOf → decay 0 → not included
    const result = computeRotScore(
      makeSignals({ snapshot: { repositoryId: "repo-fresh", indexedAt: AS_OF } }),
      { asOf: AS_OF, thresholdDays: THRESHOLD }
    );
    expect(result.contributors).toHaveLength(0);
  });
});
