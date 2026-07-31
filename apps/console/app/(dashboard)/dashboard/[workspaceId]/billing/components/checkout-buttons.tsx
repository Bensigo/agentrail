"use client";

import { useState, useTransition } from "react";
import { createSubscriptionCheckoutSessionAction } from "../actions";

/**
 * Slice-3 plan Task 5's two self-serve checkout buttons. Local plan union
 * (not imported from `lib/billing/stripe-plans.ts`'s `PaidPlan`) — mirrors
 * this codebase's established "duplicate small types across the
 * client/server boundary rather than centralize them" convention (see
 * `billing/actions.ts`'s own `ADMIN_ROLES` doc-comment for the same
 * posture), and keeps this file free of the deep `../../../../../../lib/...`
 * import a `components/` subfolder would otherwise need.
 *
 * Prices are plainly-stated product copy, never AI-cost language (spec §1
 * Principles) — this button never mentions tokens, models, or $/task.
 */
const PLANS = [
  { plan: "starter", label: "Starter", priceLabel: "$80/mo" },
  { plan: "growth", label: "Growth", priceLabel: "$200/mo" },
] as const;

interface CheckoutButtonsProps {
  workspaceId: string;
  canManage: boolean;
}

/**
 * `createSubscriptionCheckoutSessionAction` returns `{ ok: true, url }`
 * rather than calling `redirect()` itself (unlike `wallet/actions.ts`'s
 * `createTopUpCheckoutSessionAction`) — its own test suite never mocks
 * `next/navigation`, so a server-side `redirect()` inside it would throw
 * uncaught in every one of those tests. This component does the navigation
 * client-side instead: same `useTransition`/`startTransition`/error-state
 * shape as `wallet/components/top-up-form.tsx`, with a plain
 * `window.location.href` hop to Stripe's (external, cross-origin) Checkout
 * page as the one difference.
 *
 * `canManage` mirrors `TopUpForm`'s own posture: disabled here is a UX
 * nicety, never the security boundary — the action re-checks owner/admin
 * server-side on every call.
 */
export function CheckoutButtons({ workspaceId, canManage }: CheckoutButtonsProps) {
  const [error, setError] = useState<string | null>(null);
  const [pendingPlan, setPendingPlan] = useState<(typeof PLANS)[number]["plan"] | null>(null);
  const [isPending, startTransition] = useTransition();

  const disabled = !canManage || isPending;

  function submit(plan: (typeof PLANS)[number]["plan"]) {
    if (disabled) return;
    setError(null);
    setPendingPlan(plan);
    startTransition(async () => {
      const result = await createSubscriptionCheckoutSessionAction(workspaceId, plan);
      if (result.ok) {
        window.location.href = result.url;
        return;
      }
      setError(result.error);
      setPendingPlan(null);
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-4">
      <span className="text-sm font-bold text-[var(--gray-12)]">Upgrade your plan</span>

      <div className="flex flex-wrap gap-2">
        {PLANS.map(({ plan, label, priceLabel }) => (
          <button
            key={plan}
            type="button"
            disabled={disabled}
            onClick={() => submit(plan)}
            className="rounded bg-[var(--accent-fill)] px-4 py-2 text-sm font-medium text-[var(--accent-fill-text)] transition-colors duration-150 ease-out hover:bg-[var(--accent-fill-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending && pendingPlan === plan
              ? "Starting checkout…"
              : `${label} — ${priceLabel}`}
          </button>
        ))}
      </div>

      {!canManage && (
        <p className="text-xs text-[var(--gray-09)]">
          Only an owner or admin can change the subscription.
        </p>
      )}
      {error && <p className="text-xs text-[var(--red-11)]">{error}</p>}
    </div>
  );
}
