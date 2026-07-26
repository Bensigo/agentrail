"use client";

import { useState, useTransition } from "react";
import { createTopUpCheckoutSessionAction } from "../actions";
import { MAX_TOP_UP_USD_CENTS, MIN_TOP_UP_USD_CENTS } from "../top-up-constants";

interface TopUpFormProps {
  workspaceId: string;
  canManage: boolean;
  stripeConfigured: boolean;
}

const PRESET_AMOUNTS_USD = [25, 100, 500];

/**
 * The "top up" action (#1415 AC1). Redirects the whole page to Stripe
 * Checkout on submit — `createTopUpCheckoutSessionAction` calls
 * `redirect()` itself on success, so a successful submit never resolves
 * back into this component; only a validation/auth error does.
 *
 * `canManage` mirrors `MergePermissionToggle`'s posture: disabled here is a
 * UX nicety, never the security boundary — the action re-checks owner/admin
 * server-side on every call.
 */
export function TopUpForm({ workspaceId, canManage, stripeConfigured }: TopUpFormProps) {
  const [amountUsd, setAmountUsd] = useState("25");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const disabled = !canManage || !stripeConfigured || isPending;

  function submit(usd: number) {
    if (disabled) return;
    setError(null);
    const amountUsdCents = Math.round(usd * 100);
    startTransition(async () => {
      const result = await createTopUpCheckoutSessionAction(workspaceId, amountUsdCents);
      // Only an error path returns — success calls redirect() and never
      // gets here.
      if (!result.ok) {
        setError(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-4">
      <span className="text-sm font-bold text-[var(--gray-12)]">Top up</span>

      <div className="flex flex-wrap gap-2">
        {PRESET_AMOUNTS_USD.map((usd) => (
          <button
            key={usd}
            type="button"
            disabled={disabled}
            onClick={() => submit(usd)}
            className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-1.5 text-sm text-[var(--gray-12)] transition-colors duration-150 ease-out hover:bg-[var(--gray-03)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            ${usd}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <span className="font-mono text-sm text-[var(--gray-09)]">$</span>
        <input
          type="number"
          min={MIN_TOP_UP_USD_CENTS / 100}
          max={MAX_TOP_UP_USD_CENTS / 100}
          step="1"
          value={amountUsd}
          disabled={disabled}
          onChange={(e) => setAmountUsd(e.target.value)}
          className="h-8 w-28 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-2 font-mono text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-fill)] focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <button
          type="button"
          disabled={disabled || !Number(amountUsd)}
          onClick={() => submit(Number(amountUsd))}
          className="h-8 rounded bg-[var(--accent-fill)] px-4 text-sm font-medium text-[var(--accent-fill-text)] transition-colors duration-150 ease-out hover:bg-[var(--accent-fill-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? "Starting checkout…" : "Top up"}
        </button>
      </div>

      {!stripeConfigured && (
        <p className="text-xs text-[var(--gray-09)]">
          Billing isn&apos;t configured for this deployment yet.
        </p>
      )}
      {stripeConfigured && !canManage && (
        <p className="text-xs text-[var(--gray-09)]">
          Only an owner or admin can top up the wallet.
        </p>
      )}
      {error && <p className="text-xs text-[var(--red-11)]">{error}</p>}
    </div>
  );
}
