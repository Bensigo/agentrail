/**
 * Pure decision helper for the /connect/[token] landing page (issue #1263,
 * spec §4.2): whether to auto-bind a freshly-linked chat identity to a
 * workspace, given the identity's OWN (pre-bind) workspace_id and the
 * signed-in user's workspace memberships. Split out from the RSC page so the
 * workspace-completion rule is unit-testable without a database, a session,
 * or a request — the page only calls this and acts on the result.
 *
 * Rule, checked in this order:
 *  1. `already_bound` — the identity already carries a workspace_id. Never
 *     silently override an existing binding just because this pass also
 *     happens to resolve a single membership.
 *  2. `no_memberships` — the signed-in user belongs to zero workspaces
 *     (brand new user). Nothing to bind to.
 *  3. `ambiguous_memberships` — the user belongs to 2+ workspaces. Auto-
 *     picking one would be a guess; conversation-level disambiguation
 *     (issue #1261 PR ③, `resolveConversationWorkspace`/
 *     `pinConversationWorkspace`) already exists for exactly this case and
 *     asks once, in-chat, per conversation.
 *  4. `bind` — exactly one membership and no existing binding: the only case
 *     with one unambiguous right answer, so it completes automatically.
 *
 * This function never creates a membership or a workspace (issue #1264 owns
 * workspace creation / the owner-elect flow for a just-created workspace) —
 * it only decides whether to bind the identity to a workspace that already
 * exists.
 */

export interface ConnectWorkspaceMembership {
  id: string;
  name: string;
}

export interface DecideConnectWorkspaceBindInput {
  identity: { workspaceId: string | null };
  memberships: ConnectWorkspaceMembership[];
}

export type ConnectWorkspaceBindDecision =
  | { action: "bind"; workspace: ConnectWorkspaceMembership }
  | {
      action: "skip";
      reason: "already_bound" | "no_memberships" | "ambiguous_memberships";
    };

export function decideConnectWorkspaceBind(
  input: DecideConnectWorkspaceBindInput
): ConnectWorkspaceBindDecision {
  if (input.identity.workspaceId != null) {
    return { action: "skip", reason: "already_bound" };
  }
  if (input.memberships.length === 0) {
    return { action: "skip", reason: "no_memberships" };
  }
  if (input.memberships.length > 1) {
    return { action: "skip", reason: "ambiguous_memberships" };
  }
  return { action: "bind", workspace: input.memberships[0]! };
}
