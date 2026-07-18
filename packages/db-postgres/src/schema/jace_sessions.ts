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
 * Note: `chat_identity_id`'s `ON DELETE CASCADE` means deleting a chat
 * identity cascades its jace_sessions rows too — INCLUDING already-graduated
 * ones (chat_identity_id is never cleared on graduation, so a bound session
 * still carries it); a future disconnect-identity flow must unbind or
 * archive those sessions first rather than rely on the cascade. (The cascade
 * choice itself is spec-mandated and stays.)
 *
 * `jace_approvals` records each Eve `waiting` inputRequest we surfaced to the
 * channel as approve/deny buttons. `callback_token` is a short random token the
 * button callback carries (Telegram callback_data is limited to 64 bytes, so we
 * never inline the Eve requestId). The row doubles as the publication
 * idempotency guard: publish happens exactly once per approval because the
 * approve path flips status pending→approved atomically (UPDATE … WHERE
 * status='pending') before publishing.
 *
 * `workspace_id` may be null for the SAME reason `jace_sessions.workspace_id`
 * can be (spec §4.1): the `create_workspace` tool's own approval is requested
 * from an intro (workspace-less) conversation — there is no workspace to
 * reference yet at the moment the approval is recorded. `chat_identity_id`
 * anchors such a row instead; the CHECK below mirrors `jace_sessions`'s own
 * (see that constraint's comment above for the full rationale). Unlike
 * `jace_sessions`/`channel_inbox`, this is NOT a strict either/or anchor pair:
 * `chat_identity_id` is populated whenever the owning session has one bound
 * (issue #1273), regardless of whether `workspace_id` is ALSO set, because it
 * is also what the Telegram callback's SENDER CHECK verifies against (the
 * tapper must be the conversation's own chat identity) — a graduated
 * session's approval still needs that identity on hand, not just an intro
 * one's.
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
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    // Anchor for an approval recorded from an intro (workspace-less)
    // conversation — see the table doc-comment above. Also carried for a
    // workspace-anchored approval whenever known (not exclusive with
    // workspace_id here), since it doubles as the Telegram callback's SENDER
    // CHECK target.
    chatIdentityId: uuid("chat_identity_id").references(
      () => chatIdentities.id,
      { onDelete: "cascade" }
    ),
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
    workspaceOrIdentityCheck: check(
      "jace_approvals_workspace_or_identity_check",
      sql`${t.workspaceId} IS NOT NULL OR ${t.chatIdentityId} IS NOT NULL`
    ),
  })
);

export type JaceSessionRow = typeof jaceSessions.$inferSelect;
export type JaceApprovalRow = typeof jaceApprovals.$inferSelect;
