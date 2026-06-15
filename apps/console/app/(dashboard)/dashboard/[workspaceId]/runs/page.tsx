import { listWorkspaceRepositories } from "@agentrail/db-postgres";
import { PageHeader } from "../../../../components/page-header";
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
      <PageHeader title="Runs" />
      <RunsTable workspaceId={workspaceId} repositories={repositories} />
    </div>
  );
}
