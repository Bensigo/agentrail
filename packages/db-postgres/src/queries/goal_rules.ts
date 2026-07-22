/**
 * Issue #1289 — the Jace goal loop's SAFETY HEART: a pure, dependency-free
 * decision function evaluating one terminal run outcome against a goal's
 * current leash/stuck-rule counters. No database, no I/O, no Eve — this is
 * a plain function of (state, event) -> transition, so it is exhaustively
 * unit-testable and independently auditable from the query/wiring layer
 * that calls it (`goals.ts::recordOutcomeAndTransition`).
 *
 * THE GUARANTEE THIS FILE EXISTS TO PROVE (binding, do not weaken): a goal
 * that never reaches its check MUST stop — never loop forever. Two
 * independent bounds enforce this:
 *
 *   1. LEASH — `maxIssues` / `maxSpendUsd`. Both `issuesFiled` and
 *      `spendUsd` are monotonically non-decreasing (nothing in this
 *      codebase ever reduces them), so once either meets its cap the goal
 *      transitions to `leashed` and — critically — EVERY subsequent call
 *      with that same terminal `status` short-circuits to `noop` before
 *      any other rule runs (see the `status !== "active"` guard below).
 *      There is no path back to `active` from `leashed`.
 *   2. STUCK — `stuckThreshold` consecutive non-green outcomes. A green
 *      outcome resets the counter to 0 (a genuinely improving goal is never
 *      penalized for one prior miss), but `stuckThreshold` misses IN A ROW
 *      pauses the goal — same terminal short-circuit as leash.
 *
 * Precedence when a single event could satisfy more than one rule at once:
 * REACHED > LEASHED > STUCK > refill. A goal that satisfies its check on
 * the very last unit of leash is reported as `reached`, never misreported
 * as `leashed` — a successful completion must never read as a failure.
 * Leash is checked before the stuck rule: a goal that exhausts its leash on
 * a non-green outcome that ALSO happens to trip the stuck counter reports
 * `leashed` (the harder, spend-relevant bound), not `escalate_stuck`.
 *
 * Every non-`active` status (`reached`, `leashed`, `paused`, `abandoned`) is
 * TERMINAL: the very first check in `decideGoalTransition` is `state.status
 * !== "active"`, which returns `noop` and freezes every counter verbatim —
 * no further mutation, regardless of what the incoming event carries. This
 * is what makes the bound provable rather than merely likely: there is
 * exactly one gate (`status === "active"`) standing between "the loop can
 * still act" and "the loop can never act again for this goal", and it is
 * evaluated first, unconditionally, on every single call.
 */

/** Goal lifecycle. Every value but `active` is TERMINAL — see module doc-comment. */
export type GoalStatus = "active" | "reached" | "leashed" | "paused" | "abandoned";

/**
 * The terminal outcome vocabulary already on the wire from the console's
 * run-outcome hand-off (the `queue_entries`/`TerminalQueueState` states,
 * see `queries/runner.ts`) — reused as-is rather than re-mapped, so this
 * module never drifts from what `notify.ts` actually sends. "green" is the
 * only positive outcome; "escalated-to-human" and "blocked" both count as
 * non-green for the stuck rule.
 */
export type GoalOutcome = "green" | "escalated-to-human" | "blocked";

export type GoalCheckType = "metric" | "command";

/** What the caller should do in response to a decided transition. */
export type GoalAction =
  | "refill"
  | "reached"
  | "escalate_leashed"
  | "escalate_stuck"
  | "noop";

export interface GoalLeashState {
  status: GoalStatus;
  maxIssues: number;
  maxSpendUsd: number;
  /** Issues filed so far, BEFORE this event (outcome events never file issues themselves — only `recordIssueFiled` increments this). */
  issuesFiled: number;
  /** Spend recorded so far, BEFORE this event's own cost is added. */
  spendUsd: number;
  stuckThreshold: number;
  /** Consecutive non-green outcomes so far, BEFORE this event. */
  consecutiveNonGreen: number;
  checkType: GoalCheckType;
  /** Null when unset (a command-type goal, or a metric goal with no threshold configured yet — never auto-reaches). */
  checkThreshold: number | null;
  /** Running count of green outcomes so far, BEFORE this event (the v1 metric-check formula's counter). */
  greenCount: number;
}

export interface GoalOutcomeEvent {
  outcome: GoalOutcome;
  /** Non-negative; a negative value is treated as 0 (defensive — cost is never a credit). */
  costUsd: number;
}

