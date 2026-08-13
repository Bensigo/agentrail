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
  id: "your-engineer",
  label: "Trust layer",
  collapsible: false,
  items: [
    { label: "Home", href: "", icon: LayoutDashboard },
    { label: "Briefs", href: "briefs", icon: FileText },
    { label: "Acceptance Records", href: "changes", icon: History },
    { label: "Approvals", href: "approvals", icon: Inbox },
  ],
};

// Useful customer-facing context stores remain visible. Factory operations
// (runs, review gates, costs, budgets, model selection, investigations, and
// failures) remain URL-reachable but are intentionally absent from this list.
export const ENGINE_ROOM_ZONE: NavZone = {
  id: "engine-room",
  label: "Evidence & context",
  collapsible: true,
  items: [
    { label: "Memory", href: "memory", icon: Brain },
    { label: "Wiki", href: "wiki", icon: BookOpen },
    { label: "Context Packs", href: "context-packs", icon: Layers3 },
  ],
};

export const SETTINGS_ZONE: NavZone = {
  id: "settings",
  label: "Settings",
  collapsible: false,
  items: [
    // Keep the established route while naming the customer-facing surface by
    // what it connects: the channels where a human talks with Jace.
    { label: "Channels", href: "gateways", icon: MessageSquare },
    { label: "Connectors", href: "connectors", icon: Plug },
    // No separate "Repos & Health" item: Repos & Health folded into the Wiki
    // view (owner ruling) — the wiki is now the per-repo evidence page (repo
    // list with health chips + the compiled wiki, one surface instead of
    // two). /repos is a redirect stub to /wiki, same shape as /queue -> /work
    // and teams/page.tsx -> /members: old deep links keep working, nav entry
    // gone.
    // No separate Teams item: teams/page.tsx is a redirect stub to /members —
    // the combined Team page covers the spec's Settings-zone "Teams" entry.
    { label: "Team", href: "members", icon: Users },
    // No "API Keys" item: the in-console key list/create/revoke UI was
    // removed (owner ruling, 2026-07-19) — self-hosters mint keys via
    // `agentrail login` (device flow, browser half at /activate) per the
    // docs' self-hosting page. The api_keys table and every /api/v1 route
    // that reads it are untouched; this is a nav-only removal.
    // Permissions preserves the route for the explicit Trust Layer authority
    // boundary and owner-only revocation of any historical factory merge grant.
    { label: "Permissions", href: "permissions", icon: GitMerge },
    // Subscription plan and customer-portal management stay in Settings.
    { label: "Plan & billing", href: "billing", icon: CreditCard },
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
