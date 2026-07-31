"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { releaseSeatAction } from "../actions";

interface ReleaseSeatButtonProps {
  workspaceId: string;
  seatId: string;
  ariaLabel: string;
}

/**
 * Slice-4 plan Task 5's per-seat Release button. Same
 * useTransition/startTransition/error-state shape as `ManageBillingButton`
 * in this same directory, but stays on the page instead of redirecting:
 * `router.refresh()` on success (mirrors `../../approvals/components/
 * pending-approvals-list.tsx`'s own `router.refresh()` after a mutation)
 * re-runs the page's server-side `listActiveSeatsWithHolders` read so the
 * released seat drops out of the list. `releaseSeatAction` itself already
 * calls `revalidatePath` server-side, so this refresh reads the fresh Data
 * Cache entry rather than racing a stale one.
 *
 * `ariaLabel` comes from `releaseSeatButtonLabel` (`../billing-helpers.ts`)
 * — the page computes it per-row from that seat's `holderLabel` so a screen
 * reader hears which seat a given button releases, rather than a bare
 * "Release" repeated once per row.
 *
 * This component takes no `canManage` prop at all — unlike
 * `ManageBillingButton`/`CheckoutButtons` (which DO take one and self-
 * disable + show an explanatory line), the page omits this component
 * ENTIRELY for a non-manager (`{canManage && <ReleaseSeatButton .../>}` in
 * `../page.tsx`), the same full-omission shape
 * `../../approvals/components/pending-approvals-list.tsx` uses for its own
 * per-row Actions cell. A disabled-with-a-message button repeated once per
 * seat row would print "Only an owner or admin…" N times down the list;
 * omitting the column/button entirely, once, is the right call for a
 * per-row action instead. `releaseSeatAction` re-checks ADMIN_ROLES
 * server-side regardless — a client-omitted button is never the actual
 * enforcement boundary, only this file's reason not to render one.
 */
export function ReleaseSeatButton({ workspaceId, seatId, ariaLabel }: ReleaseSeatButtonProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    if (isPending) return;
    setError(null);
    startTransition(async () => {
      const result = await releaseSeatAction(workspaceId, seatId);
      if (result.ok) {
        router.refresh();
        return;
      }
      setError(result.error);
    });
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        aria-label={ariaLabel}
        disabled={isPending}
        onClick={submit}
        className="h-7 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-2.5 text-xs text-[var(--gray-11)] transition-colors duration-150 ease-out hover:bg-[var(--gray-03)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? "Releasing…" : "Release"}
      </button>
      {error && <p className="text-xs text-[var(--red-11)]">{error}</p>}
    </div>
  );
}
