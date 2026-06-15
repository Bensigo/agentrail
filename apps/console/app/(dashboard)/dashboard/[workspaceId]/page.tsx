import { Suspense } from "react";
import { getWorkspace, getWorkspaceOverviewCounts } from "@agentrail/db-postgres";
import { getWorkspaceTelemetryCounts } from "@agentrail/db-clickhouse";
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
import {
  SkeletonCardGrid,
  SkeletonStatHeader,
} from "../../../components/loading-skeleton";
import { getMembership, getSession } from "../../../../lib/cached";
import { PageHeader } from "../../../components/page-header";
import { StatHeader } from "../../../components/stat-header";
import type { StatItem } from "../../../components/stat-header";
import { ErrorState } from "../../../components/error-state";

function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function formatCount(n: number): string {
  return n.toLocaleString();
}

function EmptyCallout() {
  return (
    <div className="mb-4 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-4 py-3">
      <p className="text-xs text-[var(--gray-10)]">
        <span className="font-medium text-[var(--gray-11)]">No activity yet</span>
        {" — create a run to get started."}
      </p>
    </div>
  );
}

// Streams in behind a Suspense boundary. Fetches both backends in parallel
// via allSettled so one failure does not block the other section from rendering.
async function DashboardContent({ workspaceId }: { workspaceId: string }) {
  const [pgResult, chResult] = await Promise.allSettled([
    getWorkspaceOverviewCounts(workspaceId),
    getWorkspaceTelemetryCounts(workspaceId),
  ]);

  const pgOk = pgResult.status === "fulfilled";
  const chOk = chResult.status === "fulfilled";

  const counts = pgOk ? pgResult.value : null;
  const telemetry = chOk ? chResult.value : null;

  // Show the empty callout only when both sources are healthy and all zeros.
  const allZero =
    pgOk &&
    chOk &&
    counts!.runs === 0 &&
    counts!.reviewGates === 0 &&
    counts!.repositories === 0 &&
    counts!.apiKeys === 0 &&
    counts!.teams === 0 &&
    counts!.members === 0 &&
    counts!.memoryItems === 0 &&
    telemetry!.contextPacks === 0 &&
    telemetry!.failures === 0 &&
    telemetry!.totalCostUsd === 0;

  // Stat row: runs from PG (shown as — when PG is down), rest from CH.
  // If CH is unavailable the entire stat row section shows ErrorState.
  const statItems: StatItem[] = [
    {
      label: "Runs",
      value: counts ? formatCount(counts.runs) : "—",
    },
    {
      label: "Failures",
      value: telemetry ? formatCount(telemetry.failures) : "—",
      tone:
        telemetry && telemetry.failures > 0 ? "error" : "default",
    },
    {
      label: "Cost",
      value: telemetry ? formatCost(telemetry.totalCostUsd) : "—",
    },
    {
      label: "Context Packs",
      value: telemetry ? formatCount(telemetry.contextPacks) : "—",
    },
  ];

  const sections = [
    {
      label: "Runs",
      icon: Play,
      href: "runs",
      value: counts ? formatCount(counts.runs) : "—",
    },
    {
      label: "Context Packs",
      icon: Package,
      href: "context-packs",
      value: telemetry ? formatCount(telemetry.contextPacks) : "—",
    },
    {
      label: "Failures",
      icon: AlertTriangle,
      href: "failures",
      value: telemetry ? formatCount(telemetry.failures) : "—",
    },
    {
      label: "Review Gates",
      icon: ShieldCheck,
      href: "review-gates",
      value: counts ? formatCount(counts.reviewGates) : "—",
    },
    {
      label: "Cost",
      icon: DollarSign,
      href: "costs",
      value: telemetry ? formatCost(telemetry.totalCostUsd) : "—",
    },
    {
      label: "Repos & Health",
      icon: Database,
      href: "repos",
      value: counts ? formatCount(counts.repositories) : "—",
    },
    {
      label: "Memory",
      icon: Brain,
      href: "memory",
      value: counts ? formatCount(counts.memoryItems) : "—",
    },
    {
      label: "API Keys",
      icon: Key,
      href: "api-keys",
      value: counts ? formatCount(counts.apiKeys) : "—",
    },
    {
      label: "Team",
      icon: Users,
      href: "members",
      value: counts
        ? `${formatCount(counts.members)}${counts.teams > 0 ? ` · ${counts.teams}t` : ""}`
        : "—",
    },
  ];

  return (
    <>
      {/* Stat row: ErrorState when ClickHouse is unavailable */}
      {chOk ? (
        <StatHeader stats={statItems} />
      ) : (
        <div className="mb-4">
          <ErrorState
            title="ClickHouse unavailable"
            message="Usage metrics are temporarily unavailable."
          />
        </div>
      )}

      {/* Empty workspace callout */}
      {allZero && <EmptyCallout />}

      {/* Nav grid: ErrorState when Postgres is unavailable */}
      {pgOk ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sections.map(({ label, icon: Icon, href, value }) => (
            <Link
              key={label}
              href={`/dashboard/${workspaceId}/${href}`}
              className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-3 transition-colors hover:border-[var(--gray-08)] hover:bg-[var(--gray-03)]"
            >
              <div className="flex items-center gap-2">
                <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--gray-09)]" />
                <span className="flex-1 text-xs text-[var(--gray-10)]">
                  {label}
                </span>
                <span className="font-mono text-sm text-[var(--gray-11)]">
                  {value}
                </span>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <ErrorState
          title="Postgres unavailable"
          message="Workspace navigation data is temporarily unavailable."
        />
      )}
    </>
  );
}

export default async function WorkspaceDashboardPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const session = await getSession();
  if (!session?.user?.id) return notFound();

  const [workspace, membership] = await Promise.all([
    getWorkspace(workspaceId),
    getMembership(session.user.id, workspaceId),
  ]);

  if (!workspace || !membership) return notFound();

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader
        title={workspace.name}
        subtitle={`${workspace.slug} · ${workspace.id}`}
        actions={
          <span className="rounded-sm bg-[var(--gray-03)] px-1.5 py-0.5 text-xs font-medium text-[var(--gray-09)]">
            {membership.role}
          </span>
        }
      />
      <Suspense
        fallback={
          <>
            <SkeletonStatHeader />
            <SkeletonCardGrid cards={9} />
          </>
        }
      >
        <DashboardContent workspaceId={workspaceId} />
      </Suspense>
    </div>
  );
}
