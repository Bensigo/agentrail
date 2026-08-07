import Link from "next/link";
import { ArrowUpRight, ClipboardCheck } from "lucide-react";

export type AcceptanceRecordHeader = {
  id: string;
  repo: string;
  issueNumber: number | null;
  prNumber: number | null;
  state: string;
  updatedAt: Date;
};

function formatUpdatedAt(value: Date): string {
  return value.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

export function AcceptanceEvidencePanel({
  workspaceId,
  records,
}: {
  workspaceId: string;
  records: AcceptanceRecordHeader[];
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]">
            Acceptance evidence
          </h2>
        </div>
        {records.length > 0 && (
          <Link
            href={`/dashboard/${workspaceId}/changes`}
            className="flex shrink-0 items-center gap-0.5 text-xs text-[var(--blue-11)] hover:underline"
          >
            All records <ArrowUpRight className="h-3 w-3" />
          </Link>
        )}
      </div>

      {records.length === 0 ? (
        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-4 py-5">
          <div className="flex items-start gap-3">
            <ClipboardCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--gray-09)]" />
            <div>
              <p className="text-sm text-[var(--gray-12)]">No acceptance records yet.</p>
              <Link
                href={`/dashboard/${workspaceId}/work`}
                className="mt-3 inline-flex items-center gap-0.5 text-xs text-[var(--blue-11)] hover:underline"
              >
                View work <ArrowUpRight className="h-3 w-3" />
              </Link>
            </div>
          </div>
        </div>
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
                  Change/Acceptance Record · {record.issueNumber == null ? "No issue attached" : `Issue #${record.issueNumber}`} · {record.prNumber == null ? "No PR attached" : `PR #${record.prNumber}`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-xs">
                <span className="rounded-sm bg-[var(--gray-03)] px-1.5 py-0.5 capitalize text-[var(--gray-11)]">
                  {record.state}
                </span>
                <time dateTime={record.updatedAt.toISOString()} className="text-[var(--gray-09)]">
                  Updated {formatUpdatedAt(record.updatedAt)}
                </time>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
