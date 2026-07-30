import { pgTable, uuid, text, timestamp, check, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { billingAccounts } from "./billing_accounts.js";
import { chatIdentities } from "./chat_identities.js";

/**
 * Seats — the first per-person gate on the chat path (spec
 * docs/superpowers/specs/2026-07-29-subscription-platform-design.md §3
 * "Platform architecture" / "New tables", and §5 "Seats and identity"). A
 * seat is one unique human attached to a billing account, never a
 * per-platform identity (§5 rule 2): the same person across three of the
 * account's workspaces holds one seat, and an unlinked Slack id + Telegram
 * id are two seats until `/connect` merges them (§5 rule 3, a later slice).
 *
 * Exactly one of `user_id` (a linked console account) / `chat_identity_id`
 * (an unlinked platform identity) is set per row — `seats_exactly_one_subject`
 * enforces it at the DB level. `user_id` intentionally carries NO
 * foreign-key reference of its own (contrast `chat_identity_id` below,
 * which cascades): §5 rule 5 requires the user-deletion path to explicitly
 * release that user's seats IN THE SAME TRANSACTION as the delete — an
 * `ON DELETE SET NULL` here would violate the CHECK the instant a
 * user-linked row's chat_identity_id is also null (both sides false trips
 * the XOR), and `ON DELETE CASCADE` would silently hard-delete the seat
 * instead of soft-releasing it (losing the audit row). Owning this
 * correctly is application code in a later slice, not a DB-level cascade.
 *
 * Seat count = active (`released_at IS NULL`) rows. There is NO mutable
 * counter anywhere — the same append-and-derive philosophy as
 * `wallet_transactions` (`packages/db-postgres/src/schema/wallet_transactions.ts:14-38`),
 * and spec §3's own words: "Seat count = active rows. No mutable counter."
 * `seats_active_user_idx` / `seats_active_identity_idx` are what make that
 * derivation race-safe under concurrent claims: at most one active seat per
 * (account, subject), while a released row survives as history and never
 * blocks a re-claim (the index only covers `released_at IS NULL` rows).
 */
export const seats = pgTable(
  "seats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    billingAccountId: uuid("billing_account_id")
      .notNull()
      .references(() => billingAccounts.id, { onDelete: "cascade" }),
    // Linked console account. Type matches users.id (uuid) — see
    // chat_identities.ts's / workspace_memberships.ts's own user_id columns
    // for the same resolution. No `.references()`: see the table
    // doc-comment above for why.
    userId: uuid("user_id"),
    chatIdentityId: uuid("chat_identity_id").references(() => chatIdentities.id, {
      onDelete: "cascade",
    }),
    // 'console' | 'telegram' | 'discord' | 'slack' — the two claim moments
    // of spec §5 rule 1 (a console invite accept, or a served chat turn),
    // named by the surface that triggered the claim.
    claimedVia: text("claimed_via").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // NULL = active. Set the instant a member is removed or an identity is
    // unbound (spec §5 rule 5) — capacity frees for the next person the
    // moment this flips, since seat count only ever counts NULL rows here.
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (t) => ({
    exactlyOneSubjectCheck: check(
      "seats_exactly_one_subject",
      sql`(${t.userId} IS NOT NULL) <> (${t.chatIdentityId} IS NOT NULL)`
    ),
    // At most one ACTIVE seat per (account, user).
    activeUserUnique: uniqueIndex("seats_active_user_idx")
      .on(t.billingAccountId, t.userId)
      .where(sql`${t.releasedAt} IS NULL AND ${t.userId} IS NOT NULL`),
    // Same guarantee for the unlinked-identity side of the CHECK above.
    activeIdentityUnique: uniqueIndex("seats_active_identity_idx")
      .on(t.billingAccountId, t.chatIdentityId)
      .where(sql`${t.releasedAt} IS NULL AND ${t.chatIdentityId} IS NOT NULL`),
  })
);

export type Seat = typeof seats.$inferSelect;
export type NewSeat = typeof seats.$inferInsert;
