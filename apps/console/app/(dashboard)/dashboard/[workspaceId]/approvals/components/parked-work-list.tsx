"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { QueueEntryListItem } from "@agentrail/db-postgres";
import { PauseCircle } from "lucide-react";
import { EmptyState } from "../../../../components/empty-state";
import { formatParkReason } from "../../../../../../lib/work-vocabulary";
import { formatRelativeTime } from "../approvals-helpers";

/** A parked queue entry plus the SERVER-computed alignment-lock flag (#1276 fix round, review C1): `page.tsx` derives it with `isAlignmentLocked` — the same kind/estimatedBudgetUsd/require_alignment predicate `requeueParkedQueueEntry` enforces — because this client component can neither read the workspace's gate flag nor import the db-postgres constants (see `approvals-helpers.ts`'s header comment). */
export type ParkedWorkRow = QueueEntryListItem & { alignmentLocked: boolean };

/**
 * Parked work — queue entries currently `state='parked'` (issue #1276),
 * whatever the reason (guardrail, an unmet dependency, or an alignment hold —
 * `formatParkReason` renders whichever the row actually carries, verbatim;
 * see `github_intake.ts`'s park-reason vocabulary).
 *
 * Requeue (PR ②) POSTs to
 * `/api/v1/workspaces/:workspaceId/queue/:queueEntryId/requeue`, which wraps
 * `requeueParkedQueueEntry` — rendered DISABLED for an alignment-held row
 * (`row.alignmentLocked`, server-computed): that hold resolves exclusively
 * through the posted brief's own Approve/Deny in the Pending approvals list
 * above. This is belt-and-suspenders UI — the route's own guarded query
 * enforces the same exclusion server-side regardless of what this component
 * renders.
 *
 * These rows have no expiry (annex §1a-ii: nothing ever times a park out), so
 * age is rendered honestly rather than pretending there's a TTL.
 */
export function ParkedWorkList({
  rows,
  workspaceId,
  canManage,
}: {
  rows: ParkedWorkRow[];
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
                {/* font-mono: relative-time value. */}
                <td className="px-3 py-2 text-right font-mono text-[var(--gray-09)]" title={age.title}>
                  {age.label}
                </td>
                {canManage && (
                  <td className="px-3 py-2 text-right">
                    {row.alignmentLocked ? (
                      // Disabled with the reason, not hidden — an honest UI
                      // for a server-enforced refusal (review C1's locked
                      // design). No onClick: this can never fire the 409 the
                      // route would return anyway.
                      <button
                        type="button"
                        disabled
                        title="Held by the alignment gate — resolve it via Approve/Deny on its brief, not Requeue."
                        className="h-7 px-2.5 rounded bg-[var(--gray-03)] border border-[var(--gray-06)] text-xs text-[var(--gray-08)] opacity-50 cursor-not-allowed"
                      >
                        Requeue
                      </button>
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
