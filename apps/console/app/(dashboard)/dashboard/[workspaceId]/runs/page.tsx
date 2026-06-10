import { listRuns } from "@agentrail/db-postgres";
import { RunsTable } from "./components/runs-table";

export default async function RunsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  // Fetch distinct repos for the filter dropdown (graceful fallback)
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
        Runs
      </h1>
      <RunsTable workspaceId={workspaceId} repositories={repositories} />
    </div>
  );
}
