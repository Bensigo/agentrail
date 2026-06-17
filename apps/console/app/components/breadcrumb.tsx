"use client";

import { usePathname } from "next/navigation";

const SEGMENT_LABELS: Record<string, string> = {
  runs: "Runs",
  failures: "Failures",
  "review-gates": "Review Gates",
  costs: "Costs",
  scorecard: "Scorecard",
  "context-quality": "Context Quality",
  repos: "Repos & Health",
  memory: "Memory",
  "api-keys": "API Keys",
  members: "Team",
};

/**
 * Derives a page-title breadcrumb from the current route.
 * Placed in the h-12 top bar left slot; falls back to "Overview" at the
 * workspace root.
 */
export function TopBarBreadcrumb() {
  const pathname = usePathname();
  // Extract the segment after /dashboard/[workspaceId]/
  const match = pathname.match(/\/dashboard\/[^/]+\/([^/]+)/);
  const segment = match?.[1] ?? "";
  const label = SEGMENT_LABELS[segment] ?? "Overview";

  return (
    <p className="text-sm font-medium text-[var(--gray-12)]">{label}</p>
  );
}
