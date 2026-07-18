/**
 * Owner-elect ownership completion at the `/connect/[token]` bind (issue
 * #1264 PR ②) — the console-side counterpart to db-postgres's
 * `completeOwnerElectWorkspace`, itself the other half of PR ①'s
 * `createWorkspaceOwnerElect`: that function creates a workspace bound to a
 * chat identity with NO owner membership (spec §4.2, "chat identity becomes
 * owner-elect pending GitHub link"); this is what completes it, called from
 * the same bind flow `connect-bind-decision.ts`'s `decideConnectIdentityBind`
 * already governs.
 *
 * The page passes `identity.workspaceId` as captured BEFORE its own bind
 * mutations (from `consumeChatIdentityLinkToken`'s return) — non-null there
 * means the identity already carries a workspace, most commonly one Jace's
 * `create_workspace` tool created ownerless. This is deliberately NOT the
 * workspace `decideConnectWorkspaceBind` might separately bind in the SAME
 * request (the #1263 auto-bind-to-an-existing-membership path): that action
 * only ever fires when `identity.workspaceId` was null to begin with, so the
 * two paths never overlap in one request. Calling this against a workspace
 * that already has an owner (the common case for an ordinary, established
 * workspace) is always a safe, guarded no-op — `completed: false`, nothing
 * written — so the caller can invoke it unconditionally whenever
 * `identity.workspaceId` is non-null, with no need to first classify which
 * kind of workspace it is.
 */

import { completeOwnerElectWorkspace, getWorkspace } from "@agentrail/db-postgres";

export interface OwnerElectCompletionResult {
  completed: boolean;
  /** Only ever non-null when `completed` is true; null on any of: nothing to
   * complete, an already-owned workspace, or a post-completion name lookup
   * that failed. */
  workspaceName: string | null;
}

const NOT_COMPLETED: OwnerElectCompletionResult = {
  completed: false,
  workspaceName: null,
};

/**
 * Attempt owner-elect completion for the identity behind this bind. Never
 * throws/rejects — unlike `sendConnectBindConfirmation` (a best-effort
 * notify, silent on failure), this wraps a WRITE that matters: a real
 * ownership grant. A failure here must still not fail the page's render, so
 * it is caught, but LOUDLY — `console.error`'d with context — rather than
 * swallowed silently, so the gap is visible in logs. The recovery paths if
 * this ever fires are the in-chat disambiguation flow and the console's own
 * members UI, applied by hand; this helper does not retry.
 *
 * Two independent try/catch boundaries, not one, because they guard two
 * different facts:
 *  1. Did the ownership grant itself happen? (`completeOwnerElectWorkspace`)
 *     A throw here means we don't know for certain, so this conservatively
 *     reports `completed: false` — never claim ownership without a positive
 *     `{completed: true}` return.
 *  2. Given the grant DID happen, what's the workspace called?
 *     (`getWorkspace`) A throw here does NOT get folded into `completed:
 *     false` — the DB write genuinely succeeded (its `workspaceId` is FK-
 *     valid by construction), so reporting `false` would be a lie. This
 *     degrades to `workspaceName: null` instead; callers render a nameless
 *     ownership line rather than none at all.
 */
export async function completeConnectOwnerElect(input: {
  workspaceId: string | null;
  userId: string;
}): Promise<OwnerElectCompletionResult> {
  if (input.workspaceId == null) return NOT_COMPLETED;
  const { workspaceId, userId } = input;

  let outcome: { completed: boolean };
  try {
    outcome = await completeOwnerElectWorkspace({ workspaceId, userId });
  } catch (err) {
    console.error(
      "completeConnectOwnerElect: completeOwnerElectWorkspace failed",
      { workspaceId, userId, err }
    );
    return NOT_COMPLETED;
  }

  if (!outcome.completed) return NOT_COMPLETED;

  try {
    const workspace = await getWorkspace(workspaceId);
    return { completed: true, workspaceName: workspace?.name ?? null };
  } catch (err) {
    console.error(
      "completeConnectOwnerElect: getWorkspace lookup failed after a real completion",
      { workspaceId, userId, err }
    );
    return { completed: true, workspaceName: null };
  }
}

/**
 * Success-screen rendering decision (pure): plain text to show under the
 * existing "you're connected" copy, or null when there's nothing to say —
 * either the workspace already had an owner, or there was nothing to
 * complete. Never renders an error; a name-lookup failure after a real
 * completion falls back to a nameless-but-still-true ownership line rather
 * than disappearing entirely.
 */
export function buildOwnerElectCompletionLine(
  result: OwnerElectCompletionResult
): string | null {
  if (!result.completed) return null;
  return result.workspaceName
    ? `You now own ${result.workspaceName}.`
    : "You now own this workspace.";
}
