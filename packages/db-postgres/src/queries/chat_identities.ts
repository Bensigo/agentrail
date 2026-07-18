import { eq, and, gt, inArray } from "drizzle-orm";
import { db } from "../db.js";
import {
  chatIdentities,
  type ChatIdentityRow,
} from "../schema/chat_identities.js";
import { workspaceMemberships } from "../schema/workspace_memberships.js";
import { workspaces } from "../schema/workspaces.js";

/**
 * Chat identity queries (spec §4.2; see `schema/chat_identities.ts` for the
 * table shape and the WHY behind the design).
 *
 * `insertChatIdentity` + `getChatIdentity` are the low-level primitives.
 * `resolveInboundChatIdentity` below is the composed entry point every
 * inbound message resolves through (the shared-bot webhook door, issue
 * #1262): ensure-row on first contact, then classify bound vs "intro" (spec
 * §4.1 — an unknown identity with no resolved workspace yet; unrelated to the
 * console setup wizard's "onboarding"). `insertChatIdentity` is still
 * race-safe on its own — two concurrent first messages from the same sender
 * can both attempt the insert; the unique constraint on
 * (platform, platform_user_id) makes the loser's insert a no-op
 * (onConflictDoNothing), and the follow-up lookup fetches whichever row won.
 */

/**
 * Insert a new chat identity for (platform, platformUserId), the first time a
 * sender is seen. See the module comment above for the race-safety note.
 */
export async function insertChatIdentity(
  platform: string,
  platformUserId: string,
  displayName?: string | null
): Promise<ChatIdentityRow> {
  await db
    .insert(chatIdentities)
    .values({
      platform,
      platformUserId,
      displayName: displayName ?? null,
    })
    .onConflictDoNothing({
      target: [chatIdentities.platform, chatIdentities.platformUserId],
    });

  const row = await getChatIdentity(platform, platformUserId);
  if (!row) {
    // Unreachable in practice: the insert above either created the row or
    // lost the race to a concurrent insert that did. Fail loudly rather than
    // fabricate a row that would silently diverge from the DB.
    throw new Error(
      `insertChatIdentity: no row found for ${platform}/${platformUserId} after insert`
    );
  }
  return row;
}

/** Look up a chat identity by its (platform, platformUserId) natural key. */
export async function getChatIdentity(
  platform: string,
  platformUserId: string
): Promise<ChatIdentityRow | null> {
  const [row] = await db
    .select()
    .from(chatIdentities)
    .where(
      and(
        eq(chatIdentities.platform, platform),
        eq(chatIdentities.platformUserId, platformUserId)
      )
    )
    .limit(1);
  return row ?? null;
}

/**
 * Look up a chat identity by its own id. Added for the connect-GitHub mint
 * endpoint's session-derived resolution chain (issue #1263 PR ②):
 * `getJaceSessionByEveSessionId` (jace_sessions.ts) resolves the CALLING
 * conversation down to a `chat_identity_id`, and this is the follow-up
 * lookup for the identity row itself — the same "by id" shape as
 * `getChatIdentity`'s (platform, platformUserId) lookup, just keyed
 * differently.
 */
