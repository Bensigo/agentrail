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

/**
 * Pure decision helper for what `/connect/[token]` does with a freshly
 * CONSUMED link token (issue #1263 PR ① review fix). `consumeChatIdentityLinkToken`
 * already guarantees single-use + expiry; what it does not guarantee is that
 * the token is still being redeemed by the same person it was minted for.
 * The mint-side endpoint (`route.ts`) now refuses to mint for an identity
 * already linked to a user, but this helper is an independent, redemption-
 * side backstop against the same underlying threat — an identity's `userId`
 * must never be silently overwritten by anyone other than the user it
 * already belongs to — so a defect or bypass on the mint side can't alone
 * cause a hijack.
 *
 * Three outcomes, in this priority order:
 *  1. `foreign_user` — the identity is already linked to a user, and it is
 *     NOT the user signed in right now. This is the attack case: a
 *     redeemable link for someone else's identity, landed in the wrong
 *     hands (e.g. a stale-but-unexpired link, or a mint-side bug). The
 *     caller must render the SAME error state as an expired/unknown token —
 *     never a distinct message, which would confirm the identity exists and
 *     reveal it belongs to someone — and must never call
 *     `bindChatIdentityUser`. This variant deliberately carries no
 *     `workspaceDecision` field: since workspace binding is never computed
 *     for this outcome, "foreign user but somehow also workspace-bound" is
 *     unrepresentable rather than merely unlikely.
 *  2. `already_yours` — the identity is already linked to THIS signed-in
 *     user (a reload, a double redemption, or the rightful owner using the
 *     same link twice). Idempotent: skip `bindChatIdentityUser` (it would be
 *     a same-value no-op) but still run the workspace-completion rule and
 *     report success — redeeming again as the rightful owner should behave
 *     like the first time, not error.
 *  3. `fresh_bind` — the identity has no linked user yet, the common case:
 *     bind it to the signed-in user, then run the workspace-completion rule.
 *
 * `already_yours` and `fresh_bind` both carry `decideConnectWorkspaceBind`'s
 * result under `workspaceDecision` — workspace completion is orthogonal to
 * which of the two non-attack outcomes this is, so it's computed the same
 * way for both and the page just acts on it.
 */

export interface ConnectIdentityBindInput {
  identity: { userId: string | null; workspaceId: string | null };
  sessionUserId: string;
  memberships: ConnectWorkspaceMembership[];
}

export type ConnectIdentityBindDecision =
  | { kind: "foreign_user" }
  | { kind: "already_yours"; workspaceDecision: ConnectWorkspaceBindDecision }
  | { kind: "fresh_bind"; workspaceDecision: ConnectWorkspaceBindDecision };

export function decideConnectIdentityBind(
  input: ConnectIdentityBindInput
): ConnectIdentityBindDecision {
  const { identity, sessionUserId, memberships } = input;

  if (identity.userId != null && identity.userId !== sessionUserId) {
    return { kind: "foreign_user" };
  }

  const workspaceDecision = decideConnectWorkspaceBind({
    identity: { workspaceId: identity.workspaceId },
    memberships,
  });

  return identity.userId === sessionUserId
    ? { kind: "already_yours", workspaceDecision }
    : { kind: "fresh_bind", workspaceDecision };
}
