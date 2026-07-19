"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { QueueEntryListItem } from "@agentrail/db-postgres";
import { PauseCircle } from "lucide-react";
import { EmptyState } from "../../../../components/empty-state";
import { formatParkReason } from "../../../../../../lib/work-vocabulary";
import { formatRelativeTime, isAlignmentParkReason } from "../approvals-helpers";

/**
 * Parked work — queue entries currently `state='parked'` (issue #1276),
 * whatever the reason (guardrail, an unmet dependency, or an alignment hold —
 * `formatParkReason` renders whichever the row actually carries, verbatim;
 * see `github_intake.ts`'s park-reason vocabulary).
 *
 * Requeue (PR ②) POSTs to
 * `/api/v1/workspaces/:workspaceId/queue/:queueEntryId/requeue`, which wraps
 * `requeueParkedQueueEntry` — NEVER offered for an alignment hold
 * (`isAlignmentParkReason`): that resolves exclusively through the posted
 * brief's own Approve/Deny in the Pending approvals list above. This is
 * belt-and-suspenders UI — the route's own query enforces the same
 * exclusion server-side regardless of what this component renders.
 *
 * These rows have no expiry (annex §1a-ii: nothing ever times a park out), so
 * age is rendered honestly rather than pretending there's a TTL.
 */
export function ParkedWorkList({
  rows,
  workspaceId,
  canManage,
  alignmentParkReasons,
}: {
  rows: QueueEntryListItem[];
  workspaceId: string;
  canManage: boolean;
  /** The two real ALIGNMENT_PARK_REASON/ALIGNMENT_DENIED_PARK_REASON strings, passed down from the server page — see `approvals-helpers.ts`'s header comment for why this client component can't import them itself. */
  alignmentParkReasons: readonly string[];
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
        `/api/v1/workspaces/${workspaceId}/queue/${id}/requeue`,
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
        [id]: err instanceof Error ? err.message : "Failed to requeue this entry",
      }));
    } finally {
      setPendingId(null);
    }
  }

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
            {canManage && (
              <th className="px-3 py-2 text-right font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Actions
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const age = formatRelativeTime(row.updatedAt);
            const reason = formatParkReason(row.parkReason, row.blockedBy) ?? "—";
            const alignmentLocked = isAlignmentParkReason(row.parkReason, alignmentParkReasons);
            const busy = pendingId === row.id;
            const rowError = errorById[row.id];
            return (
              <tr key={row.id} className="border-b border-[var(--gray-04)] last:border-0 align-top">
                <td className="px-3 py-2">
                  <span className="truncate text-[var(--gray-12)]">{row.title}</span>
                </td>
                <td className="px-3 py-2">
                  <span className="text-[var(--gray-10)]">{reason}</span>
                  {rowError && <p className="mt-1 text-[var(--red-11)]">{rowError}</p>}
                </td>
                <td className="px-3 py-2 text-right text-[var(--gray-09)]" title={age.title}>
                  {age.label}
                </td>
                {canManage && (
                  <td className="px-3 py-2 text-right">
                    {alignmentLocked ? (
                      <span
                        className="text-[10px] text-[var(--gray-08)]"
                        title="Resolved via Approve/Deny on its alignment brief, not a raw requeue."
                      >
                        Awaiting brief
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => requeue(row.id)}
                        disabled={busy}
                        className="h-7 px-2.5 rounded bg-[var(--gray-03)] border border-[var(--gray-06)] text-xs text-[var(--gray-12)] hover:border-[var(--gray-08)] disabled:opacity-50 transition-colors"
                      >
                        {busy ? "Working…" : "Requeue"}
                      </button>
                    )}
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
