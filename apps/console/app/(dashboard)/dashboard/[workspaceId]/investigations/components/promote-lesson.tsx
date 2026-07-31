"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The console-only promotion gate on a `lesson_candidate` item (Task 13 —
 * "Jace never writes memory; the promotion is CONSOLE-ONLY — this task
 * builds that gate"). POSTs `{ itemId }` to the promote route, which copies
 * the item's body into workspace memory via the SAME server-side insert
 * path onboarding/review memory uses (`insertMemoryItems`) and marks
 * `data.promotedAt` on the item for idempotency. Mirrors
 * `briefs/components/brief-status-toggle.tsx`'s fetch-then-`router.refresh()`
 * shape.
 *
 * `promoted` (derived from `data.promotedAt` being present) disables the
 * button and relabels it "Promoted" — the route itself 409s a second
 * promote of the same item, so this is a courtesy that avoids a wasted round
 * trip, not the actual idempotency boundary.
 */
export function PromoteLesson({
  workspaceId,
  slug,
  itemId,
  promoted,
  canManage,
}: {
  workspaceId: string;
  slug: string;
  itemId: string;
  promoted: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function promote() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/investigations/${slug}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to promote this lesson");
    } finally {
      setSaving(false);
    }
  }

  if (!canManage && !promoted) {
    return null;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={promote}
        disabled={saving || promoted || !canManage}
        className="h-7 px-3 rounded bg-[var(--yellow-09)] text-black text-xs font-medium hover:bg-[var(--yellow-09-hover)] disabled:opacity-50 transition-colors"
      >
        {promoted ? "Promoted" : saving ? "Promoting…" : "Promote to memory"}
      </button>
      {error && <p className="text-xs text-[var(--red-11)]">{error}</p>}
    </div>
  );
}
