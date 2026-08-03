import Link from "next/link";
import { notFound } from "next/navigation";
import { History } from "lucide-react";
import { listChangeRecords } from "@agentrail/db-postgres";
import { getMembership, getSession } from "../../../../../lib/cached";
import { EmptyState } from "../../../../components/empty-state";
import { PageHeader } from "../../../../components/page-header";

export default async function ChangesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ repo?: string }>;
}) {
  const { workspaceId } = await params;
  const { repo: rawRepo } = await searchParams;
  const repo = rawRepo?.trim() || null;

  const session = await getSession();
  if (!session?.user?.id) return notFound();
  const membership = await getMembership(session.user.id, workspaceId);
  if (!membership) return notFound();

  const records = await listChangeRecords({ workspaceId, repo });

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader
        title="Changes"
        subtitle="One lifecycle record for each change, from requirement through outcome."
      />
      <form method="get" className="mb-5 flex max-w-xl items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-[var(--gray-09)]">
          Repository
          <input
            name="repo"
            defaultValue={repo ?? ""}
            placeholder="owner/repository"
            className="h-9 rounded border border-[var(--gray-06)] bg-[var(--gray-01)] px-3 font-mono text-xs text-[var(--gray-12)] outline-none focus:border-[var(--blue-09)]"
          />
        </label>
        <button
          type="submit"
          className="h-9 rounded border border-[var(--gray-06)] bg-[var(--gray-03)] px-3 text-xs font-medium text-[var(--gray-12)] hover:border-[var(--gray-08)]"
        >
          Filter
        </button>
        {repo && (
          <Link
            href={`/dashboard/${workspaceId}/changes`}
            className="h-9 rounded px-2 py-2 text-xs text-[var(--gray-09)] hover:text-[var(--gray-12)]"
          >
            Clear
          </Link>
        )}
      </form>

      {records.length === 0 ? (
        <EmptyState
          icon={History}
          title={repo ? "No changes for this repository" : "No change records yet"}
          description="Change records appear when a requirement, issue, or pull request enters the lifecycle."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {records.map((record) => (
            <Link
              key={record.id}
              href={`/dashboard/${workspaceId}/changes/${record.id}`}
              className="flex items-center justify-between gap-4 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-4 py-3 transition-colors hover:border-[var(--gray-08)]"
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-sm font-medium text-[var(--gray-12)]">
                  {record.repo}
                </p>
                <p className="mt-1 text-xs text-[var(--gray-09)]">
                  {record.issueNumber == null ? "No issue" : `Issue #${record.issueNumber}`} · {record.prNumber == null ? "No pull request" : `PR #${record.prNumber}`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-xs">
                <span className="rounded-sm bg-[var(--gray-03)] px-1.5 py-0.5 capitalize text-[var(--gray-11)]">
                  {record.state}
                </span>
                <time dateTime={record.updatedAt.toISOString()} className="text-[var(--gray-09)]">
                  {record.updatedAt.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" })}
                </time>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
