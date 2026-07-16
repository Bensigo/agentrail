import { describe, expect, it } from "vitest";
import {
  buildDigest,
  computeTrendPct,
  getPreviousWeekRange,
  getWeekRange,
  resolveWeekStart,
  type DigestQueueEntryRow,
  type DigestRunRow,
} from "./digest-helpers";

function run(over: Partial<DigestRunRow>): DigestRunRow {
  return {
    id: "run-1",
    title: "Fix login bug",
    prUrl: "https://github.com/acme/repo/pull/42",
    finishedAt: "2026-07-14T10:00:00.000Z",
    createdAt: "2026-07-14T09:00:00.000Z",
    ...over,
  };
}

function entry(over: Partial<DigestQueueEntryRow>): DigestQueueEntryRow {
  return {
    id: "qe-1",
    externalId: "acme/repo#12",
    title: "Add retries",
    state: "queued",
    updatedAt: "2026-07-14T09:00:00.000Z",
    ...over,
  };
}

describe("resolveWeekStart", () => {
  it("snaps a Wednesday to the Monday of the same week", () => {
    // 2026-07-15 is a Wednesday.
    const start = resolveWeekStart(new Date("2026-07-15T14:30:00.000Z"));
    expect(start.toISOString()).toBe("2026-07-13T00:00:00.000Z");
  });

  it("leaves a Monday unchanged (truncated to midnight UTC)", () => {
    const start = resolveWeekStart(new Date("2026-07-13T23:59:59.000Z"));
    expect(start.toISOString()).toBe("2026-07-13T00:00:00.000Z");
  });

  it("snaps a Sunday back to the preceding Monday", () => {
    // 2026-07-19 is a Sunday, part of the week starting 2026-07-13.
    const start = resolveWeekStart(new Date("2026-07-19T05:00:00.000Z"));
    expect(start.toISOString()).toBe("2026-07-13T00:00:00.000Z");
  });

  it("handles a week that crosses a month boundary", () => {
    // 2026-08-02 is a Sunday; its week starts Monday 2026-07-27.
    const start = resolveWeekStart(new Date("2026-08-02T00:00:00.000Z"));
    expect(start.toISOString()).toBe("2026-07-27T00:00:00.000Z");
  });

  it("handles a week that crosses a year boundary", () => {
    // 2027-01-01 is a Friday; its week starts Monday 2026-12-28.
    const start = resolveWeekStart(new Date("2027-01-01T12:00:00.000Z"));
    expect(start.toISOString()).toBe("2026-12-28T00:00:00.000Z");
  });
});

describe("getWeekRange", () => {
  it("returns a Monday-to-next-Monday exclusive range", () => {
    const { start, end } = getWeekRange(new Date("2026-07-15T00:00:00.000Z"));
    expect(start.toISOString()).toBe("2026-07-13T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-20T00:00:00.000Z");
  });
});

describe("getPreviousWeekRange", () => {
  it("returns the seven days immediately before the current week", () => {
    const { start, end } = getPreviousWeekRange(new Date("2026-07-15T00:00:00.000Z"));
    expect(start.toISOString()).toBe("2026-07-06T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-13T00:00:00.000Z");
  });
});

describe("computeTrendPct", () => {
  it("computes a positive percent increase", () => {
    expect(computeTrendPct(15, 10)).toBeCloseTo(50);
  });

  it("computes a negative percent decrease", () => {
    expect(computeTrendPct(5, 10)).toBeCloseTo(-50);
  });

  it("returns 0 when nothing changed and both weeks were $0", () => {
    expect(computeTrendPct(0, 0)).toBe(0);
  });

  it("returns null when there's no baseline (previous week was $0 but this week is not)", () => {
    expect(computeTrendPct(5, 0)).toBeNull();
  });

  it("returns null when the current value is unavailable", () => {
    expect(computeTrendPct(null, 10)).toBeNull();
  });

  it("returns null when the previous value is unavailable", () => {
    expect(computeTrendPct(10, null)).toBeNull();
  });
});

