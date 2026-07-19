import type { DeadLetterChannelMessageRow } from "@agentrail/db-postgres";
import { MailWarning } from "lucide-react";
import { EmptyState } from "../../../../components/empty-state";
import { channelLabel, formatRelativeTime, truncate } from "../approvals-helpers";

const LAST_ERROR_MAX_LEN = 160;

/**
 * Dead letters — `channel_inbox` rows that exhausted their retry budget
 * (`state='dead'`, issue #1276 PR ①; see `channel_inbox.ts::deadLettersForWorkspace`).
 * Read-only in PR ①; PR ② adds a Requeue action wired to the existing
 * `requeueDeadChannelMessage` query (no new query work — it's already
 * workspace- and state-scoped).
 */
export function DeadLettersList({ rows }: { rows: DeadLetterChannelMessageRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
        <EmptyState message="No dead-lettered messages." icon={<MailWarning size={20} />} />
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-[var(--gray-05)]">
            <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Source
            </th>
            <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Kind
            </th>
            <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Last error
            </th>
            <th className="px-3 py-2 text-right font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Attempts
            </th>
            <th className="px-3 py-2 text-right font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Failed
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const age = formatRelativeTime(row.createdAt);
            return (
              <tr key={row.id} className="border-b border-[var(--gray-04)] last:border-0">
                <td className="px-3 py-2 text-[var(--gray-10)]">{channelLabel(row.channel)}</td>
                <td className="px-3 py-2 text-[var(--gray-10)]">{row.kind}</td>
                <td className="px-3 py-2 text-[var(--gray-10)]">
                  {row.lastError ? truncate(row.lastError, LAST_ERROR_MAX_LEN) : "—"}
                </td>
                <td className="px-3 py-2 text-right font-mono text-[var(--gray-11)]">
                  {row.attempts}
                </td>
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
