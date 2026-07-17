import { eq, and } from "drizzle-orm";
import { db } from "../db.js";
import {
  chatIdentities,
  type ChatIdentityRow,
} from "../schema/chat_identities.js";

/**
 * Chat identity queries (spec §4.2; see `schema/chat_identities.ts` for the
 * table shape and the WHY behind the design).
 *
 * `insertChatIdentity` + `getChatIdentity` are the two primitives a caller
 * composes into "resolve or create" for an inbound message (PR ②, not this
 * module): look up first, insert only on a miss. `insertChatIdentity` is
 * still race-safe on its own — two concurrent first messages from the same
 * sender can both attempt the insert; the unique constraint on
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

/** Bind a chat identity to its resolved workspace. */
export async function bindChatIdentityWorkspace(
  chatIdentityId: string,
  workspaceId: string
): Promise<void> {
  await db
    .update(chatIdentities)
    .set({ workspaceId, updatedAt: new Date() })
    .where(eq(chatIdentities.id, chatIdentityId));
}

/** Bind a chat identity to its linked user. */
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

/** Look up a chat identity by its active link token. */
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
