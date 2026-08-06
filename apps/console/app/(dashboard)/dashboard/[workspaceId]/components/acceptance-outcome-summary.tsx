import type {
  AcceptanceWorkspaceOutcomeRange,
  AcceptanceWorkspaceOutcomeSummary,
} from "@agentrail/db-postgres";
import Link from "next/link";

const OUTCOME_RANGES: Array<{ label: string; value: AcceptanceWorkspaceOutcomeRange }> = [
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
  { label: "1y", value: "1y" },
];

const OUTCOME_RANGE_COPY: Record<AcceptanceWorkspaceOutcomeRange, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "1y": "Last year",
};

function OutcomeCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: number;
  detail?: string;
}) {
  return (
    <div className="flex min-h-24 flex-col justify-between rounded border border-[var(--gray-05)] bg-[var(--gray-01)] px-3 py-3">
      <p className="text-xs uppercase tracking-wide text-[var(--gray-09)]">{label}</p>
      <p className="mt-3 text-2xl tracking-tight text-[var(--gray-12)]">{value}</p>
      {detail && <p className="mt-2 text-xs text-[var(--gray-09)]">{detail}</p>}
    </div>
  );
}

function OutcomeRangeSelector({
  workspaceId,
  activeRange,
}: {
  workspaceId: string;
  activeRange: AcceptanceWorkspaceOutcomeRange;
}) {
  return (
    <nav aria-label="Outcome time range" className="flex items-center gap-1 rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-1">
      {OUTCOME_RANGES.map(({ label, value }) => {
        const active = value === activeRange;
        return (
          <Link
            key={value}
            href={`/dashboard/${workspaceId}?range=${value}`}
            aria-current={active ? "page" : undefined}
            className={`rounded px-2 py-1 text-xs transition-colors ${
              active
                ? "bg-[var(--gray-12)] text-[var(--gray-01)]"
                : "text-[var(--gray-09)] hover:bg-[var(--gray-03)] hover:text-[var(--gray-12)]"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function AcceptanceOutcomeSummaryPanel({
  summary,
  activeRange,
}: {
  summary: AcceptanceWorkspaceOutcomeSummary;
  activeRange: AcceptanceWorkspaceOutcomeRange;
}) {
  const otherJaceStatuses = Object.entries(summary.jaceVerdicts.otherStatuses)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b));

  return (
    <section className="border-y border-[var(--gray-05)] py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]">
            Trust outcomes
          </h2>
          <p className="mt-1 text-xs text-[var(--gray-09)]">{OUTCOME_RANGE_COPY[activeRange]}</p>
        </div>
        <OutcomeRangeSelector workspaceId={summary.workspaceId} activeRange={activeRange} />
      </div>

      {summary.reviewedPrRevisionCount === 0 && (
        <p className="mt-4 text-sm text-[var(--gray-09)]">
          No completed evidence reviews in this range. Pending work remains visible below.
        </p>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <OutcomeCard label="Reviewed PR revisions" value={summary.reviewedPrRevisionCount} />
        <OutcomeCard label="Jace proven" value={summary.jaceVerdicts.proven} />
        <OutcomeCard label="Jace not proven" value={summary.jaceVerdicts.notProven} />
        <OutcomeCard
          label="Pending review"
          value={summary.pendingReviews.total}
          detail={`queued ${summary.pendingReviews.queued} · claimed ${summary.pendingReviews.claimed}`}
        />
        <OutcomeCard label="Awaiting human decision" value={summary.pendingHumanDecisions} />
        <OutcomeCard label="Approved" value={summary.humanDecisions.approved} />
        <OutcomeCard label="Changes requested" value={summary.humanDecisions.changesRequested} />
        <OutcomeCard label="Rejected" value={summary.humanDecisions.rejected} />
        <OutcomeCard
          label="Approved with exception"
          value={summary.humanDecisions.approvedWithException}
        />
        {otherJaceStatuses.map(([status, value]) => (
          <OutcomeCard key={status} label={`Jace ${status}`} value={value} />
        ))}
      </div>
    </section>
  );
}
