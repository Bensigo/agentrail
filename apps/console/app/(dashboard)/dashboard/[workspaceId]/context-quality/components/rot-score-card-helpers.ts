/**
 * Pure helper functions for RotScoreCard — no React or browser dependencies.
 * Exported separately so node-env vitest can import and unit-test them.
 */

/** TASTE.md severity colors (dark mode): green ≤ 30, yellow 31–60, red > 60. */
export function severityColor(score: number): string {
  if (score <= 30) return "var(--green-11)";
  if (score <= 60) return "var(--yellow-11)";
  return "var(--red-11)";
}

/** Truncate an ID to 12 chars + ellipsis if longer. */
export function truncateId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) + "…" : id;
}

/** Format staleness as "Nd ago". Fractional days are floored. */
export function formatStaleness(days: number): string {
  return `${Math.floor(days)}d ago`;
}

/**
 * Map contributor type to the console resource path.
 * memory_item  → /dashboard/[wid]/memory
 * index_snapshot → /dashboard/[wid]/repos
 * hash_churn   → /dashboard/[wid]/repos  (source-file churn is a repo concern;
 *               the standalone context-packs page was removed)
 */
export function contributorHref(
  type: "memory_item" | "index_snapshot" | "hash_churn",
  workspaceId: string
): string {
  const base = `/dashboard/${workspaceId}`;
  if (type === "memory_item") return `${base}/memory`;
  return `${base}/repos`;
}

/** Domain label for contributor type. */
export function contributorTypeLabel(
  type: "memory_item" | "index_snapshot" | "hash_churn"
): string {
  if (type === "memory_item") return "Memory Item";
  if (type === "index_snapshot") return "Index Snapshot";
  return "Source Hash Churn";
}

/** Badge color tokens per type (bg/text pair). */
export function badgeColors(
  type: "memory_item" | "index_snapshot" | "hash_churn"
): { bg: string; text: string } {
  if (type === "memory_item") return { bg: "#0c2417", text: "var(--green-11)" };
  if (type === "index_snapshot") return { bg: "#1f1a08", text: "var(--yellow-11)" };
  return { bg: "#051a19", text: "var(--teal-11)" };
}
