"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
export function WorkflowControls({ workspaceId, taskId, revision, phase, canManage = false, activeCheck = false }: { workspaceId?: string; taskId?: string; revision?: number; phase?: string; canManage?: boolean; activeCheck?: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function decide(decision: "complete" | "reopen" | "release_check") {
    setPending(true); setError("");
    try {
      const response = await fetch(`/api/v1/workflow/tasks/${taskId}?workspaceId=${workspaceId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventKey: crypto.randomUUID(), expectedRevision: revision, decision }) });
      if (!response.ok) { const body = await response.json(); throw new Error(body.error || "Decision failed"); }
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Decision failed"); }
    finally { setPending(false); }
  }
  return <div className="flex flex-wrap items-center gap-3">
    <button onClick={() => router.refresh()} className="rounded border border-[var(--gray-06)] px-3 py-2 text-sm">Refresh</button>
    {canManage && !activeCheck && phase === "needs_review" && <button disabled={pending} onClick={() => decide("complete")} className="rounded bg-[var(--brand-accent)] px-3 py-2 text-sm text-[var(--accent-fill-text)]">Close task</button>}
    {canManage && phase === "closed" && <button disabled={pending} onClick={() => decide("reopen")} className="rounded border border-[var(--gray-06)] px-3 py-2 text-sm">Reopen task</button>}
    {canManage && activeCheck && <button disabled={pending} onClick={() => decide("release_check")} className="rounded border border-[var(--gray-06)] px-3 py-2 text-sm">Release expired check hold</button>}
    {error && <p role="alert" className="text-sm">{error}</p>}
  </div>;
}
