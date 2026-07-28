import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { chatIdentities } from "./chat_identities.js";

/**
 * Guardrail events — the audit trail of Jace's INPUT guardrails (spec:
 * docs/superpowers/specs/2026-07-28-jace-input-guardrails-design.md).
 *
 * One row per guardrail FINDING (not per message): a message that trips both a
 * PII detector and the injection deny-list writes two rows, so a category can
 * be counted independently of the others. A clean message writes nothing —
 * this table records what the guardrails DID, and is not a copy of the inbox.
 *
 * NO RAW MESSAGE TEXT IS EVER STORED HERE. This is the single most important
 * property of this table: the PII layer exists to get card numbers and bank
 * details OUT of the system, and persisting the very text we just redacted
 * would defeat the guardrail entirely. What is stored instead:
 *
 *   - `content_sha256` — a digest of the NORMALIZED message, so the same
 *     payload replayed across conversations is correlatable without being
 *     readable, and so an operator can confirm two reports are the same
 *     message.
 *   - `match_types` — the machine-readable subtypes only (`["card","iban"]`,
 *     a pattern id, a hazard code) plus their offsets. Enough to debug a false
 *     positive's SHAPE; never enough to reconstruct the match.
 *
 * The nullable `workspace_id` / `chat_identity_id` pair mirrors
 * `channel_inbox`'s own anchor convention (see that table's doc-comment): a
 * block on the intro path — a stranger DMing the shared bot before any
 * workspace resolves — has no workspace to attribute to, but must still be
 * attributable to the identity that sent it. Unlike `channel_inbox` there is
 * deliberately NO CHECK requiring one of them: a guardrail event is an audit
 * record and must never fail to write because attribution was unavailable.
 * Losing the audit row is strictly worse than losing the attribution.
 */

/** Which guardrail produced the row. Mirrors `GuardrailCategory` in apps/console/lib/guardrails/types.ts. */
export type GuardrailEventCategory = "pii" | "injection" | "moderation";

/** What the seam did. Mirrors `GuardrailVerdict`. `error` = the model layer failed and the turn was allowed (fail-open). */
export type GuardrailEventVerdict = "allow" | "redact" | "block" | "error";

/** How it was produced. `deterministic` = pure regex/checksum; `model` = the Llama Guard call. */
export type GuardrailEventDetector = "deterministic" | "model";

/**
 * The non-reversible detail of what matched. `type` is the subtype
 * (`"card"`, a pattern id, a hazard code); `offsets` are `[start, end)` code-unit
 * positions in the normalized text. Never the matched substring itself.
 */
export interface GuardrailMatchType {
  type: string;
  offsets: Array<[number, number]>;
}

export const guardrailEvents = pgTable(
  "guardrail_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    chatIdentityId: uuid("chat_identity_id").references(() => chatIdentities.id, {
      onDelete: "cascade",
    }),
    // 'telegram' | 'discord' | 'slack' | 'console' — the same channel
    // vocabulary `channel_inbox.channel` uses.
    channel: text("channel").notNull(),
    conversationKey: text("conversation_key").notNull(),
    category: text("category").$type<GuardrailEventCategory>().notNull(),
    verdict: text("verdict").$type<GuardrailEventVerdict>().notNull(),
    detector: text("detector").$type<GuardrailEventDetector>().notNull(),
    // Human-readable, safe to surface in an operator UI. Never quotes the match.
    reason: text("reason").notNull().default(""),
    matchTypes: jsonb("match_types")
      .$type<GuardrailMatchType[]>()
      .notNull()
      .default([]),
    // Hex SHA-256 of the normalized message. NOT the message. See above.
    contentSha256: text("content_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // The operator read: "what has this workspace tripped lately", newest first.
    workspaceCreatedIdx: index("guardrail_events_workspace_created_idx").on(
      t.workspaceId,
      t.createdAt
    ),
    // The false-positive investigation read: "show me every PII block".
    categoryVerdictIdx: index("guardrail_events_category_verdict_idx").on(
      t.category,
      t.verdict
    ),
  })
);

export type GuardrailEventRow = typeof guardrailEvents.$inferSelect;
export type NewGuardrailEventRow = typeof guardrailEvents.$inferInsert;
