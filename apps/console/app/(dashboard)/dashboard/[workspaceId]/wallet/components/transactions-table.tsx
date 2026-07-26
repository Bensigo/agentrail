import type { WalletTransaction } from "@agentrail/db-postgres";
import { EmptyState } from "../../../../components/empty-state";
import { formatUsdCents, walletTransactionLabel } from "../wallet-helpers";

/**
 * The wallet ledger, newest-first (#1415 AC1: "console surfaces ... plain
 * dollars"). Amount is signed and color-coded (green top-up, muted charge) —
 * never a bare cents integer, never "credits" (house vocabulary rule).
 */
export function TransactionsTable({ rows }: { rows: WalletTransaction[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
        <EmptyState message="No wallet activity yet — top up to get started." />
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-[var(--gray-05)]">
            <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Type
            </th>
            <th className="px-3 py-2 text-left font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Description
            </th>
            <th className="px-3 py-2 text-right font-medium uppercase tracking-wide text-[var(--gray-09)]">
              Amount
            </th>
            <th className="px-3 py-2 text-right font-medium uppercase tracking-wide text-[var(--gray-09)]">
              When
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isTopUp = row.kind === "top_up";
            return (
              <tr key={row.id} className="border-b border-[var(--gray-04)] last:border-0">
                <td className="px-3 py-2 text-[var(--gray-12)]">
                  {walletTransactionLabel(row.kind)}
                </td>
                <td className="px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[var(--gray-11)]">
                      {row.taskRef ?? row.description}
                    </span>
                  </div>
                </td>
                <td
                  className={`px-3 py-2 text-right font-mono ${
                    isTopUp ? "text-[var(--green-11)]" : "text-[var(--gray-11)]"
                  }`}
                >
                  {isTopUp ? "+" : ""}
                  {formatUsdCents(row.amountUsdCents)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-[var(--gray-09)]">
                  {new Date(row.createdAt).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
