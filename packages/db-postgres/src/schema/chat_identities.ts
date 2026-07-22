import { pgTable, uuid, text, timestamp, unique } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { workspaces } from "./workspaces.js";

/**
 * Chat identities — the identity spine for every inbound chat message (spec
 * §4.2). A row anchors (platform, platform_user_id) — e.g. a Telegram user
 * id — to at most one linked user and one resolved workspace; the chat
 * identity IS the provisional account. A row with no workspace_id yet is
 * exactly what routes an inbound message to the onboarding conversation (a
 * later PR), never an error. `link_token` is a one-time connect-GitHub token
 * slot — issuance, binding, and expiry are issue #1263; this table only
 * reserves the column.
 *
 * `signup_token` / `signup_token_expires_at` (issue #1364) are a SEPARATE
 * one-time token slot for the sign-up seam — a plain account-creation magic
 * link, deliberately distinct from `link_token` (GitHub-connect): the two
 * complete different things (sign-up mints a bare console account with no
 * GitHub involved; connect binds/upgrades to a GitHub-backed one) and a
 * sender may legitimately have one pending while the other has already been
 * consumed, so sharing a single column would let minting one silently
 * invalidate the other. Same shape, same single-use/expiry contract as
 * `link_token` — see `queries/chat_identities.ts`'s
 * `setChatIdentitySignupToken` / `consumeChatIdentitySignupToken` for the
 * atomic consume pattern this table only reserves storage for.
 */
export const chatIdentities = pgTable(
  "chat_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // 'telegram' | 'discord' | 'slack' | 'imessage' | 'whatsapp' today.
    platform: text("platform").notNull(),
    platformUserId: text("platform_user_id").notNull(),
    displayName: text("display_name"),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    linkToken: text("link_token"),
    linkTokenExpiresAt: timestamp("link_token_expires_at", {
      withTimezone: true,
    }),
    signupToken: text("signup_token"),
    signupTokenExpiresAt: timestamp("signup_token_expires_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    platformUserUnique: unique("chat_identities_platform_user_unique").on(
      t.platform,
      t.platformUserId
    ),
    linkTokenUnique: unique("chat_identities_link_token_unique").on(
      t.linkToken
    ),
    signupTokenUnique: unique("chat_identities_signup_token_unique").on(
      t.signupToken
    ),
  })
);

export type ChatIdentityRow = typeof chatIdentities.$inferSelect;
