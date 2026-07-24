import { describe, it, expect } from "vitest";
import {
  computeWikiSummaryStats,
  groupWikiPages,
  formatRelativeAge,
  shortSha,
  formatCostUsd,
  type WikiPageDTO,
} from "./wiki-format";

function page(overrides: Partial<WikiPageDTO> = {}): WikiPageDTO {
  return {
    slug: "wiki/overview",
    title: "Overview",
    kind: "overview",
    bodyMd: "body",
    citations: [],
    links: { related: [], dependsOn: [], dependedOnBy: [] },
    commitSha: "129103aa",
    model: "claude-haiku-4-5",
    generatedAt: "2026-07-23T14:00:00.000Z",
    stale: false,
    ...overrides,
  };
}

describe("computeWikiSummaryStats", () => {
  it("returns all-zero stats for an empty page set — never compiled", () => {
    expect(computeWikiSummaryStats([])).toEqual({
      pageCount: 0,
      staleCount: 0,
      oldestGeneratedAt: null,
    });
  });

  it("counts pages and stale pages, and finds the OLDEST generatedAt", () => {
    const pages = [
      page({ slug: "wiki/overview", generatedAt: "2026-07-23T14:00:00.000Z", stale: false }),
      page({ slug: "wiki/unit/a", kind: "unit", generatedAt: "2026-07-20T09:00:00.000Z", stale: true }),
      page({ slug: "wiki/unit/b", kind: "unit", generatedAt: "2026-07-22T09:00:00.000Z", stale: false }),
    ];
    expect(computeWikiSummaryStats(pages)).toEqual({
      pageCount: 3,
      staleCount: 1,
      oldestGeneratedAt: "2026-07-20T09:00:00.000Z",
    });
  });

  it("stale count can be zero — a healthy wiki is representable, not hidden", () => {
    const pages = [page({ stale: false }), page({ slug: "wiki/unit/a", kind: "unit", stale: false })];
    expect(computeWikiSummaryStats(pages).staleCount).toBe(0);
  });
});

describe("groupWikiPages", () => {
  it("splits overview from units by the kind column", () => {
    const overview = page({ slug: "wiki/overview", kind: "overview" });
    const unitA = page({ slug: "wiki/unit/a", kind: "unit", title: "Unit A" });
    const unitB = page({ slug: "wiki/unit/b", kind: "unit", title: "Unit B" });

    const result = groupWikiPages([overview, unitA, unitB]);
    expect(result.overview).toEqual(overview);
    expect(result.units).toEqual([unitA, unitB]);
  });

  it("overview is null when the page set has no overview page", () => {
    const result = groupWikiPages([page({ slug: "wiki/unit/a", kind: "unit" })]);
    expect(result.overview).toBeNull();
    expect(result.units).toHaveLength(1);
  });

  it("preserves the input order — grouping never re-sorts", () => {
    const unitB = page({ slug: "wiki/unit/b", kind: "unit" });
    const unitA = page({ slug: "wiki/unit/a", kind: "unit" });
    const result = groupWikiPages([unitB, unitA]);
    expect(result.units).toEqual([unitB, unitA]);
  });
});

describe("formatRelativeAge", () => {
  const NOW = new Date("2026-07-24T12:00:00.000Z").getTime();

  it("returns 'just now' for under a minute", () => {
    expect(formatRelativeAge("2026-07-24T11:59:30.000Z", NOW)).toBe("just now");
  });

  it("formats minutes", () => {
    expect(formatRelativeAge("2026-07-24T11:55:00.000Z", NOW)).toBe("5m ago");
  });

  it("formats hours", () => {
    expect(formatRelativeAge("2026-07-24T09:00:00.000Z", NOW)).toBe("3h ago");
  });

  it("formats days", () => {
    expect(formatRelativeAge("2026-07-20T12:00:00.000Z", NOW)).toBe("4d ago");
  });

  it("returns em-dash for an unparseable timestamp", () => {
    expect(formatRelativeAge("not-a-date", NOW)).toBe("—");
  });
});

describe("shortSha", () => {
  it("truncates to 8 characters, matching repos-table's convention", () => {
    expect(shortSha("129103aabbccdd")).toBe("129103aa");
  });

  it("passes through a short sha unchanged", () => {
    expect(shortSha("abc")).toBe("abc");
  });
});

describe("formatCostUsd", () => {
  it("formats zero as $0.00", () => {
    expect(formatCostUsd(0)).toBe("$0.00");
  });

  it("formats a typical compile cost to 4 decimals", () => {
    expect(formatCostUsd(0.04)).toBe("$0.0400");
  });

  it("formats sub-cent costs to 6 decimals", () => {
    expect(formatCostUsd(0.000031)).toBe("$0.000031");
  });
});
