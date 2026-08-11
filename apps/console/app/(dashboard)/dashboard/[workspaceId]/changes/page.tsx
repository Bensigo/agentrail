import Link from "next/link";
import { notFound } from "next/navigation";
import { History } from "lucide-react";
import { readAcceptanceRecordSummaries } from "@agentrail/db-postgres";
import { getMembership, getSession } from "../../../../../lib/cached";
import { EmptyState } from "../../../../components/empty-state";
import { PageHeader } from "../../../../components/page-header";
import {
  AcceptanceRecordSummaryList,
  parseAcceptanceRecordRepoFilter,
} from "../components/acceptance-record-summary-list";

export default async function ChangesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ repo?: string | string[] }>;
}) {
  const { workspaceId } = await params;
  const { repo: rawRepo } = await searchParams;

  const session = await getSession();
  if (!session?.user?.id) return notFound();
  const membership = await getMembership(session.user.id, workspaceId);
  if (!membership) return notFound();

  const repoFilter = parseAcceptanceRecordRepoFilter(rawRepo);
  const repo = repoFilter.kind === "valid" ? repoFilter.repo : null;
  const summaries = repoFilter.kind === "invalid"
    ? null
    : await readAcceptanceRecordSummaries({ workspaceId, repo });

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

      {repoFilter.kind === "invalid" ? (
        <EmptyState
          icon={History}
          title="Invalid repository filter"
          description="Use the canonical owner/repository form. No Acceptance Records were read."
        />
      ) : summaries?.records.length === 0 ? (
        <EmptyState
          icon={History}
          title={repo ? "No changes for this repository" : "No change records yet"}
          description="Change records appear when a requirement, issue, or pull request enters the lifecycle."
        />
      ) : (
        <AcceptanceRecordSummaryList
          workspaceId={workspaceId}
          records={summaries?.records ?? []}
        />
      )}
    </div>
  );
}
