"use client";

import { useState, useTransition } from "react";
import { createPortalSessionAction } from "../actions";

interface ManageBillingButtonProps {
  workspaceId: string;
  canManage: boolean;
}

/**
 * Slice-3 plan Task 5's "Manage billing" button — hands the customer to
 * Stripe's hosted portal. Same client-side-redirect-on-`{ok:true,url}`
 * shape as `CheckoutButtons` in this same directory (see that component's
 * own doc-comment for why the redirect happens here rather than inside the
 * server action), and the same disabled-not-hidden `canManage` posture as
 * `wallet/components/top-up-form.tsx`.
 *
 * The page only renders this component at all when `stripeCustomerId` is
 * present (spec: portal link "only when stripeCustomerId present") — this
 * component itself doesn't re-check that, since a workspace with no Stripe
 * customer yet has nothing to gate here; `createPortalSessionAction`'s own
 * typed error is the server-side backstop if it's ever reached anyway.
 */
export function ManageBillingButton({ workspaceId, canManage }: ManageBillingButtonProps) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const disabled = !canManage || isPending;

  function submit() {
    if (disabled) return;
    setError(null);
    startTransition(async () => {
      const result = await createPortalSessionAction(workspaceId);
      if (result.ok) {
        window.location.href = result.url;
        return;
      }
      setError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={disabled}
        onClick={submit}
        className="w-fit rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-4 py-2 text-sm text-[var(--gray-12)] transition-colors duration-150 ease-out hover:bg-[var(--gray-03)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? "Opening billing…" : "Manage billing"}
      </button>
      {!canManage && (
        <p className="text-xs text-[var(--gray-09)]">
          Only an owner or admin can manage billing.
        </p>
      )}
      {error && <p className="text-xs text-[var(--red-11)]">{error}</p>}
    </div>
  );
}
