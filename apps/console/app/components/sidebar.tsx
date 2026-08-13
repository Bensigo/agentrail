"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import { WorkspaceSwitcher } from "../(dashboard)/components/WorkspaceSwitcher";
import { EngineRoomGroup } from "./nav-group";
import { NavLink } from "./nav-link";
import {
  ENGINE_ROOM_ZONE,
  SETTINGS_ZONE,
  YOUR_ENGINEER_ZONE,
  type NavItem,
} from "./sidebar-nav";

/**
 * Resolve the primary customer navigation independently of legacy Chat and
 * Goal-loop feature flags. The routes and flags remain live, but neither is a
 * Trust Layer product-shell destination.
 */
export function resolvePrimaryNavItems(options?: {
  chatEnabled?: boolean;
  goalsEnabled?: boolean;
}): readonly NavItem[] {
  void options;
  return YOUR_ENGINEER_ZONE.items;
}

interface SidebarProps {
  workspaces: { id: string; name: string; slug: string; role: string }[];
  workspaceId: string;
  user: { name?: string | null; email?: string | null; image?: string | null };
  signOutAction: () => Promise<void>;
  /** Legacy route flag retained for caller compatibility; not shown in nav. */
  chatEnabled?: boolean;
  /** Legacy route flag retained for caller compatibility; not shown in nav. */
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
  const primaryItems = resolvePrimaryNavItems({ chatEnabled, goalsEnabled });

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
        {primaryItems.map((item) => (
          <NavLink
            key={item.href}
            item={item}
            basePath={basePath}
            pathname={pathname}
          />
        ))}

        <EngineRoomGroup
          zone={ENGINE_ROOM_ZONE}
          pathname={pathname}
          basePath={basePath}
        />

        <p className="mt-3 px-2 py-1 text-xs font-normal uppercase tracking-wide text-[var(--gray-09)] max-md:hidden">
          {SETTINGS_ZONE.label}
        </p>
        {SETTINGS_ZONE.items.map((item) => (
          <NavLink
            key={item.href}
            item={item}
            basePath={basePath}
            pathname={pathname}
          />
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
