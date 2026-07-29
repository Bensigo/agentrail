"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const BASE = "px-1.5 py-0.5 rounded-sm text-xs font-medium";

/**
 * The human confirmation gate on the LATEST verdict item (Task 13 —
 * `confirmVerdictAsHuman` is the query this POSTs through to; the knowledge
 * loop and calibration read the resulting `data.humanConfirmed`). Mirrors
 * `briefs/components/brief-status-toggle.tsx`'s fetch-then-`router.refresh()`
 * shape: this component only ever calls the one `confirm` route below, so it
 * has no path to touch anything else on the ledger.
 *
 * Three renders: already confirmed (green, static — confirming twice is not
 * a thing this UI offers, since there is nothing further to flip);
 * confirmed=false but the viewer cannot manage (muted "awaiting" label, no
 * button — matches every other `canManage`-gated action in this codebase);
 * confirmed=false and the viewer CAN manage (the actual button). The
 * server-side owner/admin check on the route is the real boundary; hiding
 * the button here is a courtesy, same posture `BriefItemCard`'s own
 * doc-comment states for its Edit/Delete buttons.
 */
export function ConfirmVerdict({
  workspaceId,
  slug,
  confirmed,
  canManage,
}: {
  workspaceId: string;
  slug: string;
  confirmed: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/investigations/${slug}/confirm`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to confirm this verdict");
    } finally {
      setSaving(false);
    }
  }

  if (confirmed) {
    return (
      <span className={`${BASE} bg-[color-mix(in_srgb,var(--green-11)_16%,transparent)] text-[var(--green-11)]`}>
        Confirmed by a human
      </span>
    );
  }

  if (!canManage) {
    return <span className={`${BASE} bg-[var(--gray-03)] text-[var(--gray-09)]`}>Awaiting human confirmation</span>;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={confirm}
        disabled={saving}
        className="h-7 px-3 rounded bg-[var(--yellow-09)] text-black text-xs font-medium hover:bg-[var(--yellow-09-hover)] disabled:opacity-50 transition-colors"
      >
        {saving ? "Confirming…" : "Confirm verdict"}
      </button>
      {error && <p className="text-xs text-[var(--red-11)]">{error}</p>}
    </div>
  );
}
