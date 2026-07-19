"use server";

import { revalidatePath } from "next/cache";
import { setMergePermission } from "@agentrail/db-postgres";
import { getMembership, getSession } from "../../../../../lib/cached";

export type SetMergePermissionActionResult =
  | { ok: true; granted: boolean }
  | { ok: false; error: string };

/**
 * Owner-only server action backing the merge-permission toggle (#1278).
 *
 * Deliberately narrower than this repo's existing `ADMIN_ROLES` precedent
 * (owner OR admin — see repos/api-keys pages): granting merge is the trust
 * ceiling, the one setting that lets AgentRail push code to `main`
 * unattended, so only the workspace owner may flip it.
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

  // Re-render the page server-side on next navigation/refresh so the toggle
  // and the "last granted by / when" line reflect the just-written row —
  // the client component calls router.refresh() right after this resolves.
  revalidatePath(`/dashboard/${workspaceId}/permissions`);

  return { ok: true, granted: result.mergePermission };
}
