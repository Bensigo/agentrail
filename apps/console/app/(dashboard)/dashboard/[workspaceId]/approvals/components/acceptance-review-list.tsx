import Link from "next/link";
import { ClipboardCheck } from "lucide-react";
import type { AcceptanceRecordSummary } from "@agentrail/db-postgres";
import { EmptyState } from "../../../../components/empty-state";

export function reviewRequestLabel(record: AcceptanceRecordSummary): string {
  return record.requestedWork.kind === "confirmed"
    ? record.requestedWork.originalRequest
    : "Acceptance Record awaiting review";
}

function pullRequestLabel(record: AcceptanceRecordSummary): string {
  if (record.pullRequest.kind !== "attached") return "PR not attached";
  return `PR #${record.pullRequest.prNumber}`;
}

function exactHeadLabel(record: AcceptanceRecordSummary): string {
  if (record.pullRequest.kind !== "attached" || record.pullRequest.head.kind === "unknown") {
    return "Exact head unknown";
  }
  return `Head ${record.pullRequest.head.sha.slice(0, 12)}`;
}

function proofLabel(record: AcceptanceRecordSummary): string {
  if (record.proof.kind !== "recorded") return "Proof not recorded";
  return `Review ${record.proof.verdict.replaceAll("_", " ")}`;
}

function contextLabel(record: AcceptanceRecordSummary): string {
  switch (record.suppliedContext.kind) {
    case "compiled": return "Context Pack compiled";
    case "admitted": return "Context admitted; Pack not compiled";
    case "not_proven": return "Context custody not proven";
    case "unknown": return "Context not recorded";
  }
}

export function AcceptanceReviewList({
  records,
  workspaceId,
  scanTruncated = false,
}: {
  records: AcceptanceRecordSummary[];
  workspaceId: string;
  scanTruncated?: boolean;
}) {
  if (records.length === 0) {
    return (
      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
        <EmptyState
          message={scanTruncated
            ? "This view scans up to the latest 200 Acceptance Records. Older reviews may not appear."
            : "No reviews waiting."}
          icon={<ClipboardCheck size={20} />}
          action={scanTruncated ? (
            <Link
              href={`/dashboard/${workspaceId}/changes`}
              className="text-xs text-[var(--blue-11)] hover:underline"
            >
              View Acceptance Records
            </Link>
          ) : undefined}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {scanTruncated ? (
        <p className="text-xs text-[var(--gray-09)]">
          This view scans up to the latest 200 Acceptance Records. Older reviews may not appear.
        </p>
      ) : null}
      <ol className="flex flex-col gap-3">
      {records.map((record) => {
        const pr = pullRequestLabel(record);
        return (
          <li key={record.recordId}>
            <article className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="text-sm font-medium text-[var(--gray-12)]">
                    {reviewRequestLabel(record)}
                  </h3>
                  <p className="mt-1 font-mono text-xs text-[var(--gray-09)]">
                    {record.repo} · {pr} · {exactHeadLabel(record)}
                  </p>
                </div>
                <Link
                  href={`/dashboard/${workspaceId}/changes/${record.recordId}`}
                  aria-label={`Review ${record.repo} ${pr}`}
                  className="shrink-0 rounded bg-[var(--accent-fill)] px-3 py-2 text-xs font-medium text-[var(--accent-fill-text)] hover:bg-[var(--accent-fill-hover)]"
                >
                  Review
                </Link>
              </div>
              <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
                <div>
                  <dt className="text-[var(--gray-09)]">Context</dt>
                  <dd className="mt-1 text-[var(--gray-12)]">{contextLabel(record)}</dd>
                </div>
                <div>
                  <dt className="text-[var(--gray-09)]">Evidence</dt>
                  <dd className="mt-1 text-[var(--gray-12)]">{proofLabel(record)}</dd>
                </div>
              </dl>
            </article>
          </li>
        );
      })}
      </ol>
    </div>
  );
}
