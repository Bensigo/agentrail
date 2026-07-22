import {
  pgTable,
  uuid,
  text,
  serial,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

/**
 * Console chat thread storage (issue #1288; redesign spec §4 Chat) — the
 * single conversational seam a workspace member's `/chat` page reads and
 * writes. A row is either a human member's own message (`role = 'user'`,
 * written synchronously by the console's send endpoint so it renders before
 * Jace ever replies) or Jace's reply (`role = 'jace'`, written by the SAME
 * worker/dispatch path that completes every other channel's turn — see
 * `apps/jace/agent/channels/console.ts` — so console chat and the
 * Telegram/Discord/Slack channels share one reply mechanism rather than
 * forking a second one just for the dashboard).
 *
 * `conversationKey` follows the spec's `console:<userId>:<n>` convention —
 * per-member private threads scoped to one workspace, mirroring the
 * (channel, conversationKey) shape `channel_inbox` / `jace_sessions` already
 * use for every other channel (`channel` here is always the literal
 * `"console"`, so unlike those tables it is not stored as a separate column —
 * the row's existence in this table already says which channel it is).
 *
 * `seq` is a per-table monotonic counter (not scoped to the conversation) used
 * purely as the polling cursor — the UI's `after_seq` query param mirrors the
 * same incremental-poll convention `runs/[runId]/events` already uses against
 * ClickHouse; a serial column gives Postgres the same monotonic, gap-tolerant
 * ordering without relying on `created_at`, which two inserts in the same
 * millisecond could tie on.
 */
export type JaceMessageRole = "user" | "jace";

export const jaceMessages = pgTable(
  "jace_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: serial("seq").notNull(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    conversationKey: text("conversation_key").notNull(),
    // 'user' (a workspace member's own message) | 'jace' (the worker's reply).
    role: text("role").notNull().$type<JaceMessageRole>(),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // The one access pattern this table serves: "messages in this
    // conversation, in order" — both the initial load and every poll.
    workspaceConversationSeqIdx: index(
      "jace_messages_workspace_conversation_seq_idx"
    ).on(t.workspaceId, t.conversationKey, t.seq),
    roleCheck: check(
      "jace_messages_role_check",
      sql`${t.role} IN ('user', 'jace')`
    ),
  })
);

export type JaceMessageRow = typeof jaceMessages.$inferSelect;
export type NewJaceMessageRow = typeof jaceMessages.$inferInsert;
