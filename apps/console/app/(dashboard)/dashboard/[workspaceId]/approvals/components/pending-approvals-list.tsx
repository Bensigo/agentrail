import type { PendingApprovalRow } from "@agentrail/db-postgres";
import { Inbox } from "lucide-react";
import { EmptyState } from "../../../../components/empty-state";
import {
  channelLabel,
  formatRelativeTime,
  summarizeApprovalToolInput,
  toolLabel,
} from "../approvals-helpers";

/**
 * Pending approvals — one row per `jace_approvals` row with `status='pending'`
 * (issue #1276 PR ①). Read-only: no Approve/Deny controls yet, those land in
 * PR ② through the same seam the Telegram button already resolves through
 * (`resolveApproval` + `applyAlignmentDecision`).
 *
 * `approval.id`/`conversationKey` are never rendered as visible text (names
 * over IDs) — the summary headline (title/name, per tool) and the channel's
 * plain-English label are the only identifying text shown.
 */
export function PendingApprovalsList({ rows }: { rows: PendingApprovalRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
        <EmptyState
          message="Nothing waiting on your approval right now."
          icon={<Inbox size={20} />}
        />
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-[var(--gray-05)]">
            <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Approval
            </th>
            <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Source
            </th>
            <th className="px-3 py-2 text-right font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Waiting
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const summary = summarizeApprovalToolInput(row.toolName, row.toolInput);
            const age = formatRelativeTime(row.createdAt);
            return (
              <tr key={row.id} className="border-b border-[var(--gray-04)] last:border-0 align-top">
                <td className="px-3 py-2">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex shrink-0 items-center rounded-sm border border-[var(--gray-06)] bg-[var(--gray-03)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--gray-10)]">
                        {toolLabel(row.toolName)}
                      </span>
                      <span className="truncate text-[var(--gray-12)]">{summary.headline}</span>
                    </div>
                    {summary.fields.length > 0 && (
                      <dl className="flex flex-col gap-0.5">
                        {summary.fields.map((field, i) => (
                          <div key={`${field.label}-${i}`} className="flex gap-1 text-[var(--gray-09)]">
                            {field.label && <dt className="shrink-0">{field.label}:</dt>}
                            <dd className="truncate">{field.value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 text-[var(--gray-10)]">{channelLabel(row.channel)}</td>
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
