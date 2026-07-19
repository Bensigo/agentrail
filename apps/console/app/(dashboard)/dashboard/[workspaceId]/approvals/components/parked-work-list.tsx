import type { QueueEntryListItem } from "@agentrail/db-postgres";
import { PauseCircle } from "lucide-react";
import { EmptyState } from "../../../../components/empty-state";
import { formatParkReason } from "../../../../../../lib/work-vocabulary";
import { formatRelativeTime } from "../approvals-helpers";

/**
 * Parked work — queue entries currently `state='parked'` (issue #1276 PR ①),
 * whatever the reason (guardrail, an unmet dependency, or an alignment hold —
 * `formatParkReason` renders whichever the row actually carries, verbatim;
 * see `github_intake.ts`'s park-reason vocabulary). Read-only in PR ①; PR ②
 * adds a Requeue action that is deliberately withheld for an alignment park
 * (that hold resolves exclusively through the approval above, never a raw
 * requeue — see the recon annex).
 *
 * These rows have no expiry (annex §1a-ii: nothing ever times a park out), so
 * age is rendered honestly rather than pretending there's a TTL.
 */
export function ParkedWorkList({ rows }: { rows: QueueEntryListItem[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
        <EmptyState message="No parked work right now." icon={<PauseCircle size={20} />} />
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-[var(--gray-05)]">
            <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Work
            </th>
            <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Reason
            </th>
            <th className="px-3 py-2 text-right font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Parked
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const age = formatRelativeTime(row.updatedAt);
            const reason = formatParkReason(row.parkReason, row.blockedBy) ?? "—";
            return (
              <tr key={row.id} className="border-b border-[var(--gray-04)] last:border-0">
                <td className="px-3 py-2">
                  <span className="truncate text-[var(--gray-12)]">{row.title}</span>
                </td>
                <td className="px-3 py-2 text-[var(--gray-10)]">{reason}</td>
                <td className="px-3 py-2 text-right text-[var(--gray-09)]" title={age.title}>
                  {age.label}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
