"use server";

import { setMergePermission } from "@agentrail/db-postgres";
import { getMembership, getSession } from "../../../../../lib/cached";

export type SetMergePermissionActionResult =
  | { ok: true; granted: boolean }
  | { ok: false; error: string };

/**
 * Owner-only revocation path for the retained legacy factory merge setting.
 *
 * Deliberately narrower than this repo's existing `ADMIN_ROLES` precedent
 * The Trust Layer has no implementation or merge authority. New grants are
 * therefore rejected. An owner can still revoke a historical grant so a
 * previously enabled legacy factory setting is never stranded.
 *
 * Re-checks session + membership + role SERVER-side on every call — this is
 * the actual enforcement boundary. The page's `canManage` prop only decides
 * whether the client toggle renders interactive; a disabled client control
 * is a UX nicety, never a security control, so this function trusts nothing
 * the client sends except the two plain arguments below.
 */
export async function setMergePermissionAction(
  workspaceId: string,
  granted: boolean
): Promise<SetMergePermissionActionResult> {
  // #1343 minor (d): a Server Action is a real network endpoint — the
  // `boolean` type above is a compile-time contract for THIS app's own
  // client, not a runtime guarantee for whatever a raw POST to the action's
  // wire endpoint sends. Validate `granted` at runtime before it reaches
  // `setMergePermission`/Postgres. This is a robustness nit, not a live bug:
  // the action is owner-only reachable (checked below) and the
  // `boolean("granted")` column already rejects non-boolean garbage today —
  // this just fails fast with an honest error instead of relying on a DB
  // constraint error surfacing sensibly to the caller.
  if (typeof granted !== "boolean") {
    return { ok: false, error: "granted must be a boolean." };
  }

  if (granted) {
    return {
      ok: false,
      error: "Automatic merge grants are unavailable. Final merge remains a human decision.",
    };
  }

  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) {
    return { ok: false, error: "Not signed in." };
  }

  const membership = await getMembership(userId, workspaceId);
  if (!membership || membership.role !== "owner") {
    return {
      ok: false,
      error: "Only the workspace owner can change merge permission.",
    };
  }

  const result = await setMergePermission({
    workspaceId,
    granted,
    grantedByUserId: userId,
  });

  return { ok: true, granted: result.mergePermission };
}
