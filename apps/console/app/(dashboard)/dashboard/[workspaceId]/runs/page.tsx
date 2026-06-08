import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listRuns } from "@agentrail/db-postgres";
import { notFound } from "next/navigation";
import { RunsTable } from "./runs-table";

export default async function RunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { workspaceId } = await params;
  const search = await searchParams;
  const session = await auth();
  if (!session?.user?.id) return notFound();

  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) return notFound();

  const statusFilter = search.status as
    | "queued"
    | "running"
    | "success"
    | "failed"
    | undefined;

  const runs = await listRuns(workspaceId, {
    status: statusFilter,
    agent: search.agent,
    limit: 50,
  });

  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="text-xl font-bold tracking-tight text-[var(--gray-12)]">
        Runs
      </h1>
      <p className="mt-1 text-xs text-[var(--gray-09)]">
        Agent execution runs for this workspace.
      </p>
      <RunsTable
        runs={runs}
        workspaceId={workspaceId}
        currentStatus={statusFilter}
      />
    </div>
  );
}
