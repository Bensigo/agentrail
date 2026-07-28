"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { BriefStatus } from "@agentrail/db-postgres";

const OPTIONS: BriefStatus[] = ["draft", "ready"];

/**
 * The `draft`/`ready` toggle — a HUMAN label the human owns, deliberately
 * NOT the same thing as computed readiness (design spec: "`status` is a
 * HUMAN label... Implementation-readiness is computed separately from the
 * items"; `to-issues` gates on `computeBriefReadiness`, never this flag).
 * This component only ever calls the `status` route below — it has no path
 * to touch any item, so it structurally cannot become a way to fake
 * readiness. The page renders the COMPUTED readiness banner right next to
 * this control, on purpose, so the two are never visually conflated.
 */
export function BriefStatusToggle({
  workspaceId,
  slug,
  status,
  canManage,
}: {
  workspaceId: string;
  slug: string;
  status: BriefStatus;
  canManage: boolean;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setStatus(next: BriefStatus) {
    if (next === status || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/briefs/${slug}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update status");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex overflow-hidden rounded border border-[var(--gray-06)]">
        {OPTIONS.map((option) => {
          const active = option === status;
          return (
            <button
              key={option}
              type="button"
              disabled={!canManage || saving}
              onClick={() => setStatus(option)}
              className={`h-7 px-3 text-xs font-medium capitalize transition-colors disabled:cursor-not-allowed ${
                active
                  ? "bg-[var(--yellow-09)] text-black"
                  : "bg-[var(--gray-02)] text-[var(--gray-09)] hover:text-[var(--gray-12)] disabled:hover:text-[var(--gray-09)]"
              }`}
            >
              {option}
            </button>
          );
        })}
      </div>
      {error && <p className="text-xs text-[var(--red-11)]">{error}</p>}
    </div>
  );
}
