import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  Inbox,
  CreditCard,
  Brain,
  BookOpen,
  Users,
  Plug,
  GitMerge,
  MessageSquare,
  FileText,
  Layers3,
  History,
  Building2,
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
  /** Only the Evidence & context zone renders as a collapsible group. */
  collapsible: boolean;
  items: NavItem[];
}

// The customer shell foregrounds Jace's Trust Layer contract and human-decision
// seam. Factory-era Work, Chat, and Goals routes remain code-live for direct
// links and historical operation, but they are not presented as the product.
export const YOUR_ENGINEER_ZONE: NavZone = {
  id: "workflow", label: "Workflow", collapsible: false,
  items: [
    { label: "Office", href: "office", icon: Building2 },
    { label: "Work", href: "work", icon: LayoutDashboard },
    { label: "Runs", href: "runs", icon: History },
    { label: "Review Gates", href: "review-gates", icon: Inbox },
  ],
};
export const ENGINE_ROOM_ZONE: NavZone = {
  id: "context", label: "Context & diagnostics", collapsible: true,
  items: [
    { label: "Wiki", href: "wiki", icon: BookOpen },
    { label: "Memory", href: "memory", icon: Brain },
    { label: "Costs", href: "costs", icon: CreditCard },
    { label: "Failures", href: "failures", icon: Layers3 },
  ],
};
export const SETTINGS_ZONE: NavZone = {
  id: "settings", label: "Settings", collapsible: false,
  items: [
    { label: "Agents", href: "agents", icon: Plug },
    { label: "Team", href: "members", icon: Users },
    { label: "Budget", href: "budget", icon: CreditCard },
    { label: "Native runner", href: "native-work", icon: History },
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
 * True when `pathname` is inside any Evidence & context item, including nested
 * routes such as `/context-packs/[packId]`. Pure — no DOM/localStorage access
 * — so the "should the group auto-expand" decision is unit-testable.
 */
export function isEngineRoomRoute(pathname: string, basePath: string): boolean {
  return ENGINE_ROOM_ZONE.items.some((item) =>
    isNavItemActive(pathname, basePath, item.href)
  );
}

/**
 * Resolves whether the Evidence & context group should render open, given the
 * current route and the last value persisted to localStorage (or `null` if
 * unavailable, e.g. during SSR). A direct link into a visible context route
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
