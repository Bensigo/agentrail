import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  Play,
  ListChecks,
  Inbox,
  AlertTriangle,
  ShieldCheck,
  DollarSign,
  Wallet,
  Database,
  Brain,
  Key,
  Users,
  Plug,
  GitMerge,
} from "lucide-react";

export interface NavItem {
  label: string;
  /** Relative to the workspace base path (`/dashboard/[workspaceId]`); "" = the workspace root. */
  href: string;
  icon: LucideIcon;
}

export interface NavZone {
  id: string;
  label: string;
  /** Only the Engine room zone renders as a collapsible group; the others are plain sections. */
  collapsible: boolean;
  items: NavItem[];
}

// Slice ① (#1229) was a pure sidebar regroup — no route/href changes. Slice ③
// (#1231) renames Issue Queue to "Work" and moves its href from `queue` to
// `work` (spec §3/§4): `/work` is the new task-list page and `/queue`
// redirects to it, so old deep links keep working without staying in the nav.
// "Approvals" (#1276) is an action surface, not evidence — it's where a
// human resolves pending tool-call approvals, parked work, and dead-lettered
// channel messages, so it belongs here rather than in the demoted Engine
// room zone below (that zone is explicitly for "existing evidence" pages).
export const YOUR_ENGINEER_ZONE: NavZone = {
  id: "your-engineer",
  label: "Your engineer",
  collapsible: false,
  items: [
    { label: "Home", href: "", icon: LayoutDashboard },
    { label: "Work", href: "work", icon: ListChecks },
    { label: "Approvals", href: "approvals", icon: Inbox },
  ],
};

// Demoted, existing evidence pages — collapsed by default, reached primarily
// by drilling into a work item (spec §3).
//
// "Budget" (#1272 PR ②) is deliberately a separate item from "Costs", not a
// tab folded into it: "Costs" is the ClickHouse-backed granular meter
// (cost-per-issue-to-green, cache ratio, anomalies — ADR 0009), a real,
// already-shipped, unrelated surface. "Budget" is the Postgres-backed
// workspace-level view (this month's per-task costs, the trailing monthly
// rollup, and the #1269 monthly $ ceiling's cap status) — same zone, same
// "operational depth" category, different data source and question ("is
// this workspace blocked right now" vs "where did the tokens go").
export const ENGINE_ROOM_ZONE: NavZone = {
  id: "engine-room",
  label: "Engine room",
  collapsible: true,
  items: [
    { label: "Runs", href: "runs", icon: Play },
    { label: "Review Gates", href: "review-gates", icon: ShieldCheck },
    { label: "Costs", href: "costs", icon: DollarSign },
    { label: "Budget", href: "budget", icon: Wallet },
    { label: "Memory", href: "memory", icon: Brain },
    { label: "Failures", href: "failures", icon: AlertTriangle },
  ],
};

export const SETTINGS_ZONE: NavZone = {
  id: "settings",
  label: "Settings",
  collapsible: false,
  items: [
    { label: "Connectors", href: "connectors", icon: Plug },
    { label: "Repos & Health", href: "repos", icon: Database },
    // No separate Teams item: teams/page.tsx is a redirect stub to /members —
    // the combined Team page covers the spec's Settings-zone "Teams" entry.
    { label: "Team", href: "members", icon: Users },
    { label: "API Keys", href: "api-keys", icon: Key },
    // "Permissions" (#1278): the owner-only grantable-trust-setting surface —
    // today just merge permission (green gate -> merges itself vs. PR-only).
    // No prior "workspace settings" page existed to fold this into; this is
    // the seed of one, sized to what's real today (v1 = one setting).
    { label: "Permissions", href: "permissions", icon: GitMerge },
  ],
};

export const NAV_ZONES: readonly NavZone[] = [
  YOUR_ENGINEER_ZONE,
  ENGINE_ROOM_ZONE,
  SETTINGS_ZONE,
];

export const ENGINE_ROOM_STORAGE_KEY = "agentrail:sidebar:engine-room-open";

/**
 * Whether `href` (relative to `basePath`) is the item that matches `pathname`.
 * The root item ("" href, e.g. Home) must match exactly — a startsWith check
 * would keep it highlighted on every sub-route under the workspace.
 */
export function isNavItemActive(
  pathname: string,
  basePath: string,
  href: string
): boolean {
  if (!href) {
    return pathname === basePath || pathname === `${basePath}/`;
  }
  return pathname.startsWith(`${basePath}/${href}`);
}

/**
 * True when `pathname` is inside any Engine room item, including nested
 * routes such as `/runs/[runId]`. Pure — no DOM/localStorage access — so the
 * "should the group auto-expand" decision is unit-testable on its own.
 */
export function isEngineRoomRoute(pathname: string, basePath: string): boolean {
  return ENGINE_ROOM_ZONE.items.some((item) =>
    isNavItemActive(pathname, basePath, item.href)
  );
}

/**
 * Resolves whether the Engine room group should render open, given the
 * current route and the last value persisted to localStorage (or `null` if
 * unavailable, e.g. during SSR). A direct deep link into an engine-room route
 * always wins over the persisted preference; otherwise the persisted value is
 * used, defaulting to collapsed.
 */
export function resolveEngineRoomOpen(
  pathname: string,
  basePath: string,
  storedValue: string | null
): boolean {
  if (isEngineRoomRoute(pathname, basePath)) {
    return true;
  }
  return storedValue === "true";
}
