import { listWorkspaceRepositories } from "@agentrail/db-postgres";
import { FailureClusters } from "./components/failure-clusters";
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

  // Repos carry id + human name so the table and filter can show "owner/repo"
  // instead of the raw uuid the failure events are keyed by.
  let repositories: { id: string; name: string }[] = [];
  try {
    const repos = await listWorkspaceRepositories(workspaceId);
    repositories = repos
      .map((r) => ({ id: r.id, name: r.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    // DB unavailable; empty repo list is acceptable
  }

  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="text-sm font-semibold text-[var(--gray-12)]">
        Failures
      </h1>
      <p className="mb-4 mt-1 text-xs text-[var(--gray-09)]">
        Every way Jace&apos;s work has broken, grouped so the pattern is
        obvious.
      </p>
      <FailureClusters workspaceId={workspaceId} />
      <FailuresTable
        workspaceId={workspaceId}
        repositories={repositories}
        initialRunId={runId}
      />
    </div>
  );
}
