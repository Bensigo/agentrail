import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { notFound } from "next/navigation";
import { CostsTable } from "./costs-table";

export default async function CostsPage({
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
        Cost Breakdown
      </h1>
      <CostsTable workspaceId={workspaceId} />
    </div>
  );
}
