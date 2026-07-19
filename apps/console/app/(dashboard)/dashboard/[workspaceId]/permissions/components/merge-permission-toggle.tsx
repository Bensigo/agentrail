"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setMergePermissionAction } from "../actions";

export interface MergePermissionLastGrant {
  granted: boolean;
  createdAt: string;
  grantedByName: string | null;
  grantedByEmail: string | null;
}

interface MergePermissionToggleProps {
  workspaceId: string;
  granted: boolean;
  canManage: boolean;
  lastGrant: MergePermissionLastGrant | null;
}

function granterLabel(lastGrant: MergePermissionLastGrant): string {
  return lastGrant.grantedByName || lastGrant.grantedByEmail || "a workspace owner";
}

/**
 * The merge-permission switch (#1278). No optimistic flip: a security-
 * relevant toggle shows its REAL, server-confirmed state, never a state the
 * write hasn't landed for yet — the toggle stays disabled mid-flight and
 * only moves once `router.refresh()` re-renders the parent server component
 * with the freshly written row. Server-side re-checks the owner-only rule
 * on every call (`../actions.ts`); `canManage` here only decides whether
 * this control is interactive.
 */
export function MergePermissionToggle({
  workspaceId,
  granted,
  canManage,
  lastGrant,
}: MergePermissionToggleProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleToggle() {
    if (!canManage || isPending) return;
    setError(null);
    startTransition(async () => {
      const result = await setMergePermissionAction(workspaceId, !granted);
      if (result.ok) {
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-[var(--gray-12)]">
            Merge permission
          </span>
          <span className="text-xs text-[var(--gray-09)]">
            {granted
              ? "ON: green-gated work merges itself."
              : "OFF: Jace opens PRs and waits for you."}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={granted}
          aria-label="Merge permission"
          disabled={!canManage || isPending}
          onClick={handleToggle}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ease-out disabled:cursor-not-allowed disabled:opacity-50 ${
            granted ? "bg-[var(--green-09)]" : "bg-[var(--gray-06)]"
          }`}
        >
          <span
            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ease-out ${
              granted ? "translate-x-[20px]" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      {!canManage && (
        <p className="text-xs text-[var(--gray-09)]">
          Only the workspace owner can change this.
        </p>
      )}

      {error && <p className="text-xs text-[var(--red-11)]">{error}</p>}

      {lastGrant && (
        <p className="text-xs text-[var(--gray-09)]">
          Last {lastGrant.granted ? "granted" : "revoked"} by{" "}
          <span className="text-[var(--gray-11)]">{granterLabel(lastGrant)}</span> on{" "}
          {new Date(lastGrant.createdAt).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
          .
        </p>
      )}
    </div>
  );
}
