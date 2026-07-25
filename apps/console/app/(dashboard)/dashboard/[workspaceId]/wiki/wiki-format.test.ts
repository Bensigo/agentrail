import { describe, it, expect } from "vitest";
import {
  computeWikiSummaryStats,
  groupWikiPages,
  formatRelativeAge,
  formatPageCount,
  formatRepoDetailLine,
  formatWikiFreshnessLine,
  resolveCompiledAt,
  shortSha,
  formatCostUsd,
  healthStatusLabel,
  wikiMdFilename,
  buildWikiMarkdownDownload,
  type RepoListItem,
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
    skeleton: {},
    ...overrides,
  };
}

function repo(overrides: Partial<RepoListItem> = {}): RepoListItem {
  return {
    id: "repo-1",
    name: "bensigo/agentrail",
    healthStatus: "healthy",
    lastIndexedAt: "2026-07-24T10:00:00.000Z",
    lastCommitSha: "129103aabbccdd",
    sourceCount: 1204,
    ...overrides,
  };
}

describe("computeWikiSummaryStats", () => {
  it("returns all-zero stats for an empty page set — never compiled", () => {
    expect(computeWikiSummaryStats([])).toEqual({
      pageCount: 0,
      staleCount: 0,
      oldestGeneratedAt: null,
      newestGeneratedAt: null,
    });
  });

  it("counts pages and stale pages, and finds the OLDEST and NEWEST generatedAt", () => {
    const pages = [
      page({ slug: "wiki/overview", generatedAt: "2026-07-23T14:00:00.000Z", stale: false }),
      page({ slug: "wiki/unit/a", kind: "unit", generatedAt: "2026-07-20T09:00:00.000Z", stale: true }),
      page({ slug: "wiki/unit/b", kind: "unit", generatedAt: "2026-07-22T09:00:00.000Z", stale: false }),
    ];
    expect(computeWikiSummaryStats(pages)).toEqual({
      pageCount: 3,
      staleCount: 1,
      oldestGeneratedAt: "2026-07-20T09:00:00.000Z",
      newestGeneratedAt: "2026-07-23T14:00:00.000Z",
    });
  });

  it("stale count can be zero — a healthy wiki is representable, not hidden", () => {
    const pages = [page({ stale: false }), page({ slug: "wiki/unit/a", kind: "unit", stale: false })];
    expect(computeWikiSummaryStats(pages).staleCount).toBe(0);
  });
});

describe("resolveCompiledAt", () => {
  it("prefers the compile event's createdAt when it's already available", () => {
    expect(
      resolveCompiledAt("2026-07-23T14:00:00.000Z", { createdAt: "2026-07-23T14:00:05.000Z" })
    ).toBe("2026-07-23T14:00:05.000Z");
  });

  it("falls back to the newest page's generatedAt when there's no compile event (ClickHouse down/unconfigured) — never blocked by it", () => {
    expect(resolveCompiledAt("2026-07-23T14:00:00.000Z", null)).toBe("2026-07-23T14:00:00.000Z");
  });

  it("is null only when there is truly nothing to report (no pages, no compile event)", () => {
    expect(resolveCompiledAt(null, null)).toBeNull();
  });
});

