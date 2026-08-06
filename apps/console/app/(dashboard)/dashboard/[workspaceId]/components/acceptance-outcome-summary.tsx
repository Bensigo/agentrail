import type { AcceptanceWorkspaceOutcomeSummary } from "@agentrail/db-postgres";

const UTC_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatUtcDateTime(value: Date): string {
  return `${UTC_MONTHS[value.getUTCMonth()]} ${pad2(value.getUTCDate())}, ${value.getUTCFullYear()} ${pad2(value.getUTCHours())}:${pad2(value.getUTCMinutes())} UTC`;
}

export function workspaceOutcomeSummaryWindow(now = new Date()): {
  from: Date;
  to: Date;
} {
  const to = new Date(now);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 30);
  return { from, to };
}

export function formatWorkspaceOutcomeSummaryWindow(
  from: Date,
  to: Date
): string {
  return `${formatUtcDateTime(from)} – ${formatUtcDateTime(to)}`;
}

function OutcomeStat({
  label,
  value,
  detail,
}: {
  label: string;
  value: number;
  detail?: string;
}) {
  return (
    <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)] px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-[var(--gray-09)]">
        {label}: <span className="font-semibold text-[var(--gray-12)]">{value}</span>
      </p>
      {detail && <p className="mt-1 text-xs text-[var(--gray-09)]">{detail}</p>}
    </div>
  );
}

function OutcomeGroup({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ label: string; value: number }>;
}) {
  return (
    <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)] px-3 py-3">
      <p className="text-[11px] uppercase tracking-wide text-[var(--gray-09)]">{title}</p>
      <dl className="mt-2 flex flex-col gap-1 text-xs text-[var(--gray-11)]">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3">
            <dt className="min-w-0">{row.label}:</dt>
            <dd className="shrink-0 font-medium text-[var(--gray-12)]">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function AcceptanceOutcomeSummaryPanel({
  summary,
}: {
  summary: AcceptanceWorkspaceOutcomeSummary;
}) {
  const otherJaceStatuses = Object.entries(summary.jaceVerdicts.otherStatuses)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b));

  return (
    <section className="flex flex-col gap-3">
      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
        <div className="border-b border-[var(--gray-05)] px-4 py-3">
          <h2 className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]">
            Outcome summary
          </h2>
          <p className="mt-1 text-xs text-[var(--gray-09)]">Last 30 days</p>
          <p className="mt-1 text-xs text-[var(--gray-09)]">
            UTC window (half-open):{" "}
            {formatWorkspaceOutcomeSummaryWindow(
              summary.windowFromUtcInclusive,
              summary.windowToUtcExclusive
            )}
          </p>
        </div>

        <div className="flex flex-col gap-3 px-4 py-4">
          {summary.reviewedPrRevisionCount === 0 && (
            <p className="text-xs text-[var(--gray-09)]">
              No completed evidence reviews landed in this window yet.
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <OutcomeStat
              label="Reviewed PR revisions"
              value={summary.reviewedPrRevisionCount}
            />
            <OutcomeStat
              label="Pending reviews"
              value={summary.pendingReviews.total}
              detail={`queued ${summary.pendingReviews.queued} · claimed ${summary.pendingReviews.claimed}`}
            />
            <OutcomeStat
              label="Awaiting human decision"
              value={summary.pendingHumanDecisions}
            />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <OutcomeGroup
              title="Jace verdicts"
              rows={[
                { label: "proven", value: summary.jaceVerdicts.proven },
                { label: "not proven", value: summary.jaceVerdicts.notProven },
                ...otherJaceStatuses.map(([status, count]) => ({
                  label: status,
                  value: count,
                })),
              ]}
            />
            <OutcomeGroup
              title="Human decisions"
              rows={[
                { label: "approved", value: summary.humanDecisions.approved },
                { label: "changes requested", value: summary.humanDecisions.changesRequested },
                { label: "rejected", value: summary.humanDecisions.rejected },
                {
                  label: "approved with exception",
                  value: summary.humanDecisions.approvedWithException,
                },
              ]}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
