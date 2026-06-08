import Link from "next/link";
import { notFound } from "next/navigation";
import { getRunById } from "@agentrail/db-postgres";
import { ChevronLeft } from "lucide-react";
import { RunDetailHeader } from "./components/run-detail-header";

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; runId: string }>;
}) {
  const { workspaceId, runId } = await params;

  let run = null;
  try {
    run = await getRunById(workspaceId, runId);
  } catch {
    // DB unavailable
  }

  if (!run) {
    notFound();
  }

  const duration =
    run.startedAt && run.finishedAt
      ? Math.round(
          (run.finishedAt.getTime() - run.startedAt.getTime()) / 1000
        )
      : null;

  return (
    <div className="mx-auto max-w-[900px]">
      <div className="mb-4 flex items-center gap-2">
        <Link
          href={`/dashboard/${workspaceId}/runs`}
          className="flex items-center gap-1 text-xs text-[var(--gray-09)] hover:text-[var(--gray-12)] transition-colors"
        >
          <ChevronLeft className="h-3 w-3" />
          Runs
        </Link>
      </div>

      <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">
        Run Detail
      </h1>

      <RunDetailHeader
        run={{
          id: run.id,
          workspaceId: run.workspaceId,
          repositoryId: run.repositoryId,
          agent: run.agent,
          branch: run.branch,
          status: run.status,
          startedAt: run.startedAt?.toISOString() ?? null,
          finishedAt: run.finishedAt?.toISOString() ?? null,
          createdAt: run.createdAt.toISOString(),
          duration,
          total_cost: 0, // placeholder; no cost_events table yet
        }}
      />
    </div>
  );
}
