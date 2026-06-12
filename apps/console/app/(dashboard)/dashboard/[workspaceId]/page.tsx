import { auth } from "@agentrail/auth";
import {
  getWorkspace,
  getWorkspaceMembership,
  getWorkspaceOverviewCounts,
} from "@agentrail/db-postgres";
import type { WorkspaceOverviewCounts } from "@agentrail/db-postgres";
import { getWorkspaceTelemetryCounts } from "@agentrail/db-clickhouse";
import type { WorkspaceTelemetryCounts } from "@agentrail/db-clickhouse";
import { notFound } from "next/navigation";
import Link from "next/link";
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

const EMPTY_COUNTS: WorkspaceOverviewCounts = {
  runs: 0,
  reviewGates: 0,
  repositories: 0,
  apiKeys: 0,
  teams: 0,
  members: 0,
  memoryItems: 0,
};

const EMPTY_TELEMETRY: WorkspaceTelemetryCounts = {
  contextPacks: 0,
  failures: 0,
  totalCostUsd: 0,
  totalTokens: 0,
};

function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

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

  let counts = EMPTY_COUNTS;
  try {
    counts = await getWorkspaceOverviewCounts(workspaceId);
  } catch {
    // Postgres counts unavailable; render zeros
  }
  let telemetry = EMPTY_TELEMETRY;
  try {
    telemetry = await getWorkspaceTelemetryCounts(workspaceId);
  } catch {
    // ClickHouse unavailable; render zeros
  }

  const sections = [
    { label: "Runs", icon: Play, href: "runs", value: String(counts.runs) },
    {
      label: "Context Packs",
      icon: Package,
      href: "context-packs",
      value: String(telemetry.contextPacks),
    },
    {
      label: "Failures",
      icon: AlertTriangle,
      href: "failures",
      value: String(telemetry.failures),
    },
    {
      label: "Review Gates",
      icon: ShieldCheck,
      href: "review-gates",
      value: String(counts.reviewGates),
    },
    {
      label: "Costs",
      icon: DollarSign,
      href: "costs",
      value: formatCost(telemetry.totalCostUsd),
      detail:
        telemetry.totalTokens > 0
          ? `${telemetry.totalTokens.toLocaleString()} tokens`
          : undefined,
    },
    {
      label: "Repos & Health",
      icon: Database,
      href: "repos",
      value: String(counts.repositories),
    },
    {
      label: "Memory",
      icon: Brain,
      href: "memory",
      value: String(counts.memoryItems),
    },
    {
      label: "API Keys",
      icon: Key,
      href: "api-keys",
      value: String(counts.apiKeys),
    },
    {
      label: "Team",
      icon: Users,
      href: "members",
      value: String(counts.members),
      detail:
        counts.teams > 0
          ? `${counts.teams} team${counts.teams === 1 ? "" : "s"}`
          : undefined,
    },
  ];

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
        {sections.map(({ label, icon: Icon, href, value, detail }) => (
          <Link
            key={label}
            href={`/dashboard/${workspaceId}/${href}`}
            className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4 transition-colors hover:border-[var(--gray-08)] hover:bg-[var(--gray-03)]"
          >
            <div className="flex items-center gap-2">
              <Icon className="h-4 w-4 text-[var(--gray-09)]" />
              <p className="text-xs uppercase tracking-wide text-[var(--gray-09)]">
                {label}
              </p>
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <p className="font-mono text-2xl font-bold text-[var(--gray-12)]">
                {value}
              </p>
              {detail ? (
                <p className="font-mono text-xs text-[var(--gray-09)]">{detail}</p>
              ) : null}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
