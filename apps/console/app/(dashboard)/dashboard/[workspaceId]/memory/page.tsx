import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { notFound } from "next/navigation";
import { MemoryList } from "./memory-list";

export default async function MemoryPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const session = await auth();
  if (!session?.user?.id) return notFound();

  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) return notFound();

  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="text-xl font-bold tracking-tight text-[var(--gray-12)]">
        Memory
      </h1>
      <p className="mt-1 text-xs text-[var(--gray-09)]">
        Memory is managed via the AgentRail CLI. This view is read-only.
      </p>
      <MemoryList workspaceId={workspaceId} />
    </div>
  );
}
