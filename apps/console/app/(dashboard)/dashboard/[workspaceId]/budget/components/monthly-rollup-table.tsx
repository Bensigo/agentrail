import type { WorkspaceMonthlyCostRow } from "@agentrail/db-postgres";
import { formatCostUsd, formatMonthLabel } from "../budget-helpers";

/**
 * Trailing monthly rollup (default 6 months, oldest first). Always has at
 * least one row — `workspaceMonthlyCostRollup` zero-fills months with no
 * runs — so this never needs an empty state; a plain list/table, no chart
 * library. The last row is always the current, still-accruing month (the
 * query's own contract), so partial-month labeling is index-based, not
 * derived from a fresh "now".
 */
export function MonthlyRollupTable({ rows }: { rows: WorkspaceMonthlyCostRow[] }) {
  return (
    <div className="overflow-hidden rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-[var(--gray-05)]">
            <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Month
            </th>
            <th className="px-3 py-2 text-right font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Total
            </th>
            <th className="px-3 py-2 text-right font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Runs
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.monthKey} className="border-b border-[var(--gray-04)] last:border-0">
              <td className="px-3 py-2 text-[var(--gray-12)]">
                {formatMonthLabel(row.monthKey, i === rows.length - 1)}
              </td>
              <td className="px-3 py-2 text-right font-mono text-[var(--gray-11)]">
                {formatCostUsd(row.totalCostUsd)}
              </td>
              <td className="px-3 py-2 text-right font-mono text-[var(--gray-11)]">{row.runCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