describe("buildDigest", () => {
  const week = getWeekRange(new Date("2026-07-15T00:00:00.000Z"));

  it("maps shipped runs with title and PR link", () => {
    const digest = buildDigest({
      week,
      shippedRuns: [run({ id: "r1", title: "Ship it", prUrl: "https://x/pr/1" })],
      inProgressEntries: [],
      needsYouEntries: [],
      thisWeekCostRows: [],
      previousWeekCostRows: [],
    });
    expect(digest.shipped).toEqual([
      {
        id: "r1",
        title: "Ship it",
        prUrl: "https://x/pr/1",
        finishedAt: "2026-07-14T10:00:00.000Z",
      },
    ]);
  });

  it("falls back to 'Untitled' when a shipped run has no title", () => {
    const [item] = buildDigest({
      week,
      shippedRuns: [run({ title: null })],
      inProgressEntries: [],
      needsYouEntries: [],
      thisWeekCostRows: [],
      previousWeekCostRows: [],
    }).shipped;
    expect(item.title).toBe("Untitled");
  });

  it("falls back to createdAt when finishedAt is missing", () => {
    const [item] = buildDigest({
      week,
      shippedRuns: [run({ finishedAt: null, createdAt: "2026-07-14T08:00:00.000Z" })],
      inProgressEntries: [],
      needsYouEntries: [],
      thisWeekCostRows: [],
      previousWeekCostRows: [],
    }).shipped;
    expect(item.finishedAt).toBe("2026-07-14T08:00:00.000Z");
  });

  it("includes only queued/running entries in inProgress, keyed by title", () => {
    const digest = buildDigest({
      week,
      shippedRuns: [],
      inProgressEntries: [
        entry({ id: "a", state: "queued", title: "Add retries" }),
        entry({ id: "b", state: "running", title: "Fix flake" }),
      ],
      needsYouEntries: [],
      thisWeekCostRows: [],
      previousWeekCostRows: [],
    });
    expect(digest.inProgress).toEqual([
      { id: "a", title: "Add retries", state: "queued" },
      { id: "b", title: "Fix flake", state: "running" },
    ]);
  });

  it("falls back to the external id when an in-progress entry has no title", () => {
    const [item] = buildDigest({
      week,
      shippedRuns: [],
      inProgressEntries: [entry({ title: "", externalId: "acme/repo#99" })],
      needsYouEntries: [],
      thisWeekCostRows: [],
      previousWeekCostRows: [],
    }).inProgress;
    expect(item.title).toBe("acme/repo#99");
  });

  it("combines escalated-to-human + parked into one needs-you count with a breakdown", () => {
    const digest = buildDigest({
      week,
      shippedRuns: [],
      inProgressEntries: [],
      needsYouEntries: [
        entry({ id: "a", state: "escalated-to-human" }),
        entry({ id: "b", state: "escalated-to-human" }),
        entry({ id: "c", state: "parked" }),
      ],
      thisWeekCostRows: [],
      previousWeekCostRows: [],
    });
    expect(digest.needsYou).toEqual({
      count: 3,
      breakdown: { escalatedToHuman: 2, parked: 1 },
    });
  });

  it("returns a zero needs-you count with an empty breakdown for a quiet week", () => {
    const digest = buildDigest({
      week,
      shippedRuns: [],
      inProgressEntries: [],
      needsYouEntries: [],
      thisWeekCostRows: [],
      previousWeekCostRows: [],
    });
    expect(digest.needsYou).toEqual({
      count: 0,
      breakdown: { escalatedToHuman: 0, parked: 0 },
    });
  });

  it("sums cost rows for this week and previous week, with a computed trend", () => {
    const digest = buildDigest({
      week,
      shippedRuns: [],
      inProgressEntries: [],
      needsYouEntries: [],
      thisWeekCostRows: [{ total_cost_usd: 3 }, { total_cost_usd: 2 }],
      previousWeekCostRows: [{ total_cost_usd: 4 }],
    });
    expect(digest.cost.thisWeekUsd).toBeCloseTo(5);
    expect(digest.cost.previousWeekUsd).toBeCloseTo(4);
    expect(digest.cost.trendPct).toBeCloseTo(25);
  });

  it("degrades cost to null (not a crash) when ClickHouse rows are null", () => {
    const digest = buildDigest({
      week,
      shippedRuns: [],
      inProgressEntries: [],
      needsYouEntries: [],
      thisWeekCostRows: null,
      previousWeekCostRows: null,
    });
    expect(digest.cost).toEqual({
      thisWeekUsd: null,
      previousWeekUsd: null,
      trendPct: null,
    });
  });

  it("echoes the requested week range as ISO strings", () => {
    const digest = buildDigest({
      week,
      shippedRuns: [],
      inProgressEntries: [],
      needsYouEntries: [],
      thisWeekCostRows: [],
      previousWeekCostRows: [],
    });
    expect(digest.week).toEqual({
      start: "2026-07-13T00:00:00.000Z",
      end: "2026-07-20T00:00:00.000Z",
    });
  });
});
