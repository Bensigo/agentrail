import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  unique,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.js";
import { chatIdentities } from "./chat_identities.js";
import { queueEntries } from "./queue_entries.js";
import { briefs } from "./briefs.js";

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
 * `anchored_brief_id` is a SECOND, UNRELATED kind of anchor — do not conflate
 * it with `workspace_id`/`chat_identity_id` above. Those anchor a session to
 * a TENANT (which workspace does this conversation belong to, resolved once
 * per conversation by the door). `anchored_brief_id` anchors a session to a
 * PRODUCT IDEA (which `briefs` row is this conversation about) — the
 * conversation→brief anchor from the briefs design spec
 * (docs/superpowers/specs/2026-07-28-jace-briefs-durable-idea-understanding-design.md,
 * "Retrieval — the whole mismatch surface", step 3). It exists to spend the
 * one reliable disambiguation signal — a human confirming "continue the Blog
 * brief, or start something new?" — exactly ONCE per conversation rather than
 * re-asking every turn: grill-me shortlists candidate briefs by FTS, confirms
 * with the human before the first write, then writes the confirmed brief id
 * here so every later turn in the SAME conversation skips straight to it
 * (re-confirming only on drift — a later message scoring poorly against the
 * anchored brief). A session can be workspace-anchored with no brief anchor
 * at all (most of Jace's traffic never touches briefs, and a brief anchor is
 * meaningless without a workspace anchor already in place — a brief cannot
 * exist without one, see `briefs.workspaceId`), so this column is nullable
 * and carries no CHECK pairing it with anything else. `ON DELETE SET NULL`:
 * a deleted brief must not orphan or break the owning conversation — the
 * session row itself is still perfectly valid, it just loses its pinned idea
 * and the next relevant turn re-runs the shortlist+confirm flow (steps 1-2)
 * rather than the write ever failing or the session becoming unusable.
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
    // Conversation → brief anchor (briefs design spec, "Retrieval" step 3) —
    // a DIFFERENT kind of anchor from workspaceId/chatIdentityId above; see
    // this table's doc-comment for the full distinction. Null for the vast
    // majority of sessions (those that never touch briefs). ON DELETE SET
    // NULL: a deleted brief must not orphan or break a live session.
    anchoredBriefId: uuid("anchored_brief_id").references(() => briefs.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("active"), // active|waiting|closed
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Thread engagement (spec: docs/superpowers/specs/2026-07-28-thread-native-jace-design.md).
     *
     * NULL = Jace is engaged in this thread (or it is not a thread at all).
     * Non-null = Jace bowed out at this instant and stays quiet until someone
     * mentions it again. Only the DORMANT state is stored: "never engaged" is
     * the absence of this row, and "engaged" is this row with the latch clear,
     * so neither needs a column. Dormant is irreducible because it is set by a
     * message that produces NO turn and NO `channel_inbox` row — nothing else
     * in the system observes it.
     */
    engagementDormantSince: timestamp("engagement_dormant_since", {
      withTimezone: true,
    }),
    /**
     * The platform user id whose message last engaged this thread. A message
     * from anyone else, carrying no mention of Jace, is a speaker change and
     * bows Jace out — the structural proxy for the owner's "a thread is
     * one-on-one" rule, since "unrelated" is semantic and a per-message model
     * call was rejected.
     *
     * NOT derivable: `channel_inbox` is a work QUEUE (rows are claimed,
     * completed and pruned), so it is no durable record of who Jace last
     * answered. Never used for attribution — that stays on the turn's own
     * chat identity.
     */
    engagedSpeakerId: text("engaged_speaker_id"),
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
    // The door's engagement gate looks up by (channel, conversation_key) with
    // NO workspace in hand. `jace_sessions_conversation_unique` leads with
    // workspace_id (unusable here) and `jace_sessions_intro_conversation_idx`
    // is partial (workspace_id IS NULL), so it covers intro rows only —
    // without this index the gate seq-scans for every graduated session.
    channelConversationIdx: index("jace_sessions_channel_conversation_idx").on(
      t.channel,
      t.conversationKey
    ),
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
    // Alignment gate (#1274): set ONLY for a system-composed "alignment_brief"
    // approval (never for create_issue/create_workspace/create_repo — those
    // stay null, byte-identical to today). Lets the Telegram webhook's confirm
    // handler find the specific parked `queue_entries` row this brief was
    // gating and flip it atomically once resolveApproval's own pending->
    // resolved guard has already fired — see `github_intake.ts`'s
    // confirmAlignmentBrief/denyAlignmentBrief. ON DELETE SET NULL: a deleted
    // queue entry must never cascade-delete the approval audit trail.
    queueEntryId: uuid("queue_entry_id").references(() => queueEntries.id, {
      onDelete: "set null",
    }),
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
