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
  /** ISO `generatedAt` of the NEWEST page, or null when there are no pages —
   * the Postgres-backed, always-available basis for "compiled <age> ago"
   * (see `resolveCompiledAt`). Wiki freshness leads (owner ruling): this
   * number must never depend on ClickHouse being reachable. */
  newestGeneratedAt: string | null;
}

/**
 * Falsifiable summary strip inputs (Repo Wiki spec §4.5: "pages count, stale
 * count, oldest generatedAt age ... nothing that can't go negative/zero").
 * Every field here can go to zero and is read straight off `wiki_pages` rows
 * — no derived "knowledge score".
 */
export function computeWikiSummaryStats(pages: WikiPageDTO[]): WikiSummaryStats {
  if (pages.length === 0) {
    return { pageCount: 0, staleCount: 0, oldestGeneratedAt: null, newestGeneratedAt: null };
  }
  const staleCount = pages.filter((p) => p.stale).length;
  const oldestGeneratedAt = pages.reduce(
    (oldest, p) => (p.generatedAt < oldest ? p.generatedAt : oldest),
    pages[0]!.generatedAt
  );
  const newestGeneratedAt = pages.reduce(
    (newest, p) => (p.generatedAt > newest ? p.generatedAt : newest),
    pages[0]!.generatedAt
  );
  return { pageCount: pages.length, staleCount, oldestGeneratedAt, newestGeneratedAt };
}

/**
 * The wiki header's PRIMARY freshness signal (owner ruling: wiki freshness
 * leads over index health — they're different facts, never conflated into
 * one number). Prefers the ClickHouse compile event's `createdAt` when it's
 * already available (the whole-batch event, precise to the compile that
 * produced the current page set) but falls back to the newest page's own
 * `generatedAt` — Postgres, always present whenever `pages` is non-empty —
 * so "when was this compiled" NEVER blanks out just because the ClickHouse
 * analytics store is unconfigured/unreachable.
 */
export function resolveCompiledAt(
  newestPageGeneratedAt: string | null,
  latestCompile: { createdAt: string } | null
): string | null {
  return latestCompile?.createdAt ?? newestPageGeneratedAt;
}

/** "12 pages · compiled 3m ago" / "0 pages · not compiled yet" — the wiki
 * header's primary line (see `resolveCompiledAt`'s doc comment: built
 * entirely from Postgres-backed facts, never blocked by a ClickHouse
 * outage). Falsifiable-only rule: `pageCount` can be zero and stays
 * representable, same as `formatPageCount` on its own. */
export function formatWikiFreshnessLine(
  pageCount: number,
  compiledAt: string | null,
  now: number = Date.now()
): string {
  const compiledPart = compiledAt ? `compiled ${formatRelativeAge(compiledAt, now)}` : "not compiled yet";
  return `${formatPageCount(pageCount)} · ${compiledPart}`;
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

/** Title-case health word for display ("healthy" -> "Healthy", "unknown" ->
 * "Unknown") — mirrors the platform's other status-label maps
 * (`run-status-label.ts`'s `runStatusLabel`), rather than showing the raw
 * lowercase enum value the former repos-table's cells used verbatim. Purely
 * a word — callers own the color (see `wiki-repo-header.tsx`'s
 * `HEALTH_DOT_CLASS`), and "unknown" must always render neutral, never red. */
export function healthStatusLabel(status: HealthStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** "1 page" / "12 pages" — the wiki-first header's page-count fact. */
export function formatPageCount(count: number): string {
  return `${count} ${count === 1 ? "page" : "pages"}`;
}

/**
 * Wiki UX hierarchy fix (owner feedback: knowledge was buried under a repo
 * table — "am I supposed to click the repo to see the wiki?"). Index health
 * is now a SECONDARY, clearly-labeled detail line under the wiki-freshness
 * primary line (`formatWikiFreshnessLine`) for both single- and multi-repo
 * headers alike (`wiki-repo-header.tsx`'s `IndexHealthLine`) — it and the
 * wiki's own freshness are different facts, never conflated into one number.
 * One plain "·"-joined string: every segment here shares identical muted
 * styling, so there's no need for the per-segment JSX `ProvenanceBar` uses
 * when parts carry different colors/weights.
 *
 * Honest-copy rule: a missing `lastIndexedAt` renders "—", never the word
 * "never" — we don't actually know it was never indexed, only that we have
 * no timestamp (see `lib/repo-health.ts`'s `"unknown"` state: that's true
 * both for a repo that's genuinely never been indexed AND for a ClickHouse
 * outage, and this formatter can't and shouldn't guess which).
 */
export function formatRepoDetailLine(repo: RepoListItem, now: number = Date.now()): string {
  const parts = [
    healthStatusLabel(repo.healthStatus),
    `last indexed ${repo.lastIndexedAt ? formatRelativeAge(repo.lastIndexedAt, now) : "—"}`,
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
