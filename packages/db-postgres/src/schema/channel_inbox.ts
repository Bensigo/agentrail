import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

/**
 * Channel inbox — the async ingest buffer between channel webhooks and the
 * Jace dispatcher worker (spec §4).
 *
 * Webhook routes do exactly three things: verify the per-workspace secret,
 * INSERT here, return 200. The worker claims rows with FOR UPDATE SKIP LOCKED
 * (per-conversation serialization + per-workspace fairness; see
 * queries/channel_inbox.ts). This is what makes Jace non-blocking: a slow turn
 * occupies one conversation, never the webhook handler or other users.
 *
 * `provider_message_id` is unique per channel so provider redeliveries
 * (Telegram retries on slow ACKs) are idempotent — the second delivery hits
 * ON CONFLICT DO NOTHING and no double-processing occurs.
 */
export type ChannelInboxState =
  | "queued"
  | "processing"
  | "done"
  | "failed"
  | "dead";

export type ChannelInboxKind = "message" | "approval_response";

/** Payload for kind="message". */
export interface InboxMessagePayload {
  text: string;
}

/** Payload for kind="approval_response" (Telegram button callback). */
export interface InboxApprovalPayload {
  callbackToken: string;
  decision: "approve" | "deny";
  callbackQueryId: string;
}

export const channelInbox = pgTable(
  "channel_inbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // 'telegram' today; 'slack' | 'discord' | 'imessage' in follow-up plans.
    channel: text("channel").notNull(),
    // Thread identity: telegram `tg:<chat_id>` (+ `:<thread_id>` for topics).
    conversationKey: text("conversation_key").notNull(),
    kind: text("kind").notNull().default("message"),
    // Verified platform identity of the sender (attribution, never auth).
    senderId: text("sender_id").notNull().default(""),
    senderDisplay: text("sender_display").notNull().default(""),
    providerMessageId: text("provider_message_id").notNull(),
    payload: jsonb("payload")
      .$type<InboxMessagePayload | InboxApprovalPayload>()
      .notNull(),
    state: text("state").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    providerMessageUnique: unique("channel_inbox_provider_message_unique").on(
      t.channel,
      t.providerMessageId
    ),
  })
);

export type ChannelInboxRow = typeof channelInbox.$inferSelect;
export type NewChannelInboxRow = typeof channelInbox.$inferInsert;
