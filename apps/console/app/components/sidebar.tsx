"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Play,
  Package,
  AlertTriangle,
  ShieldCheck,
  DollarSign,
  Database,
  Brain,
  Key,
  Users,
} from "lucide-react";
import { WorkspaceSwitcher } from "./workspace-switcher";

interface SidebarProps {
  workspaces: { id: string; name: string; slug: string; role: string }[];
  workspaceId: string;
  user: { name?: string | null; email?: string | null; image?: string | null };
  signOutAction: () => Promise<void>;
}

const navItems = [
  { label: "Runs", href: "runs", icon: Play },
  { label: "Context Packs", href: "context-packs", icon: Package },
  { label: "Failures", href: "failures", icon: AlertTriangle },
  { label: "Review Gates", href: "review-gates", icon: ShieldCheck },
  { label: "Costs", href: "costs", icon: DollarSign },
  { label: "Repos & Health", href: "repos", icon: Database },
  { label: "Memory", href: "memory", icon: Brain },
  { label: "API Keys", href: "api-keys", icon: Key },
  { label: "Teams", href: "teams", icon: Users },
];

export function Sidebar({ workspaces, workspaceId, user, signOutAction }: SidebarProps) {
  const pathname = usePathname();
  const basePath = `/dashboard/${workspaceId}`;

  return (
    <aside className="fixed left-0 top-0 z-40 flex h-screen w-[220px] flex-col border-r border-[var(--gray-05)] bg-[var(--gray-01)] max-md:w-12">
      <div className="flex h-12 items-center gap-2 border-b border-[var(--gray-05)] px-3 max-md:justify-center max-md:px-0">
        <span className="text-sm font-bold text-[var(--gray-12)] max-md:hidden">
          AgentRail
        </span>
        <span className="hidden text-sm font-bold text-[var(--gray-12)] max-md:block">
          A
        </span>
      </div>

      <div className="border-b border-[var(--gray-04)] px-2 py-2 max-md:hidden">
        <WorkspaceSwitcher workspaces={workspaces} />
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-2">
        {navItems.map(({ label, href, icon: Icon }) => {
          const fullHref = `${basePath}/${href}`;
          const isActive = pathname.startsWith(fullHref);
          return (
            <Link
              key={href}
              href={fullHref}
              className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors duration-150 max-md:justify-center max-md:px-0 ${
                isActive
                  ? "bg-[var(--gray-03)] text-[var(--brand-accent)]"
                  : "text-[var(--gray-11)] hover:bg-[var(--gray-02)] hover:text-[var(--gray-12)]"
              }`}
              title={label}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="max-md:hidden">{label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-[var(--gray-04)] p-2">
        <div className="flex items-center gap-2 max-md:justify-center">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--gray-04)] text-xs font-bold text-[var(--gray-12)]">
            {(user.name?.[0] ?? user.email?.[0] ?? "U").toUpperCase()}
          </div>
          <div className="flex-1 overflow-hidden max-md:hidden">
            <p className="truncate text-xs font-medium text-[var(--gray-12)]">
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