describe("formatWikiFreshnessLine", () => {
  const NOW = new Date("2026-07-24T12:00:00.000Z").getTime();

  it("joins page count and compiled age — the wiki header's primary, Postgres-backed signal", () => {
    expect(formatWikiFreshnessLine(12, "2026-07-24T11:55:00.000Z", NOW)).toBe(
      "12 pages · compiled 5m ago"
    );
  });

  it("singular page count matches formatPageCount", () => {
    expect(formatWikiFreshnessLine(1, "2026-07-24T11:55:00.000Z", NOW)).toBe(
      "1 page · compiled 5m ago"
    );
  });

  it("an honest zero-state: 0 pages, not compiled yet — never hidden, never a fake age", () => {
    expect(formatWikiFreshnessLine(0, null, NOW)).toBe("0 pages · not compiled yet");
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

describe("healthStatusLabel", () => {
  it("title-cases the health word for display", () => {
    expect(healthStatusLabel("healthy")).toBe("Healthy");
    expect(healthStatusLabel("stale")).toBe("Stale");
    expect(healthStatusLabel("critical")).toBe("Critical");
    expect(healthStatusLabel("unknown")).toBe("Unknown");
  });
});

describe("formatPageCount", () => {
  it("singular for exactly 1", () => {
    expect(formatPageCount(1)).toBe("1 page");
  });

  it("plural for 0 and >1 — a healthy zero-state stays representable", () => {
    expect(formatPageCount(0)).toBe("0 pages");
    expect(formatPageCount(12)).toBe("12 pages");
  });
});

describe("formatRepoDetailLine", () => {
  const NOW = new Date("2026-07-24T12:00:00.000Z").getTime();

  it("joins health, last-indexed age, short commit, and source count with middots", () => {
    const r = repo({
      healthStatus: "healthy",
      lastIndexedAt: "2026-07-24T10:00:00.000Z",
      lastCommitSha: "129103aabbccdd",
      sourceCount: 1204,
    });
    expect(formatRepoDetailLine(r, NOW)).toBe(
      "Healthy · last indexed 2h ago · commit 129103aa · 1,204 sources"
    );
  });

  it("falls back to an em dash when there's no index timestamp — never claims the false certainty of 'never'", () => {
    const r = repo({ lastIndexedAt: null });
    expect(formatRepoDetailLine(r, NOW)).toContain("last indexed —");
    expect(formatRepoDetailLine(r, NOW)).not.toContain("never");
  });

  it("omits the commit segment when there is no commit sha", () => {
    const r = repo({ lastCommitSha: null });
    expect(formatRepoDetailLine(r, NOW)).not.toContain("commit");
  });

  it("omits the sources segment when the source count is null", () => {
    const r = repo({ sourceCount: null });
    expect(formatRepoDetailLine(r, NOW)).not.toContain("sources");
  });

  it("no index snapshot AND no commit/source count: health word alone", () => {
    const r = repo({ lastIndexedAt: null, lastCommitSha: null, sourceCount: null });
    expect(formatRepoDetailLine(r, NOW)).toBe("Healthy · last indexed —");
  });

  it("unknown health status (no telemetry — never/never-reported, per lib/repo-health.ts) reads honestly, not as an alarm", () => {
    const r = repo({
      healthStatus: "unknown",
      lastIndexedAt: null,
      lastCommitSha: null,
      sourceCount: null,
    });
    expect(formatRepoDetailLine(r, NOW)).toBe("Unknown · last indexed —");
  });
});

describe("wikiMdFilename", () => {
  it("strips the wiki/ prefix for the overview page", () => {
    expect(wikiMdFilename("wiki/overview")).toBe("overview.md");
  });

  it("replaces remaining slashes with __ for a unit page", () => {
    expect(wikiMdFilename("wiki/unit/apps-console")).toBe("unit__apps-console.md");
  });

  it("handles a deeper nested slug", () => {
    expect(wikiMdFilename("wiki/unit/packages-db-postgres")).toBe(
      "unit__packages-db-postgres.md"
    );
  });

  it("falls back to a safe name for an empty/degenerate slug", () => {
    expect(wikiMdFilename("wiki/")).toBe("wiki-page.md");
    expect(wikiMdFilename("")).toBe("wiki-page.md");
  });
});

describe("buildWikiMarkdownDownload", () => {
  it("builds a frontmatter-style header over bodyMd verbatim, filename from the slug", () => {
    const p = page({
      slug: "wiki/unit/agentrail-context",
      title: "agentrail/context — Context Compiler",
      kind: "unit",
      bodyMd: "## Responsibility\nCompiles context.",
      commitSha: "129103aa",
      generatedAt: "2026-07-23T14:00:00.000Z",
      model: "claude-haiku-4-5",
      citations: ["agentrail/context/index.py", "agentrail/context/packs.py"],
    });

    const result = buildWikiMarkdownDownload(p);

    expect(result.filename).toBe("unit__agentrail-context.md");
    expect(result.content).toBe(
      [
        "---",
        "slug: wiki/unit/agentrail-context",
        "title: agentrail/context — Context Compiler",
        "kind: unit",
        "commitSha: 129103aa",
        "generatedAt: 2026-07-23T14:00:00.000Z",
        "model: claude-haiku-4-5",
        "citations: [agentrail/context/index.py, agentrail/context/packs.py]",
        "---",
        "",
        "## Responsibility\nCompiles context.",
      ].join("\n")
    );
  });

  it("omits the model line for a fail-open skeleton-only page (model: null)", () => {
    const p = page({ model: null });
    const result = buildWikiMarkdownDownload(p);
    expect(result.content).not.toContain("model:");
  });

  it("omits the citations line when there are none", () => {
    const p = page({ citations: [] });
    const result = buildWikiMarkdownDownload(p);
    expect(result.content).not.toContain("citations:");
  });

  it("bodyMd appears byte-for-byte, exactly what the toggle's Source view shows", () => {
    const bodyMd = "line one\n\n> a blockquote\n\n- a\n- b\n";
    const p = page({ bodyMd });
    const result = buildWikiMarkdownDownload(p);
    expect(result.content.endsWith(bodyMd)).toBe(true);
  });
});
