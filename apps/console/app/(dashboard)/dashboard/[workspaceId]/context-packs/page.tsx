import Link from "next/link";
import { notFound } from "next/navigation";
import { Layers3 } from "lucide-react";
import { listAcceptanceContextPacksForWorkspace } from "@agentrail/db-postgres";
import { getMembership, getSession } from "../../../../../lib/cached";
import { EmptyState } from "../../../../components/empty-state";
import { PageHeader } from "../../../../components/page-header";

export default async function ContextPacksPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const session = await getSession();
  if (!session?.user?.id) return notFound();
  const membership = await getMembership(session.user.id, workspaceId);
  if (!membership) return notFound();

  const packs = await listAcceptanceContextPacksForWorkspace({ workspaceId });

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader title="Context Packs" />
      {packs.length === 0 ? (
        <EmptyState
          icon={Layers3}
          title="No Context Packs"
        />
      ) : (
        <div className="flex flex-col gap-2">
          {packs.map((pack) => (
            <Link
              key={pack.id}
              href={`/dashboard/${workspaceId}/changes/${pack.recordId}#context-pack-${pack.id}`}
              className="flex items-center justify-between gap-4 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-4 py-3 transition-colors hover:border-[var(--gray-08)]"
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-sm font-medium text-[var(--gray-12)]">{pack.repo}</p>
                <p className="mt-1 text-xs text-[var(--gray-09)]">
                  {pack.compilerVersion} / policy {pack.policyVersion} / PR #{pack.prNumber}
                </p>
              </div>
              <time dateTime={pack.createdAt.toISOString()} className="shrink-0 text-xs text-[var(--gray-09)]">
                {pack.createdAt.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" })}
              </time>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
