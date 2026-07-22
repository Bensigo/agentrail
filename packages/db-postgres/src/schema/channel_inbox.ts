import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.js";
import { chatIdentities } from "./chat_identities.js";

/**
 * Channel inbox — the async ingest buffer between channel webhooks and the
 * Jace dispatcher worker (spec §4).
 *
 * Webhook routes do exactly three things: verify the shared/per-workspace
 * secret, INSERT here, return 200. The worker claims rows with FOR UPDATE
 * SKIP LOCKED (per-conversation serialization + per-workspace fairness; see
 * queries/channel_inbox.ts). This is what makes Jace non-blocking: a slow turn
 * occupies one conversation, never the webhook handler or other users.
 *
 * A row may instead anchor on `chat_identity_id` alone — a pre-workspace row
 * from the shared-bot door (issue #1262) for a sender with no resolved
 * workspace yet (spec §4.1's "intro" flow; same anchor pattern as
 * `jace_sessions`, see that table's doc-comment for the full rationale).
 * `workspace_id` is stamped in later by the dispatcher once one resolves —
 * this table never guesses it. The CHECK below guarantees a row always has
 * at least one anchor.
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
  /**
   * Console chat (#1288) only — the gateway model id the sender picked in the
   * chat header's model dropdown (e.g. `anthropic/claude-sonnet-4.6`). The
   * console dispatcher (`lib/channel-dispatch.ts`) reads it to route the turn
   * to the Jace instance pinned to that model (a single Jace process is bound
   * to one model at boot — see `apps/console/lib/chat/models.ts`'s own note),
   * falling back to the default endpoint when unset or unmapped. Absent for
   * every other channel.
   */
  model?: string;
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
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    // Anchor for a row with no resolved workspace yet (spec §4.1) — see the
    // table doc-comment above.
    chatIdentityId: uuid("chat_identity_id").references(
      () => chatIdentities.id,
      { onDelete: "cascade" }
    ),
    // 'telegram' today; 'slack' | 'discord' | 'imessage' in follow-up plans.
    channel: text("channel").notNull(),
    // Thread identity: telegram the chat id as a string (`String(chat.id)`);
    // other channels may add their own prefix convention later.
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
    workspaceOrIdentityCheck: check(
      "channel_inbox_workspace_or_identity_check",
      sql`${t.workspaceId} IS NOT NULL OR ${t.chatIdentityId} IS NOT NULL`
    ),
  })
);

export type ChannelInboxRow = typeof channelInbox.$inferSelect;
export type NewChannelInboxRow = typeof channelInbox.$inferInsert;
