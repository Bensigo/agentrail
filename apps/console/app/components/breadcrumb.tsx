"use client";

import { usePathname } from "next/navigation";

// Duplicate of the sidebar's grouping in ./sidebar-nav — keep in sync when
// the nav changes (#1229, renamed #1231). "queue" stays mapped to its old
// label for the instant before its redirect fires; "work" is the real nav
// destination now (spec §3).
const SEGMENT_LABELS: Record<string, string> = {
  runs: "Runs",
  work: "Work",
  queue: "Issue Queue",
  connectors: "Connectors",
  failures: "Failures",
  "review-gates": "Review Gates",
  costs: "Costs",
  scorecard: "Scorecard",
  "context-quality": "Context Quality",
  repos: "Repos & Health",
  memory: "Memory",
  "api-keys": "API Keys",
  members: "Team",
  teams: "Teams",
};

/**
 * Derives a page-title breadcrumb from the current route.
 * Placed in the h-12 top bar left slot; falls back to "Home" at the
 * workspace root (the former "Overview" route, renamed #1229).
 */
export function TopBarBreadcrumb() {
  const pathname = usePathname();
  // Extract the segment after /dashboard/[workspaceId]/
  const match = pathname.match(/\/dashboard\/[^/]+\/([^/]+)/);
  const segment = match?.[1] ?? "";
  const label = SEGMENT_LABELS[segment] ?? "Home";

  return (
    <p className="text-sm font-medium text-[var(--gray-12)]">{label}</p>
  );
}
