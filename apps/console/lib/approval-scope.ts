/**
 * Single source of the "how big is this task" vocabulary the approval
 * surfaces speak when `BILLING_SUBSCRIPTIONS_ENFORCED` is on (subscription
 * platform slice 6, Task 5 — spec `docs/superpowers/specs/2026-07-29-
 * subscription-platform-design.md` §7; plan `docs/superpowers/plans/
 * 2026-07-31-subscription-console-slice6.md`'s Global Constraints:
 * "Customer never sees dollars, model names, or the word 'budget'" on any
 * surface this slice touches when the flag is on). THREE call sites read
 * from here — the chat/Telegram approval message (`approval-message.ts`'s
 * `renderAlignmentBrief`), the console Approvals page mirror
 * (`approvals-helpers.ts`), and the landing demo
 * (`(marketing)/_conversation-demo.tsx`, unconditionally) — so the
 * thresholds and the exact wording live in exactly ONE place; no site
 * re-derives or re-types them.
 *
 * Pure, zero imports: safe to import from a server lib that reads the flag
 * directly (`approval-message.ts`, channel-dispatch.ts's own precedent), a
 * client-adjacent module that must NEVER import the flag itself
 * (`approvals-helpers.ts` — see that file's header comment), and a
 * `"use client"` component (`_conversation-demo.tsx`) alike.
 */

/** The three task-size buckets a customer-facing surface can show. */
export type TaskScope = "small" | "medium" | "large";

/**
 * Bucket a live `estimateUsd` into its scope (plan's Global Constraints,
 * byte-exact): `< 2` → small, `< 6` → medium, else large. Boundaries are
 * pinned in `approval-scope.test.ts` at 1.99/2/5.99/6.
 */
export function scopeForEstimate(estimateUsd: number): TaskScope {
  if (estimateUsd < 2) return "small";
  if (estimateUsd < 6) return "medium";
  return "large";
}

/**
 * The chat/Telegram approval sanction sentence — replaces
 * `approval-message.ts`'s dollar-denominated line
 * ("Approving sets this run's budget: ~$X.XX") when the flag is on. Never
 * contains "$".
 */
export function scopeSentence(estimateUsd: number): string {
  return `Approving starts a ${scopeForEstimate(estimateUsd)} task.`;
}

const SCOPE_FIELD_VALUE: Record<TaskScope, string> = {
  small: "Small task",
  medium: "Medium task",
  large: "Large task",
};

/**
 * The console Approvals page's structured "Scope" field value — replaces
 * `approvals-helpers.ts`'s `{ label: "Estimate", value: "~$X.XX" }` field
 * when the flag is on. Never contains "$".
 */
export function scopeFieldValue(estimateUsd: number): string {
  return SCOPE_FIELD_VALUE[scopeForEstimate(estimateUsd)];
}
