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
 * Read-only legacy factory merge state, with an owner-only revocation path.
 * New automatic-merge grants are unavailable.
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
    if (!canManage || isPending || !granted) return;
    setError(null);
    startTransition(async () => {
      const result = await setMergePermissionAction(workspaceId, false);
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
          {/* control's primary name/title, the only heading in this component → bold */}
          <span className="text-sm font-bold text-[var(--gray-12)]">
            Automatic merge (legacy)
          </span>
          <span className="text-xs text-[var(--gray-09)]">
            {granted
              ? "Active legacy grant. Revoke to require human merge."
              : "Off. Merge requires a human."}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={granted}
          aria-label="Revoke legacy factory automatic merge"
          disabled={!canManage || isPending || !granted}
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

      {canManage && granted && (
        <p className="text-xs text-[var(--gray-09)]">
          Revocation is permanent; new grants are unavailable.
        </p>
      )}

      {error && <p className="text-xs text-[var(--red-11)]">{error}</p>}

      {lastGrant && (
        <p className="text-xs text-[var(--gray-09)]">
          Last {lastGrant.granted ? "granted" : "revoked"} by{" "}
          <span className="text-[var(--gray-11)]">{granterLabel(lastGrant)}</span> on{" "}
          {/* timestamp → mono, per IA principle 7 */}
          <span className="font-mono">
            {new Date(lastGrant.createdAt).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </span>
          .
        </p>
      )}
    </div>
  );
}
