import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  Play,
  ListChecks,
  AlertTriangle,
  ShieldCheck,
  DollarSign,
  TrendingUp,
  Database,
  Brain,
  Key,
  Users,
  UsersRound,
  Activity,
  Plug,
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

// Slice ① (#1229) is a pure sidebar regroup — no route/href changes. The
// existing overview route is relabeled "Home" and Issue Queue keeps its href
// (it becomes "Work" in a later slice, per the IA spec §3).
export const YOUR_ENGINEER_ZONE: NavZone = {
  id: "your-engineer",
  label: "Your engineer",
  collapsible: false,
  items: [
    { label: "Home", href: "", icon: LayoutDashboard },
    { label: "Issue Queue", href: "queue", icon: ListChecks },
  ],
};

// Demoted, existing evidence pages — collapsed by default, reached primarily
// by drilling into a work item (spec §3).
export const ENGINE_ROOM_ZONE: NavZone = {
  id: "engine-room",
  label: "Engine room",
  collapsible: true,
  items: [
    { label: "Runs", href: "runs", icon: Play },
    { label: "Review Gates", href: "review-gates", icon: ShieldCheck },
    { label: "Costs", href: "costs", icon: DollarSign },
    { label: "Scorecard", href: "scorecard", icon: TrendingUp },
    { label: "Context Quality", href: "context-quality", icon: Activity },
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
    { label: "Team", href: "members", icon: Users },
    // New link: the `teams` page already exists but wasn't reachable from nav.
    { label: "Teams", href: "teams", icon: UsersRound },
    { label: "API Keys", href: "api-keys", icon: Key },
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
