/** A wiki page as served by `GET /api/v1/workspaces/:workspaceId/wiki` — the
 * wire shape, not the raw `wiki_pages` row (no id/skeleton/writtenBy). */
export interface WikiPageDTO {
  slug: string;
  title: string;
  kind: "overview" | "unit";
  bodyMd: string;
  citations: string[];
  links: { related: string[]; dependsOn: string[]; dependedOnBy: string[] };
  commitSha: string;
  model: string | null;
  generatedAt: string; // ISO
  stale: boolean;
}

export interface WikiSummaryStats {
  pageCount: number;
  staleCount: number;
  /** ISO `generatedAt` of the OLDEST page, or null when there are no pages. */
  oldestGeneratedAt: string | null;
}

/**
 * Falsifiable summary strip inputs (Repo Wiki spec §4.5: "pages count, stale
 * count, oldest generatedAt age ... nothing that can't go negative/zero").
 * Every field here can go to zero and is read straight off `wiki_pages` rows
 * — no derived "knowledge score".
 */
export function computeWikiSummaryStats(pages: WikiPageDTO[]): WikiSummaryStats {
  if (pages.length === 0) {
    return { pageCount: 0, staleCount: 0, oldestGeneratedAt: null };
  }
  const staleCount = pages.filter((p) => p.stale).length;
  const oldestGeneratedAt = pages.reduce(
    (oldest, p) => (p.generatedAt < oldest ? p.generatedAt : oldest),
    pages[0]!.generatedAt
  );
  return { pageCount: pages.length, staleCount, oldestGeneratedAt };
}

/**
 * Split pages into the overview (if present) and unit pages. Grouped by the
 * `kind` column — a promoted, deterministic field — never by parsing the
 * slug string or the markdown body (spec §4.5: nav is driven by `links`
 * jsonb / slugs from `listWikiPages`, never by parsing markdown). Order is
 * whatever `listWikiPages`'s `ORDER BY slug` already produced (overview
 * first, units alphabetical) — this function only partitions, it doesn't
 * re-sort.
 */
export function groupWikiPages(pages: WikiPageDTO[]): {
  overview: WikiPageDTO | null;
  units: WikiPageDTO[];
} {
  return {
    overview: pages.find((p) => p.kind === "overview") ?? null,
    units: pages.filter((p) => p.kind === "unit"),
  };
}

/** "just now" / "3m ago" / "2h ago" / "5d ago" — relative age from an ISO
 * timestamp to `now` (defaults to the real clock; a fixed `now` keeps this
 * testable without faking timers). Returns "—" for an unparseable input. */
export function formatRelativeAge(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";

  const diffMs = Math.max(0, now - then);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** First 8 chars of a commit SHA — matches the repos table's existing
 * `row.commitSha.slice(0, 8)` convention (repos-table.tsx). */
export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

/** `$0.0400` style cost formatting — mirrors `costs-table.tsx`'s `fmtCost`
 * exactly (kept as a local copy: a three-line pure formatter, not worth a
 * cross-feature import). */
export function formatCostUsd(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.0001) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}
