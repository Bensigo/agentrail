/**
 * #1415 (Stripe top-up) — pure display/formatting helpers for the Wallet
 * page, split out for unit testing (mirrors `../budget/budget-helpers.ts`'s
 * own split).
 *
 * Internal-only since slice 6 (sidebar-hidden staff telemetry, spec §8) — this page's dollar copy is deliberately kept.
 */

/** Integer cents -> a plain-dollars string ("$12.34"), never bare cents or a
 *  raw float — the house vocabulary rule (plain dollars/English). */
export function formatUsdCents(amountUsdCents: number): string {
  const dollars = amountUsdCents / 100;
  const sign = dollars < 0 ? "-" : "";
  return `${sign}$${Math.abs(dollars).toFixed(2)}`;
}

export function walletTransactionLabel(kind: "top_up" | "task_charge"): string {
  return kind === "top_up" ? "Top-up" : "Task charge";
}

/** Employer-of-an-engineer, plain-English message for a negative balance —
 *  never "credits exhausted"/"quota"/"tokens" (house vocabulary rule). AC2:
 *  the next admission blocks until a top-up lands; this is that plain-
 *  language explanation, shown on the console surface a human actually
 *  reads. */
export function lowBalanceMessage(balanceUsdCents: number): string | null {
  if (balanceUsdCents >= 0) return null;
  return `Balance is ${formatUsdCents(balanceUsdCents)}. The next task won't start until you top up.`;
}