export interface GoalTransitionResult {
  nextStatus: GoalStatus;
  action: GoalAction;
  reason: string;
  /** Every counter AFTER applying this decision — the caller persists these verbatim. */
  issuesFiledAfter: number;
  spendUsdAfter: number;
  consecutiveNonGreenAfter: number;
  greenCountAfter: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Decide what happens to a goal given its current leash/stuck state and one
 * new terminal outcome. See the module doc-comment for the full guarantee
 * and precedence rules. Never throws; every input combination resolves to
 * an explicit result.
 */
export function decideGoalTransition(
  state: GoalLeashState,
  event: GoalOutcomeEvent
): GoalTransitionResult {
  const isGreen = event.outcome === "green";
  const spendUsdAfter = round2(state.spendUsd + Math.max(0, event.costUsd || 0));
  const consecutiveNonGreenAfter = isGreen ? 0 : state.consecutiveNonGreen + 1;
  const greenCountAfter = isGreen ? state.greenCount + 1 : state.greenCount;

  // --- Terminal safety net (checked FIRST, unconditionally): once a goal
  // has left `active`, no event — however it's shaped — can ever move it
  // again, and no counter is mutated further. This is the ONE gate that
  // makes "never loops forever" provable rather than merely likely.
  if (state.status !== "active") {
    return {
      nextStatus: state.status,
      action: "noop",
      reason: `goal is already '${state.status}'; no further transitions are possible`,
      issuesFiledAfter: state.issuesFiled,
      spendUsdAfter: state.spendUsd,
      consecutiveNonGreenAfter: state.consecutiveNonGreen,
      greenCountAfter: state.greenCount,
    };
  }

  // --- 1. Reached: only a metric-type goal auto-completes in v1 (see
  // GoalCheckType's own doc-comment in schema/goals.ts for why command-type
  // is schema-reserved but not yet auto-evaluated). Checked BEFORE leash so
  // a goal that meets its check on its very last unit of leash reports a
  // genuine completion, never a false "leashed".
  if (
    state.checkType === "metric" &&
    state.checkThreshold != null &&
    greenCountAfter >= state.checkThreshold
  ) {
    return {
      nextStatus: "reached",
      action: "reached",
      reason: `check reached: ${greenCountAfter}/${state.checkThreshold} green outcomes`,
      issuesFiledAfter: state.issuesFiled,
      spendUsdAfter,
      consecutiveNonGreenAfter,
      greenCountAfter,
    };
  }

  // --- 2. Leash exhaustion (issues or spend — either trips it).
  if (state.issuesFiled >= state.maxIssues || spendUsdAfter >= state.maxSpendUsd) {
    const reason =
      state.issuesFiled >= state.maxIssues
        ? `leash exhausted: issues filed ${state.issuesFiled}/${state.maxIssues}`
        : `leash exhausted: spend $${spendUsdAfter}/$${state.maxSpendUsd}`;
    return {
      nextStatus: "leashed",
      action: "escalate_leashed",
      reason,
      issuesFiledAfter: state.issuesFiled,
      spendUsdAfter,
      consecutiveNonGreenAfter,
      greenCountAfter,
    };
  }

  // --- 3. Stuck rule: N consecutive non-green outcomes (default 2).
  if (consecutiveNonGreenAfter >= state.stuckThreshold) {
    return {
      nextStatus: "paused",
      action: "escalate_stuck",
      reason: `stuck: ${consecutiveNonGreenAfter} consecutive non-green outcomes (threshold ${state.stuckThreshold})`,
      issuesFiledAfter: state.issuesFiled,
      spendUsdAfter,
      consecutiveNonGreenAfter,
      greenCountAfter,
    };
  }

  // --- 4. Still active: continue pursuing the goal.
  return {
    nextStatus: "active",
    action: "refill",
    reason: "goal still active; leash remains and the stuck threshold is not met",
    issuesFiledAfter: state.issuesFiled,
    spendUsdAfter,
    consecutiveNonGreenAfter,
    greenCountAfter,
  };
}

/**
 * Decide what happens when an issue is about to be FILED toward a goal
 * (before any outcome exists for it). This is the leash's "issues" half —
 * `decideGoalTransition` never increments `issuesFiled` itself (only a
 * filed issue does), so a caller must check this FIRST and only actually
 * file (and call `recordIssueFiled`) when it returns `allow: true`.
 * Prevents filing the (maxIssues + 1)-th issue even if no outcome has come
 * back yet to trip `decideGoalTransition` retroactively.
 */
export function canFileNextIssue(
  state: Pick<GoalLeashState, "status" | "issuesFiled" | "maxIssues" | "spendUsd" | "maxSpendUsd">
): { allow: boolean; reason: string } {
  if (state.status !== "active") {
    return { allow: false, reason: `goal is '${state.status}', not active` };
  }
  if (state.issuesFiled >= state.maxIssues) {
    return {
      allow: false,
      reason: `leash exhausted: issues filed ${state.issuesFiled}/${state.maxIssues}`,
    };
  }
  if (state.spendUsd >= state.maxSpendUsd) {
    return {
      allow: false,
      reason: `leash exhausted: spend $${state.spendUsd}/$${state.maxSpendUsd}`,
    };
  }
  return { allow: true, reason: "leash remains" };
}
