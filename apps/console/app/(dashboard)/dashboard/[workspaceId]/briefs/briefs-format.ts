import type {
  BriefArea,
  BriefAuthority,
  BriefItem,
  BriefItemKind,
  BriefItemResolution,
  BriefItemState,
} from "@agentrail/db-postgres";

/**
 * Pure formatting/grouping helpers for the console Briefs pages (design
 * spec: docs/superpowers/specs/2026-07-28-jace-briefs-durable-idea-understanding-design.md,
 * spec PR #1487/#1489). Kept dependency-free (no React) so they're testable
 * the same way `wiki-format.ts`/`wiki-tree.ts` are — a plain vitest file, no
 * DOM/render harness needed.
 */

/**
 * Canonical display order for grill-me's five coverage areas (design spec's
 * `area` field table). Deliberately fixed, not derived
 * from whatever items happen to exist, so a brief with nothing yet in
 * `success-signal` still SHOWS that area as empty — the gap itself is
 * signal a human reading this page needs ("what has Jace not even asked
 * about"), not something to hide by only rendering areas with content.
 */
export const AREA_ORDER: BriefArea[] = [
  "problem",
  "users",
  "constraints",
  "scope",
  "success-signal",
];

export const AREA_LABELS: Record<BriefArea, string> = {
  problem: "Problem",
  users: "Users",
  constraints: "Constraints",
  scope: "Scope",
  "success-signal": "Success signal",
};

export const KIND_LABELS: Record<BriefItemKind, string> = {
  required: "Required",
  optional: "Optional",
  unknown: "Unknown",
  "out-of-scope": "Out of scope",
};

export const STATE_LABELS: Record<BriefItemState, string> = {
  open: "Open",
  resolved: "Resolved",
};

export const RESOLUTION_LABELS: Record<BriefItemResolution, string> = {
  implemented: "Implemented",
  deferred: "Deferred",
  rejected: "Rejected",
  "satisfied-elsewhere": "Satisfied elsewhere",
};

export const AUTHORITY_LABELS: Record<BriefAuthority, string> = {
  human: "Human",
  jace: "Jace",
};

/**
 * Every item for `area`, in canonical order — every area from `AREA_ORDER`
 * is present as a key even when it has zero items (see this module's
 * doc-comment on `AREA_ORDER` for why an empty area must still render).
 * Items within an area keep whatever order the caller passed in (the store
 * layer already orders by `createdAt`, oldest-first — see
 * `fetchItemsForBriefIds`'s own doc-comment — so a resumed conversation
 * reads items in the order they were settled).
 */
export function groupItemsByArea(items: BriefItem[]): Record<BriefArea, BriefItem[]> {
  const grouped = Object.fromEntries(AREA_ORDER.map((area) => [area, [] as BriefItem[]])) as Record<
    BriefArea,
    BriefItem[]
  >;
  for (const item of items) {
    grouped[item.area]?.push(item);
  }
  return grouped;
}

/**
 * Mirrors `computeBriefReadiness`'s own predicate exactly (`state === "open"
 * && kind === "unknown"`) so the console can highlight the SAME items the
 * store-side gate blocks on, without needing a second round trip per item —
 * `computeBriefReadiness`'s own DB query is still what the page calls for
 * the authoritative `ready` boolean; this is purely a per-item display
 * helper (e.g. which item card gets the "blocks to-issues" flag).
 */
export function isBlockingItem(item: Pick<BriefItem, "state" | "kind">): boolean {
  return item.state === "open" && item.kind === "unknown";
}

/** `YYYY-MM-DDTHH:mm` relative-ish absolute stamp for a hover title — matches the review-gates page's own `relTime`-adjacent convention of always keeping a real timestamp available, not just a relative label. */
export function formatAbsoluteTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toLocaleString();
}

/** Compact relative time ("3m ago", "2d ago") — same shape review-gates'
 * page-local `relTime` uses, duplicated rather than imported since that one
 * lives in a sibling feature's page.tsx, not a shared module. */
export function formatRelativeTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const diffMs = Date.now() - d.getTime();
  const m = Math.round(diffMs / 60000);
  const h = Math.round(diffMs / 3600000);
  const days = Math.round(diffMs / 86400000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${days}d ago`;
}
