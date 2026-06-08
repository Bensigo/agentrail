import { auth } from "@agentrail/auth";
import { getWorkspace, getWorkspaceMembership } from "@agentrail/db-postgres";
import { notFound } from "next/navigation";
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

const sections = [
  { label: "Runs", icon: Play, href: "runs" },
  { label: "Context Packs", icon: Package, href: "context-packs" },
  { label: "Failures", icon: AlertTriangle, href: "failures" },
  { label: "Review Gates", icon: ShieldCheck, href: "review-gates" },
  { label: "Costs", icon: DollarSign, href: "costs" },
  { label: "Repos & Health", icon: Database, href: "repos" },
  { label: "Memory", icon: Brain, href: "memory" },
  { label: "API Keys", icon: Key, href: "api-keys" },
  { label: "Teams", icon: Users, href: "teams" },
];

export default async function WorkspaceDashboardPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const session = await auth();
  if (!session?.user?.id) return notFound();

  const [workspace, membership] = await Promise.all([
    getWorkspace(workspaceId),
    getWorkspaceMembership(session.user.id, workspaceId),
  ]);

  if (!workspace || !membership) return notFound();

  return (
    <div className="mx-auto max-w-[1440px]">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-[var(--gray-12)]">
          {workspace.name}
        </h1>
        <span className="rounded-sm bg-[var(--gray-03)] px-1.5 py-0.5 text-xs font-medium text-[var(--gray-09)]">
          {membership.role}
        </span>
      </div>
      <p className="mt-1 font-mono text-xs text-[var(--gray-09)]">
        {workspace.slug} · {workspace.id}
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {sections.map(({ label, icon: Icon }) => (
          <div
            key={label}
            className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4"
          >
            <div className="flex items-center gap-2">
              <Icon className="h-4 w-4 text-[var(--gray-09)]" />
              <p className="text-xs uppercase tracking-wide text-[var(--gray-09)]">
                {label}
              </p>
            </div>
            <p className="mt-2 font-mono text-2xl font-bold text-[var(--gray-12)]">
              —
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
