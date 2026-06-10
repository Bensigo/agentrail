import { listRuns } from "@agentrail/db-postgres";
import { FailuresTable } from "./components/failures-table";

export default async function FailuresPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ run_id?: string }>;
}) {
  const { workspaceId } = await params;
  const { run_id: runId } = await searchParams;

  let repositories: string[] = [];
  try {
    const runs = await listRuns(workspaceId);
    repositories = [
      ...new Set(
        runs.map((r) => r.repositoryId).filter((r): r is string => r !== null)
      ),
    ].sort();
  } catch {
    // DB unavailable; empty repo list is acceptable
  }

  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">
        Failures
      </h1>
      <FailuresTable
        workspaceId={workspaceId}
        repositories={repositories}
        initialRunId={runId}
      />
    </div>
  );
}
