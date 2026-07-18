import { AlertTriangle } from "lucide-react";
import type { WorkspaceCostOverview } from "@agentrail/db-postgres";
import { capStatusCopy, formatCostUsd, spendRatio } from "../budget-helpers";

const STATUS_CARD_CLASSES: Record<"neutral" | "positive" | "critical", string> = {
  neutral: "border-[var(--gray-05)] bg-[var(--gray-02)] text-[var(--gray-11)]",
  positive:
    "border-[var(--green-09)]/30 bg-[color-mix(in_srgb,var(--green-11)_10%,transparent)] text-[var(--green-11)]",
  critical:
    "border-[var(--red-09)]/40 bg-[color-mix(in_srgb,var(--red-11)_12%,transparent)] text-[var(--red-11)]",
};

/**
 * Overview strip: current-month spend, ceiling, and cap status — the AC2
 * "is this workspace blocked right now" answer. The exhausted state gets a
 * dedicated, loud banner above the card row (icon + bold headline) rather
 * than just a colored badge, per the house rule that a paused-claims state
 * must be unmissable, not just color-coded.
 */
export function OverviewStrip({ overview }: { overview: WorkspaceCostOverview }) {
  const { currentMonthSpendUsd, monthlyBudgetUsd, capStatus } = overview;
  const copy = capStatusCopy(capStatus, currentMonthSpendUsd, monthlyBudgetUsd);
  const ratio = spendRatio(currentMonthSpendUsd, monthlyBudgetUsd);

  return (
    <div className="flex flex-col gap-3">
      {capStatus === "exhausted" && (
        <div className="flex items-start gap-3 rounded border border-[var(--red-09)]/50 bg-[color-mix(in_srgb,var(--red-11)_14%,transparent)] px-4 py-3">
          <AlertTriangle className="h-5 w-5 shrink-0 text-[var(--red-11)]" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-[var(--red-11)]">{copy.headline}</p>
            <p className="mt-0.5 text-xs text-[var(--red-11)]">{copy.detail}</p>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
          <p className="mb-0.5 text-xs text-[var(--gray-09)]">Spent this month</p>
          <p className="font-mono text-2xl font-semibold text-[var(--gray-12)]">
            {formatCostUsd(currentMonthSpendUsd)}
          </p>
        </div>

        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
          <p className="mb-0.5 text-xs text-[var(--gray-09)]">Monthly ceiling</p>
          <p className="font-mono text-2xl font-semibold text-[var(--gray-12)]">
            {monthlyBudgetUsd === null ? "Uncapped" : formatCostUsd(monthlyBudgetUsd)}
          </p>
        </div>

        <div className={`rounded border p-4 ${STATUS_CARD_CLASSES[copy.tone]}`}>
          <p className="mb-0.5 text-xs opacity-80">Status</p>
          <p className="text-sm font-semibold">{copy.headline}</p>
          {ratio !== null && (
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--gray-04)]">
              <div
                className={`h-full rounded-full ${
                  capStatus === "exhausted" ? "bg-[var(--red-09)]" : "bg-[var(--green-09)]"
                }`}
                style={{ width: `${Math.round(ratio * 100)}%` }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
