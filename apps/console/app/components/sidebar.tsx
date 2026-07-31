"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import { WorkspaceSwitcher } from "../(dashboard)/components/WorkspaceSwitcher";
import { EngineRoomGroup } from "./nav-group";
import { NavLink } from "./nav-link";
import {
  CHAT_NAV_ITEM,
  ENGINE_ROOM_ZONE,
  GOALS_NAV_ITEM,
  SETTINGS_ZONE,
  YOUR_ENGINEER_ZONE,
  type NavItem,
} from "./sidebar-nav";

/**
 * Costs/Budget/Wallet leave the customer-facing Engine room group
 * unconditionally (2026-07-31 owner ruling: the cost/budget UI is
 * redundant now that the product is subscription-based, so the
 * billing-swap flag that used to gate this filter is retired — see
 * subscription-platform spec §8 margin telemetry / staff-console seed).
 * Deliberately a nav-only demotion: the three pages stay code-live and
 * URL-reachable (direct links, breadcrumbs, staff access), only these
 * hrefs disappear from what gets rendered here.
 */
const BILLING_SWAP_HIDDEN_HREFS = new Set(["costs", "budget", "wallet"]);

/**
 * Pure filter (data in, data out — no JSX, no hooks) so it's unit-testable
 * without a React render pass: `Sidebar` below calls `usePathname()`, which
 * makes the component itself uncallable directly in this repo's hookless
 * vitest environment (see `sidebar.test.tsx`'s header comment). Exported
 * solely to make this piece independently testable, same "extract the pure
 * part" move `digest-panel.tsx` makes with `PlanCardBlock`.
 */
export function filterEngineRoomItems(items: NavItem[]): NavItem[] {
  return items.filter((item) => !BILLING_SWAP_HIDDEN_HREFS.has(item.href));
}

interface SidebarProps {
  workspaces: { id: string; name: string; slug: string; role: string }[];
  workspaceId: string;
  user: { name?: string | null; email?: string | null; image?: string | null };
  signOutAction: () => Promise<void>;
  /** Console chat (#1288), default OFF — computed server-side
   * (`isConsoleChatEnabled`) by the layout that renders this. `undefined`
   * (the Suspense fallback's render, before the real value is known) reads
   * as off, so the item never flashes in then disappears. */
  chatEnabled?: boolean;
  /** Goal loop (#1289 AC2), default OFF — computed server-side
   * (`isGoalLoopEnabled`) by the layout that renders this, same "undefined
   * reads as off" posture as `chatEnabled` above. */
  goalsEnabled?: boolean;
}

export function Sidebar({
  workspaces,
  workspaceId,
  user,
  signOutAction,
  chatEnabled = false,
  goalsEnabled = false,
}: SidebarProps) {
  const pathname = usePathname();
  const basePath = `/dashboard/${workspaceId}`;
  const engineerItems = [
    ...YOUR_ENGINEER_ZONE.items,
    ...(goalsEnabled ? [GOALS_NAV_ITEM] : []),
    ...(chatEnabled ? [CHAT_NAV_ITEM] : []),
  ];
  const engineRoomItems = filterEngineRoomItems(ENGINE_ROOM_ZONE.items);

  return (
    <aside className="fixed left-0 top-0 z-40 flex h-screen w-[220px] flex-col border-r border-[var(--gray-05)] bg-[var(--gray-01)] max-md:w-12">
      <div className="flex h-12 items-center gap-2 border-b border-[var(--gray-05)] px-3 max-md:justify-center max-md:px-0">
        {/* The product is Jace (CONTEXT.md: "AgentRail is the SDLC factory CLI
            underneath him"); the console is his evidence room, so the chrome
            carries his name and the canonical mascot disc — the same asset the
            auth shell fronts its cards with (TASTE.md mascot canon). The disc
            doubles as the collapsed-rail mark, replacing the bare "A". */}
        <Image
          src="/jace-avatar.png"
          alt=""
          width={24}
          height={24}
          priority
          className="rounded-full"
        />
        <span className="text-sm font-bold text-[var(--gray-12)] max-md:hidden">
          Jace
        </span>
      </div>

      <div className="border-b border-[var(--gray-04)] px-2 py-2 max-md:hidden">
        <WorkspaceSwitcher workspaces={workspaces} activeId={workspaceId} />
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-2">
        <p className="px-2 py-1 text-xs font-normal uppercase tracking-wide text-[var(--gray-09)] max-md:hidden">
          {YOUR_ENGINEER_ZONE.label}
        </p>
        {engineerItems.map((item) => (
          <NavLink key={item.href} item={item} basePath={basePath} pathname={pathname} />
        ))}

        <EngineRoomGroup
          zone={{ ...ENGINE_ROOM_ZONE, items: engineRoomItems }}
          pathname={pathname}
          basePath={basePath}
        />

        <p className="mt-3 px-2 py-1 text-xs font-normal uppercase tracking-wide text-[var(--gray-09)] max-md:hidden">
          {SETTINGS_ZONE.label}
        </p>
        {SETTINGS_ZONE.items.map((item) => (
          <NavLink key={item.href} item={item} basePath={basePath} pathname={pathname} />
        ))}
      </nav>

      <div className="border-t border-[var(--gray-04)] p-2">
        <div className="flex items-center gap-2 max-md:justify-center">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--gray-04)] text-xs font-bold text-[var(--gray-12)]">
            {(user.name?.[0] ?? user.email?.[0] ?? "U").toUpperCase()}
          </div>
          <div className="flex-1 overflow-hidden max-md:hidden">
            <p className="truncate text-xs font-normal text-[var(--gray-12)]">
              {user.name ?? "User"}
            </p>
            <form action={signOutAction}>
              <button
                type="submit"
                className="text-xs text-[var(--gray-09)] transition-colors hover:text-[var(--gray-12)]"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </div>
    </aside>
  );
}
