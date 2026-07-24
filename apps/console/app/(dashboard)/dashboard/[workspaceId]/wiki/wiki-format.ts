import type { HealthStatus } from "../../../../../lib/repo-health";

/** A wiki page as served by `GET /api/v1/workspaces/:workspaceId/wiki` — the
 * wire shape, not the raw `wiki_pages` row (no id/writtenBy). `skeleton` is
 * passed through opaque (the compiler's deterministic inputs — file roster,
 * unit path, exports, dependency edges) so the console can render structure
 * from STRUCTURED data, never by parsing `bodyMd` (see `wiki-tree.ts`). */
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
  skeleton: Record<string, unknown>;
}

/** A repo in the workspace's repo list — the health-absorption surface
 * (owner ruling: Repos & Health folded into Wiki). Mirrors the fields the
 * now-redirected `/repos` page showed, computed the same way (`repoHealth`
 * over `getLatestIndexSnapshotsForWorkspace` — `lib/repo-health.ts`'s single
 * source of truth), never duplicated inline. */
export interface RepoListItem {
  id: string;
  name: string;
  healthStatus: HealthStatus;
  /** ISO, or null when the repo has never been indexed. */
  lastIndexedAt: string | null;
  lastCommitSha: string | null;
  sourceCount: number | null;
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

/** First 8 chars of a commit SHA — matches the former repos table's
 * `row.commitSha.slice(0, 8)` convention. */
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

/** Title-case health word for display ("healthy" -> "Healthy") — mirrors the
 * platform's other status-label maps (`run-status-label.ts`'s
 * `runStatusLabel`), rather than showing the raw lowercase enum value the
 * former repos-table's cells used verbatim. */
export function healthStatusLabel(status: HealthStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** "1 page" / "12 pages" — the wiki-first header's page-count fact. */
export function formatPageCount(count: number): string {
  return `${count} ${count === 1 ? "page" : "pages"}`;
}

/**
 * Wiki UX hierarchy fix (owner feedback: knowledge was buried under a repo
 * table — "am I supposed to click the repo to see the wiki?"). The
 * multi-repo header's compact picker row has no room for the repo's full
 * health detail (last-indexed age, commit, source count) alongside the
 * picker control itself — spec: that detail collapses into a one-line
 * subheader for the SELECTED repo only, rather than living inline like the
 * single-repo header can afford (`wiki-repo-header.tsx`). One plain
 * "·"-joined string: every segment here shares identical muted styling, so
 * there's no need for the per-segment JSX `ProvenanceBar` uses when parts
 * carry different colors/weights.
 */
export function formatRepoDetailLine(repo: RepoListItem, now: number = Date.now()): string {
  const parts = [
    healthStatusLabel(repo.healthStatus),
    `last indexed ${repo.lastIndexedAt ? formatRelativeAge(repo.lastIndexedAt, now) : "never"}`,
    repo.lastCommitSha ? `commit ${shortSha(repo.lastCommitSha)}` : null,
    repo.sourceCount !== null ? `${repo.sourceCount.toLocaleString()} sources` : null,
  ];
  return parts.filter((p): p is string => p !== null).join(" · ");
}

/**
 * Filename for a page's downloaded `.md` export: strip the `wiki/` prefix,
 * replace remaining `/` with `__`, append `.md`. `wiki/overview` ->
 * `overview.md`; `wiki/unit/apps-console` -> `unit__apps-console.md`.
 */
export function wikiMdFilename(slug: string): string {
  const withoutPrefix = slug.startsWith("wiki/") ? slug.slice("wiki/".length) : slug;
  const safe = withoutPrefix.replace(/\//g, "__").trim();
  return `${safe || "wiki-page"}.md`;
}

/**
 * The downloadable `.md` file content: a frontmatter-style header (the
 * fields the console actually has client-side — spec §4.1's frontmatter
 * shape, minus compiler-internal fields like `inputsHash` this DTO doesn't
 * carry) followed by `bodyMd` VERBATIM. Distinct from the Source toggle,
 * which shows `bodyMd` alone with no header added (that view's job is
 * showing exactly the stored column; this one's job is a self-describing
 * standalone export).
 */
export function buildWikiMarkdownDownload(page: WikiPageDTO): {
  filename: string;
  content: string;
} {
  const lines = [
    "---",
    `slug: ${page.slug}`,
    `title: ${page.title}`,
    `kind: ${page.kind}`,
    `commitSha: ${page.commitSha}`,
    `generatedAt: ${page.generatedAt}`,
  ];
  if (page.model) lines.push(`model: ${page.model}`);
  if (page.citations.length > 0) lines.push(`citations: [${page.citations.join(", ")}]`);
  lines.push("---", "", page.bodyMd);

  return { filename: wikiMdFilename(page.slug), content: lines.join("\n") };
}
