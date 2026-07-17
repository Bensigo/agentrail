import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  unique,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.js";
import { chatIdentities } from "./chat_identities.js";

/**
 * Jace session map + pending approvals (spec §4).
 *
 * `jace_sessions` binds (workspace, channel, conversation) → one Eve session so
 * the same chat thread always continues the same Jace conversation, and
 * DIFFERENT threads run in parallel. Workspace binding, once set, remains the
 * tenant-isolation anchor: the worker passes it server-side to the publish
 * endpoint; it is never derived from model output (Global Constraints). A
 * session may instead anchor to chat_identity_id alone — an "intro"
 * conversation (spec §4.1) for an inbound sender with no resolved workspace
 * yet (see the naming note on `chat_identities.ts`: this is the
 * unknown-identity flow, unrelated to the console setup wizard's
 * "onboarding"). Such a row holds no tenant data and graduates in place —
 * workspace_id gets set once a workspace exists (`bindJaceSessionWorkspace`)
 * — so the dispatcher only ever has to check this one session store. The
 * table-level CHECK below guarantees a row always has at least one anchor.
 *
 * `jace_approvals` records each Eve `waiting` inputRequest we surfaced to the
 * channel as approve/deny buttons. `callback_token` is a short random token the
 * button callback carries (Telegram callback_data is limited to 64 bytes, so we
 * never inline the Eve requestId). The row doubles as the publication
 * idempotency guard: publish happens exactly once per approval because the
 * approve path flips status pending→approved atomically (UPDATE … WHERE
 * status='pending') before publishing.
 */
export const jaceSessions = pgTable(
  "jace_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    // Anchor for a session with no resolved workspace yet (spec §4.1).
    // Stays set after graduation (bindJaceSessionWorkspace only ever sets
    // workspace_id, never clears this) — see `workspaceOrIdentityCheck`
    // below for why a row always needs at least one anchor.
    chatIdentityId: uuid("chat_identity_id").references(
      () => chatIdentities.id,
      { onDelete: "cascade" }
    ),
    channel: text("channel").notNull(),
    conversationKey: text("conversation_key").notNull(),
    // Null until the first turn creates the Eve session.
    eveSessionId: text("eve_session_id"),
    status: text("status").notNull().default("active"), // active|waiting|closed
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    conversationUnique: unique("jace_sessions_conversation_unique").on(
      t.workspaceId,
      t.channel,
      t.conversationKey
    ),
    // One intro (workspace-less) session per conversation. Excludes
    // workspace_id from the key entirely (rather than relying on NULL !=
    // NULL) so a partial index is required, not a plain composite unique.
    introConversationUnique: uniqueIndex(
      "jace_sessions_intro_conversation_idx"
    )
      .on(t.channel, t.conversationKey)
      .where(sql`${t.workspaceId} IS NULL`),
    workspaceOrIdentityCheck: check(
      "jace_sessions_workspace_or_identity_check",
      sql`${t.workspaceId} IS NOT NULL OR ${t.chatIdentityId} IS NOT NULL`
    ),
  })
);

export const jaceApprovals = pgTable(
  "jace_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => jaceSessions.id, { onDelete: "cascade" }),
    eveSessionId: text("eve_session_id").notNull(),
    // Eve inputRequest id — what session.send({inputResponses}) needs.
    requestId: text("request_id").notNull(),
    // Short token carried in the channel button callback (unique, unguessable).
    callbackToken: text("callback_token").notNull(),
    toolName: text("tool_name").notNull(),
    toolInput: jsonb("tool_input").$type<Record<string, unknown>>().notNull(),
    // The Eve option ids to answer with, captured from the inputRequest.
    approveOptionId: text("approve_option_id").notNull(),
    denyOptionId: text("deny_option_id").notNull(),
    status: text("status").notNull().default("pending"), // pending|approved|denied|expired
    publishedIssueUrl: text("published_issue_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => ({
    requestUnique: unique("jace_approvals_request_unique").on(
      t.eveSessionId,
      t.requestId
    ),
    callbackTokenUnique: unique("jace_approvals_callback_token_unique").on(
      t.callbackToken
    ),
  })
);

export type JaceSessionRow = typeof jaceSessions.$inferSelect;
export type JaceApprovalRow = typeof jaceApprovals.$inferSelect;