export async function getChatIdentityById(
  id: string
): Promise<ChatIdentityRow | null> {
  const [row] = await db
    .select()
    .from(chatIdentities)
    .where(eq(chatIdentities.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Bind a chat identity to its resolved workspace. Last-write-wins: no guard
 * against overwriting an existing binding.
 *
 * SECURITY: this setter, together with `bindChatIdentityUser` below, DEFINES
 * reachability — both feed `listWorkspacesForChatIdentity`, the
 * tenant-isolation source of truth the multi-workspace disambiguation flow
 * (`jace_sessions.ts`) trusts without re-checking. `workspaceId` must always
 * be server-derived — the verified link-token flow (issue #1263) or a
 * just-created workspace (issue #1264) — never model output or a
 * user-supplied string. Binding an attacker-chosen id here would let that
 * identity reach, and later pin conversations into, a workspace it has no
 * legitimate membership in.
 */
export async function bindChatIdentityWorkspace(
  chatIdentityId: string,
  workspaceId: string
): Promise<void> {
  await db
    .update(chatIdentities)
    .set({ workspaceId, updatedAt: new Date() })
    .where(eq(chatIdentities.id, chatIdentityId));
}

/**
 * Bind a chat identity to its linked user. Last-write-wins, same as
 * `bindChatIdentityWorkspace` above.
 *
 * SECURITY: same contract as `bindChatIdentityWorkspace` above —
 * `listWorkspacesForChatIdentity` follows this identity's `userId` to every
 * workspace that user belongs to, so `userId` must always be server-derived
 * (issue #1263 / #1264's flows), never model output or a user-supplied
 * string.
 */
export async function bindChatIdentityUser(
  chatIdentityId: string,
  userId: string
): Promise<void> {
  await db
    .update(chatIdentities)
    .set({ userId, updatedAt: new Date() })
    .where(eq(chatIdentities.id, chatIdentityId));
}

/**
 * Set (or replace) the one-time connect-GitHub link token + expiry on a chat
 * identity. Issuance policy and expiry enforcement are issue #1263 — this is
 * only the storage primitive.
 */
export async function setChatIdentityLinkToken(
  chatIdentityId: string,
  linkToken: string,
  linkTokenExpiresAt: Date
): Promise<void> {
  await db
    .update(chatIdentities)
    .set({ linkToken, linkTokenExpiresAt, updatedAt: new Date() })
    .where(eq(chatIdentities.id, chatIdentityId));
}

/**
 * Look up a chat identity by its link token. Does NOT check
 * `linkTokenExpiresAt` — this is a raw lookup only; expiry enforcement is
 * issue #1263's responsibility, applied by its caller after this returns.
 */
export async function getChatIdentityByLinkToken(
  linkToken: string
): Promise<ChatIdentityRow | null> {
  const [row] = await db
    .select()
    .from(chatIdentities)
    .where(eq(chatIdentities.linkToken, linkToken))
    .limit(1);
  return row ?? null;
}

/**
 * Atomically consume a one-time connect-GitHub link token (issue #1263): a
 * single UPDATE ... RETURNING that both matches the token AND enforces the
 * expiry (`link_token_expires_at > now`) in the SAME statement — no
 * read-then-write window where a token could be validated and then raced by
 * a second consumer before the clear lands. The UPDATE also nulls both
 * `link_token` and `link_token_expires_at`, which is what makes the token
 * single-use: a second call with the same token matches zero rows. `now` is
 * read once and reused for both the expiry guard and `updatedAt` (the same
 * one-clock-read idiom as `claimInvitesForUser`/`resolveApproval` elsewhere
 * in this package).
 *
 * Returns the row on success, or `null` when the WHERE clause matches
 * nothing — which covers an expired token, an already-consumed (reused)
 * token, and a token that never existed, ALL THREE indistinguishably by
 * design. Callers must not try to tell these apart (spec §4.2 AC3): the
 * remedy is identical either way ("ask Jace for a fresh link"), so leaking
 * which case it was would only help an attacker probe for valid-but-expired
 * tokens.
 */
export async function consumeChatIdentityLinkToken(
  linkToken: string
): Promise<ChatIdentityRow | null> {
  const now = new Date();
  const [row] = await db
    .update(chatIdentities)
    .set({ linkToken: null, linkTokenExpiresAt: null, updatedAt: now })
    .where(
      and(
        eq(chatIdentities.linkToken, linkToken),
        gt(chatIdentities.linkTokenExpiresAt, now)
      )
    )
    .returning();
  return row ?? null;
}

export interface ResolveInboundChatIdentityInput {
  platform: string;
  platformUserId: string;
  displayName?: string | null;
}

export interface ResolveInboundChatIdentityResult {
  identity: ChatIdentityRow;
  /** True iff THIS call's insert is the one that created the row (derived
   * from the insert's own `.returning()`, never guessed from timestamps). */
  created: boolean;
  /** 'bound' iff the resolved identity already has a workspace_id, else
   * 'intro' — the unknown-identity flow (spec §4.1). Describes the
   * identity's OWN binding only, not what a conversation routes to: an
   * identity with a linked user and workspace memberships but no own
   * `workspace_id` is 'intro' here yet fully routable via
   * `resolveConversationWorkspace` (jace_sessions.ts), which also checks
   * membership-derived reachability. Callers doing conversation routing must
   * call that function rather than branch on `disposition` alone. */
  disposition: "bound" | "intro";
}

/**
 * Resolve (or create) the chat identity for an inbound message — the single
 * entry point the shared-bot webhook door (issue #1262) calls before
 * anything else touches the message.
 *
 * Ensure-row on first contact: insert onConflictDoNothing on
 * (platform, platform_user_id) — the same race-safe idiom as
 * `getOrCreateJaceSession` — then fall back to a lookup only when this call's
 * insert lost the race. `displayName`, when provided and different from what
 * is already stored, is refreshed on the EXISTING-row path only: a row this
 * call just created already carries the provided name from the insert
 * itself, so refreshing it again would be a redundant write.
 */
export async function resolveInboundChatIdentity(
  input: ResolveInboundChatIdentityInput
): Promise<ResolveInboundChatIdentityResult> {
  const inserted = await db
    .insert(chatIdentities)
    .values({
      platform: input.platform,
      platformUserId: input.platformUserId,
      displayName: input.displayName ?? null,
    })
    .onConflictDoNothing({
      target: [chatIdentities.platform, chatIdentities.platformUserId],
    })
    .returning();

  const created = inserted.length > 0;
  let identity = inserted[0];

  if (!identity) {
    const existing = await getChatIdentity(
      input.platform,
      input.platformUserId
    );
    if (!existing) {
      // Unreachable in practice: the insert above either created the row or
      // lost the race to a concurrent insert that did. Fail loudly rather
      // than fabricate a row that would silently diverge from the DB.
      throw new Error(
        `resolveInboundChatIdentity: no row found for ${input.platform}/${input.platformUserId} after insert`
      );
    }
    identity = existing;
  }

  if (
    !created &&
    input.displayName != null &&
    input.displayName !== identity.displayName
  ) {
    const [updated] = await db
      .update(chatIdentities)
      .set({ displayName: input.displayName, updatedAt: new Date() })
      .where(eq(chatIdentities.id, identity.id))
      .returning();
    if (updated) {
      identity = updated;
    }
  }

  return {
    identity,
    created,
    disposition: identity.workspaceId != null ? "bound" : "intro",
  };
}

/** One workspace a chat identity can reach, as surfaced to the disambiguation flow (issue #1261 PR ③). */
export interface ReachableWorkspace {
  id: string;
  name: string;
}

/**
 * Every workspace a chat identity can reach (issue #1261 PR ③) — the union of
 * its own `workspace_id` binding and, when it's linked to a user (`user_id`
 * set), every workspace that user belongs to via `workspace_memberships`.
 * Deduped by workspace id, sorted by name so callers (the multi-workspace
 * disambiguation flow in `jace_sessions.ts`) render a stable list.
 *
 * A single LEFT JOIN from the identity to `workspace_memberships` on
 * `membership.user_id = identity.user_id` gathers both candidate sources at
 * once: the identity's own `workspace_id` rides along on every row (from
 * `chat_identities` directly), while `membership.workspace_id` is null when
 * the identity has no linked user or the user has no memberships (a LEFT
 * JOIN on a NULL `user_id` matches nothing, per SQL's `NULL = NULL` being
 * unknown rather than true — never a false-positive join). A second query
 * resolves the deduped id set to names. Returns `[]` for an unknown
 * identity id or one with neither anchor — never throws on a "reaches
 * nothing" outcome, since that is the normal shape for a brand-new sender.
 */
export async function listWorkspacesForChatIdentity(
  chatIdentityId: string
): Promise<ReachableWorkspace[]> {
  const rows = await db
    .select({
      ownWorkspaceId: chatIdentities.workspaceId,
      membershipWorkspaceId: workspaceMemberships.workspaceId,
    })
    .from(chatIdentities)
    .leftJoin(
      workspaceMemberships,
      eq(workspaceMemberships.userId, chatIdentities.userId)
    )
    .where(eq(chatIdentities.id, chatIdentityId));

  const workspaceIds = new Set<string>();
  for (const row of rows) {
    if (row.ownWorkspaceId) workspaceIds.add(row.ownWorkspaceId);
    if (row.membershipWorkspaceId) workspaceIds.add(row.membershipWorkspaceId);
  }

  if (workspaceIds.size === 0) {
    return [];
  }

  return db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(inArray(workspaces.id, Array.from(workspaceIds)))
    .orderBy(workspaces.name);
}
