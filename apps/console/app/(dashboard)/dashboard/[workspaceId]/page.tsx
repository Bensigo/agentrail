import { auth } from "@agentrail/auth";
import { getWorkspace, getWorkspaceMembership } from "@agentrail/db-postgres";
import { notFound } from "next/navigation";

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
    <div className="mx-auto max-w-[1440px] p-6">
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

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {["Runs", "Context Packs", "Failures", "Review Gates"].map(
          (label) => (
            <div
              key={label}
              className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4"
            >
              <p className="text-xs uppercase tracking-wide text-[var(--gray-09)]">
                {label}
              </p>
              <p className="mt-2 font-mono text-2xl font-bold text-[var(--gray-12)]">
                —
              </p>
            </div>
          )
        )}
      </div>
    </div>
  );
}
