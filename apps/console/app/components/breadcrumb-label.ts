// Pure route→label mapping for the top-bar breadcrumb, kept in a plain `.ts`
// file (not inside breadcrumb.tsx) so it can be unit-tested — console vitest
// has no react plugin; mirrors the sibling convention (`sidebar-nav.ts`,
// `runs/components/run-status-label.ts`).
//
// Duplicate of the sidebar's grouping in ./sidebar-nav — keep in sync when
// the nav changes (#1229, renamed #1231, budget added #1272, approvals added
// #1276, permissions added #1278, api-keys removed 2026-07-19 owner ruling,
// wiki added repo wiki 6/7; breadcrumb.test.ts now enforces the sync).
// "queue" stays mapped to its old label for the instant before its redirect
// fires; "work" is the real nav destination now (spec §3).
export const SEGMENT_LABELS: Record<string, string> = {
  runs: "Runs",
  work: "Work",
  approvals: "Approvals",
  queue: "Issue Queue",
  connectors: "Connectors",
  failures: "Failures",
  "review-gates": "Review Gates",
  costs: "Costs",
  budget: "Budget",
  "model-selection": "Model selection",
  repos: "Repos & Health",
  memory: "Memory",
  wiki: "Wiki",
  members: "Team",
  teams: "Teams",
  permissions: "Permissions",
};

/**
 * Page-title label for the current route: the segment after
 * `/dashboard/[workspaceId]/`, mapped through SEGMENT_LABELS; falls back to
 * "Home" at the workspace root (the former "Overview" route, renamed #1229)
 * and for unknown segments.
 */
export function breadcrumbLabel(pathname: string): string {
  const match = pathname.match(/\/dashboard\/[^/]+\/([^/]+)/);
  const segment = match?.[1] ?? "";
  return SEGMENT_LABELS[segment] ?? "Home";
}
