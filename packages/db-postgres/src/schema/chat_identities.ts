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
  })
);

export type ChatIdentityRow = typeof chatIdentities.$inferSelect;
