"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { DeadLetterChannelMessageRow } from "@agentrail/db-postgres";
import { MailWarning } from "lucide-react";
import { EmptyState } from "../../../../components/empty-state";
import { channelLabel, formatRelativeTime, truncate } from "../approvals-helpers";

const LAST_ERROR_MAX_LEN = 160;

/**
 * Dead letters — `channel_inbox` rows that exhausted their retry budget
 * (`state='dead'`, issue #1276; see `channel_inbox.ts::deadLettersForWorkspace`).
 *
 * Requeue (PR ②) POSTs to
 * `/api/v1/workspaces/:workspaceId/channel-inbox/:id/requeue`, wired to the
 * existing `requeueDeadChannelMessage` query (no new query work — it's
 * already workspace- and state-scoped).
 */
export function DeadLettersList({
  rows,
  workspaceId,
  canManage,
}: {
  rows: DeadLetterChannelMessageRow[];
  workspaceId: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});

  async function requeue(id: string) {
    setPendingId(id);
    setErrorById((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      const res = await fetch(
        `/api/v1/workspaces/${workspaceId}/channel-inbox/${id}/requeue`,
        { method: "POST" }
      );
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setErrorById((prev) => ({
        ...prev,
        [id]: err instanceof Error ? err.message : "Failed to requeue this message",
      }));
    } finally {
      setPendingId(null);
    }
  }

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
            {canManage && (
              <th className="px-3 py-2 text-right font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Actions
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const age = formatRelativeTime(row.createdAt);
            const busy = pendingId === row.id;
            const rowError = errorById[row.id];
            return (
              <tr key={row.id} className="border-b border-[var(--gray-04)] last:border-0 align-top">
                <td className="px-3 py-2 text-[var(--gray-10)]">{channelLabel(row.channel)}</td>
                <td className="px-3 py-2 text-[var(--gray-10)]">{row.kind}</td>
                <td className="px-3 py-2 text-[var(--gray-10)]">
                  {row.lastError ? truncate(row.lastError, LAST_ERROR_MAX_LEN) : "—"}
                  {rowError && <p className="mt-1 text-[var(--red-11)]">{rowError}</p>}
                </td>
                <td className="px-3 py-2 text-right font-mono text-[var(--gray-11)]">
                  {row.attempts}
                </td>
                <td className="px-3 py-2 text-right text-[var(--gray-09)]" title={age.title}>
                  {age.label}
                </td>
                {canManage && (
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => requeue(row.id)}
                      disabled={busy}
                      className="h-7 px-2.5 rounded bg-[var(--gray-03)] border border-[var(--gray-06)] text-xs text-[var(--gray-12)] hover:border-[var(--gray-08)] disabled:opacity-50 transition-colors"
                    >
                      {busy ? "Working…" : "Requeue"}
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
