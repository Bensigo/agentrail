import { listWorkspaceRepositories } from "@agentrail/db-postgres";
import { RunsTable } from "./components/runs-table";

export default async function RunsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  // Repos for the filter dropdown — shown by name, filtered by id.
  let repositories: { id: string; name: string }[] = [];
  try {
    const repos = await listWorkspaceRepositories(workspaceId);
    repositories = repos.map((r) => ({ id: r.id, name: r.name }));
  } catch {
    // DB unavailable; empty repo list is acceptable
  }

  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="text-sm font-bold text-[var(--gray-12)]">Runs</h1>
      <p className="mb-4 mt-1 text-xs text-[var(--gray-09)]">
        Every work session Jace ran, with full receipts.
      </p>
      <RunsTable workspaceId={workspaceId} repositories={repositories} />
    </div>
  );
}
