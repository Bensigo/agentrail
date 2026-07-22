/**
 * #1290 (prepaid per-task wallet, Wave 5 / epic #1257; design locked
 * 2026-07-22) — the CUSTOMER-FACING price of one completed task.
 *
 * This is a NEW, SEPARATE number from the internal execution-budget cap that
 * `apps/console/lib/alignment/estimate.ts` computes. Those two must never
 * collapse into one:
 *   - `estimateBrief().estimateUsd` is the PRE-task budget cap / the number
 *     the alignment brief shows (an assumption made from volume proxies,
 *     BEFORE the task runs). The admission check compares the wallet balance
 *     against THAT number.
 *   - `taskPriceCents` is the POST-task bill, computed from the task's REAL
 *     token cost once it has finished (`run_outcomes` / the #1272 cost ledger).
 *     The wallet is charged THIS number.
 *
 * Pricing formula (design, locked):
 *   price = actual_token_cost + FLAT_SERVER_FEE + FLAT_PROFIT
 * computed AFTER completion from real usage. There is no subscription and no
 * per-token markup — just the real cost plus two flat, named, tunable amounts.
 *
 * The two flat constants below are ASSUMPTIONS-NOW-RECALIBRATE-LATER, in the
 * exact spirit of `estimate.ts`'s `VOLUME_TOKEN_ASSUMPTIONS` /
 * `SMALL_AC_COUNT` etc. — documented starting values, deliberately NOT
 * hardcoded inside the pricing math, so the number a customer is billed can be
 * retuned in ONE place once there is real completed-task revenue/cost data to
 * fit them against (rather than a guess baked into an expression).
 *
 * Money is INTEGER CENTS everywhere in this module — no float arithmetic on
 * money. The one place dollars become cents (`usdToCents`) rounds at that
 * single boundary and is the only float touch; every price computation after
 * it is exact integer addition.
 */

/**
 * ASSUMPTION (recalibrate later): the flat per-task server fee, in integer
 * cents. Covers the hosted-fleet infrastructure/orchestration overhead a task
 * incurs that is NOT captured in its model token cost — the Railway fleet
 * service, Postgres/ClickHouse, the AI gateway, webhook + git plumbing. Not a
 * measured unit cost; a documented starting value to retune once real
 * per-task infra cost is known. $0.50.
 */
export const FLAT_SERVER_FEE_CENTS = 50;

/**
 * ASSUMPTION (recalibrate later): the flat profit margin added to every
 * completed task, in integer cents. The product's per-task take on top of
 * (token cost + server fee). Flat by design — the wallet prices a task, not a
 * subscription — and a documented starting value, not a fitted one. $1.00.
 */
export const FLAT_PROFIT_CENTS = 100;

/**
 * Convert a US-dollar amount to integer cents. This is the ONE float→integer
 * money boundary in the wallet engine: `Math.round(usd * 100)` rounds a
 * float-dollar figure (e.g. `run_outcomes.cost_usd`, or the alignment brief's
 * `estimateUsd`) to whole cents exactly once, here. Every downstream money
 * computation operates on the returned integer, never on floats. A negative
 * input is preserved (rounds toward the nearest cent), so this is safe for
 * both credits and debits.
 */
export function usdToCents(usd: number): number {
  return Math.round(usd * 100);
}

/**
 * The customer-facing price of ONE completed task, in integer cents:
 *
 *     actual_token_cost_cents + FLAT_SERVER_FEE_CENTS + FLAT_PROFIT_CENTS
 *
 * Pure and deterministic — no I/O, no clock, no float arithmetic on money.
 * `actualTokenCostCents` is expected to already be integer cents (the caller
 * converts the #1272 ledger's dollar cost via {@link usdToCents} at the DB
 * boundary); it is defensively `Math.round`ed here so a stray fractional cent
 * can never leak a float into the total. A zero (or, defensively, negative)
 * token cost still yields at least `FLAT_SERVER_FEE_CENTS + FLAT_PROFIT_CENTS`
 * for a task that actually completed — the two flat amounts are always
 * charged.
 */
export function taskPriceCents(input: { actualTokenCostCents: number }): number {
  const tokenCents = Math.round(input.actualTokenCostCents);
  return tokenCents + FLAT_SERVER_FEE_CENTS + FLAT_PROFIT_CENTS;
}
