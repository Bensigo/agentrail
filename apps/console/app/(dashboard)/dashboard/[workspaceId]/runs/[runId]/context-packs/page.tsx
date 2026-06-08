import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { notFound } from "next/navigation";
import { ContextPacksView } from "./context-packs-view";

export default async function ContextPacksPage({
  params,
}: {
  params: Promise<{ workspaceId: string; runId: string }>;
}) {
  const { workspaceId, runId } = await params;
  const session = await auth();
  if (!session?.user?.id) return notFound();

  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) return notFound();

  return (
    <div className="mx-auto max-w-[1440px]">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-bold tracking-tight text-[var(--gray-12)]">
          Context Packs
        </h1>
        <span className="font-mono text-sm text-[var(--gray-09)]">
          Run {runId.slice(0, 8)}
        </span>
      </div>
      <ContextPacksView workspaceId={workspaceId} runId={runId} />
    </div>
  );
}
