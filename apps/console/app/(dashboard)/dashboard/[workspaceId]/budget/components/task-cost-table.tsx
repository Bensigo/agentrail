import type { WorkspaceRunCostRow } from "@agentrail/db-postgres";
import { EmptyState } from "../../../../components/empty-state";
import { formatCostUsd, formatRelativeTime, runStatusLabel } from "../budget-helpers";

// Mirrors runs/components/status-badge.tsx's color choices exactly (same
// four-value enum) so a run's status reads identically wherever it shows up
// in the console — this page owns its own copy rather than reaching across
// the runs/ feature folder, matching the codebase's established convention
// of page-local formatting/presentation helpers (see budget-helpers.ts).
const STATUS_CLASSES: Record<string, string> = {
  success: "bg-[var(--green-09)]/20 text-[var(--green-11)] border border-[var(--green-09)]/30",
  failed: "bg-[var(--red-09)]/20 text-[var(--red-11)] border border-[var(--red-09)]/30",
  running: "bg-[var(--orange-09)]/20 text-[var(--orange-11)] border border-[var(--orange-09)]/30",
  queued: "bg-[var(--gray-04)] text-[var(--gray-10)] border border-[var(--gray-06)]",
};
const STATUS_FALLBACK_CLASSNAME =
  "bg-[var(--gray-04)] text-[var(--gray-10)] border border-[var(--gray-06)]";

function StatusBadge({ status }: { status: string }) {
  const className = STATUS_CLASSES[status] ?? STATUS_FALLBACK_CLASSNAME;
  return (
    <span
      className={`inline-flex w-[5.5rem] shrink-0 items-center justify-center rounded-sm px-1.5 py-0.5 text-xs font-medium ${className}`}
    >
      {runStatusLabel(status)}
    </span>
  );
}

/**
 * This month's per-task cost rows (AC1). Task identity is the server-resolved
 * `taskIdentity` (title, never a raw UUID — see `listWorkspaceRunCosts`'s
 * three-tier COALESCE); the run id only ever appears as small muted meta,
 * matching `review-gates/page.tsx`'s `run:{id.slice(0,8)}` convention.
 */
export function TaskCostTable({ rows }: { rows: WorkspaceRunCostRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
        <EmptyState message="No runs recorded yet this month — costs will appear here once work completes." />
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-[var(--gray-05)]">
            <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Task
            </th>
            <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Status
            </th>
            <th className="px-3 py-2 text-right font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Cost
            </th>
            <th className="px-3 py-2 text-right font-medium uppercase tracking-wide text-[var(--gray-09)]">
              When
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const when = formatRelativeTime(row.createdAt);
            return (
              <tr key={row.runId} className="border-b border-[var(--gray-04)] last:border-0">
                <td className="px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[var(--gray-12)]">{row.taskIdentity}</span>
                    <span className="shrink-0 font-mono text-xs text-[var(--gray-09)]">
                      run:{row.runId.slice(0, 8)}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <StatusBadge status={row.status} />
                </td>
                <td className="px-3 py-2 text-right font-mono text-[var(--gray-11)]">
                  {formatCostUsd(row.costUsd)}
                </td>
                {/* relative time is a formatted timestamp → mono, per IA principle 7 */}
                <td className="px-3 py-2 text-right font-mono text-[var(--gray-09)]" title={when.title}>
                  {when.label}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
