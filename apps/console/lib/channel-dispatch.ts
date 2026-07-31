/**
 * The Jace dispatcher (issue #1262 PR ②) — drains `channel_inbox`, mapping
 * each claimed message to its Jace conversation and running the Eve turn.
 *
 * This is what makes a stranger's DM to the shared Telegram bot (ingested by
 * the webhook, PR ①) become a real Jace conversation (AC1): claim -> resolve
 * conversation -> workspace via the #1261 identity spine
 * (`resolveConversationWorkspace`) -> run the turn through Eve's cross-channel
 * `hosted-inbound` door -> record the `jace_sessions` ledger row
 * (`bindEveSession`) -> complete.
 *
 * THIN, IN-PROCESS, claim-until-empty drain — not a worker process. A single
 * webhook request kicks a drain that races every OTHER queued message to
 * completion, one row at a time. `claimNextChannelMessage` is already
 * concurrency-safe cross-process (`FOR UPDATE SKIP LOCKED` + advisory locks —
 * see packages/db-postgres/src/queries/channel_inbox.ts); the in-process
 * latch below only avoids pointless parallel drains within ONE console
 * instance. A real worker pool (apps/worker) replaces this in Wave 2 — see
 * annex-1262-recon.md's "Today's paths" section. The claim query's
 * per-workspace fairness cap does not yet special-case NULL-workspace (intro)
 * rows; that gap is noted for Wave 2, not fixed here.
 */
import { randomBytes } from "node:crypto";
import {
  db,
  reclaimStaleChannelMessages,
  claimNextChannelMessage,
  completeChannelMessage,
  failChannelMessage,
  getChatIdentity,
  resolveConversationWorkspace,
  pinConversationWorkspace,
  getOrCreateIntroJaceSession,
  getOrCreateJaceSession,
  bindEveSession,
  latestRunForIssue,
  listWorkspacesForChatIdentity,
  setChatIdentityLinkToken,
  repinConversationWorkspace,
  appendJaceMessage,
  recordGuardrailEvent,
  getThreadEngagement,
  setThreadEngagement,
  stampChannelInboxWorkspace,
  // Seat claiming (spec §5 rule 1, slice 4 Task 2) — see
  // `claimSeatForServedTurn`'s own doc-comment below for the full wiring.
  getBillingAccountIdForWorkspace,
  claimSeat,
  // Chat seat GATE (spec §6 "Enforcement seams" point 1, slice 5 Task 4) —
  // see `applySeatGateForServedTurn`'s own doc-comment below for the full
  // wiring. `getWorkspaceMembership` is the owner/admin bypass read (spec §5
  // rule 4); the other four are `packages/db-postgres/src/queries/seats.ts` /
  // `upgrade_prompts.ts`'s own admission-check + CAS-dedup primitives.
  hasActiveSeat,
  countActiveSeats,
  countActiveIdentitySeats,
  recordUpgradePromptOnce,
  getWorkspaceMembership,
  type ClaimedChannelInboxRow,
  type ReachableWorkspace,
  type ResolveConversationWorkspaceResult,
  type SeatSubject,
} from "@agentrail/db-postgres";
// Thread engagement (spec: docs/superpowers/specs/2026-07-28-thread-native-
// jace-design.md) — the ONE decision function shared by Discord and Slack.
import { decideEngagement, type ThreadInbound, type EngagementState } from "./thread-engagement";
import { sendSystemTelegramMessage, buildWorkspaceChoiceMessage, buildPinConfirmationMessage } from "./telegram-system-message";
import { sendSystemDiscordMessage, sendSystemDiscordMessagePreferFollowup } from "./discord-system-message";
import { sendSystemSlackMessage } from "./slack-system-message";
// The subscription-platform billing seam (spec
// docs/superpowers/specs/2026-07-29-subscription-platform-design.md §3/§6) —
// `applySeatGateForServedTurn` below is this dispatcher's ONE consumer of
// both.
import { resolvePolicyForWorkspace } from "./policy/resolve-policy";
import { subscriptionsEnforced } from "./policy/feature-flags";
// Jace-opens-threads Task 2: relocate a Discord channel mention into its own
// thread — the mechanics built in Task 1 (createDiscordThreadFromMessage
// never throws; deriveThreadName is pure text shaping).
import { createDiscordThreadFromMessage } from "./discord-bot";
import { deriveThreadName } from "./discord-thread-name";
import { buildRunOutcomeReplyPreface, type RunOutcomeReplyContext } from "./outcome-format";
import {
  parseConnectCommand,
  decideConnectCommand,
  type ConnectCommandAction,
  type WorkspaceRef,
} from "./connect-command";
import { renderConnectReply } from "./connect-command-copy";
// The input-guardrail seam (spec: docs/superpowers/specs/2026-07-28-jace-
// input-guardrails-design.md) — moderation, injection screening and PII
// cleansing, applied to EVERY channel at this one dispatcher.
import {
  screenInboundMessage,
  moderationGate,
  blockNotice,
  redactionNotice,
} from "./guardrails/input-guardrails";
import type { Finding, GuardrailTrust } from "./guardrails/types";

/**
 * The NON-SECRET destination key each channel's hosted-inbound `target`
 * carries — the SAME mapping `apps/jace/agent/lib/run_outcome.core.mjs`
 * (outbound) and its generalized `hosted_inbound.core.mjs` (inbound) use, so
 * this door and that one can never drift apart. Telegram `chatId`; Discord
 * and Slack `channelId` — every webhook route for those channels enqueues
 * its conversation id under the SAME internal `chatId` payload field
 * Telegram already uses (see `extractPayload` below, left byte-unchanged),
 * and this map only renames it at the LAST moment, when building the
 * outgoing hosted-inbound request.
 */
const HOSTED_INBOUND_TARGET_KEY: Record<string, "chatId" | "channelId"> = {
  telegram: "chatId",
  discord: "channelId",
  slack: "channelId",
};

/**
 * Channels whose hosted-inbound `target` must ALSO carry a stable
 * `conversationId` — the fix for #1479, where every Discord turn started a
 * BRAND-NEW Eve session and Jace lost all conversational memory between
 * messages (a human's "yes, post that review" arrived at an agent that had
 * never heard of the review).
 *
 * Verified against the installed eve@0.19.0 compiled runtime
 * (apps/jace/.output/server/_libs/eve.mjs — the same read-the-runtime-not-the-
 * .d.ts convention agent/channels/discord.ts's own header comment follows):
 *
 *   - `discordChannel().receive` derives its continuation token as
 *     `discordContinuationToken(channelId, target.conversationId ?? "")`, and
 *     sets `hasMessageAnchor = (target.conversationId !== undefined)`.
 *   - `createSendFn` tries `deliver(<token>)` first and, on
 *     `RuntimeNoActiveSessionError`, silently falls back to STARTING A NEW
 *     SESSION. So a token that stops matching does not error — it quietly
 *     resets the conversation.
 *   - With no `conversationId`, `hasMessageAnchor` is false, so the first
 *     outbound `channel.discord.post()` runs `sendViaChannel` -> `anchor(msg)`
 *     -> `session.setContinuationToken(discordContinuationToken(channelId,
 *     <the id of the message it just posted>))`. The live session RE-KEYS
 *     ITSELF to its own reply, and the next inbound turn — still keyed
 *     `"<channelId>:"` — matches nothing. Every turn is turn 0.
 *
 * Supplying a stable `conversationId` makes `hasMessageAnchor` true, which
 * turns `anchor()` into a no-op and pins the token for the life of the
 * conversation. It changes NO outbound behavior: on eve's discord handle
 * `conversationId` is used only to build that token and as a read-only field,
 * and `sendViaChannel` addresses `channelId` alone.
 *
 * Telegram is deliberately ABSENT. It has never had this bug — its `anchor()`
 * is gated by `shouldAnchorTelegramConversation()`, true only for
 * `group`/`supergroup`, so a DM's token stays `chatId::` forever. Adding a
 * `conversationId` there would CHANGE that token and orphan every in-flight
 * Telegram session exactly once, for no benefit.
 *
 * Slack is deliberately ABSENT too, and is NOT fixed by this: its receive
 * does `let l = threadTs || crypto.randomUUID()`, so with no `threadTs` every
 * receive gets a random token and Slack can never resume at all. `threadTs`
 * carries real Slack threading semantics, so it needs its own design rather
 * than a copy of this — tracked on #1479.
 */
const HOSTED_INBOUND_PINS_CONVERSATION: ReadonlySet<string> = new Set(["discord"]);

/**
 * Dispatch a system (non-model) message to the right channel's own sender —
 * additive: Telegram's `sendSystemTelegramMessage` import above and every
 * one of its call sites in `processRow`'s 'ask' branch are UNCHANGED by this
 * (#1284/#1285); this only adds the discord/slack cases alongside it (issue
 * #1364 is in flight on the same Telegram 'ask'/signup path — keeping that
 * code untouched minimizes the eventual merge conflict).
 *
 * `slackThreadTs` (final whole-branch review, finding #1): the Slack thread
 * this send belongs in, sourced by every call site below from the row's own
 * `payload.threadTs` (Slack-only — see `TelegramInboxPayload.threadTs`).
 * Forwarded ONLY to the Slack branch; Discord's and Telegram's sends stay
 * byte-unchanged, since a channel conversation is thread-scoped for Slack
 * alone (a system send with no thread id posts flat in the channel, which is
 * exactly the regression this parameter fixes — see the picker/`/connect`/
 * pin-confirmation call sites in `processRow` below).
 *
 * `slackTeamId` (Task 4): the Slack team this send is FOR, sourced by every
 * call site below from the row's own `payload.teamId` (Slack-only — see
 * `TelegramInboxPayload.teamId`). Forwarded ONLY to the Slack branch —
 * `sendSystemSlackMessage` is now team-scoped (it resolves that team's own
 * installation and token; there is no more shared `SLACK_BOT_TOKEN` to fall
 * back to) — so Discord's and Telegram's sends stay byte-unchanged.
 */
async function sendSystemChannelMessage(
  channel: string,
  targetId: string,
  text: string,
  messageThreadId?: string,
  slackThreadTs?: string,
  slackTeamId?: string
) {
  if (channel === "discord") return sendSystemDiscordMessage(targetId, text);
  if (channel === "slack") return sendSystemSlackMessage(slackTeamId, targetId, text, slackThreadTs);
  return sendSystemTelegramMessage(targetId, text, messageThreadId);
}

const EVE_HOST = process.env["EVE_HOST"] || "http://127.0.0.1:2000";

/**
 * The jace hosted-inbound door route (`apps/jace/agent/channels/hosted-inbound.ts`
 * -> `/eve/v1/hosted-inbound`). Overridable for tests / non-default
 * topologies, mirroring `notify.ts`'s `JACE_RUN_OUTCOME_URL` convention.
 */
const HOSTED_INBOUND_URL =
  process.env["JACE_HOSTED_INBOUND_URL"] || `${EVE_HOST}/eve/v1/hosted-inbound`;

// An Eve dispatch-acknowledge should be fast: hosted-inbound.ts's
// args.receive() resolves at DISPATCH time (session created), not at turn
// completion — see that file's header comment. 60s is generous headroom for
// that, not a turn-completion budget. Bounding it matters because a HUNG
// (never-settling) fetch would otherwise wedge the module-level
// `inflightDrain` latch below forever — process-wide dispatch death until
// restart. Mirrors the fetch-with-timeout pattern already used by
// app/api/v1/workspaces/[workspaceId]/connectors/secret/telegram.ts.
const EVE_TURN_TIMEOUT_MS = 60_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EVE_TURN_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface DispatchResult {
  processed: number;
  failed: number;
}

/** The message-kind inbox payload this dispatcher understands (telegram, v1 = DM-first). */
interface TelegramInboxPayload {
  chatId: number | string;
  text: string;
  /**
   * Telegram-only: the raw `chat.type` Telegram sends
   * (`private|group|supergroup|channel` — see the webhook route's own
   * `TelegramChat` doc-comment), written byte-unchanged under this same key
   * by the webhook door (`telegram/webhook/route.ts`). Read by
   * `conversationKind` below; Slack/Discord/console derive their own
   * group-vs-DM fact from a different proxy (see that function's own
   * doc-comment) and never carry this key.
   */
  chatType?: string;
  messageThreadId?: number | string;
  /** #1277 — set by the webhook route when this message replies to a
   * parseable run-outcome notification. See `withReplyContextPreface`. */
  replyContext?: RunOutcomeReplyContext;
  /**
   * Prod bug fix (private-channel Discord replies vanish — see
   * .superpowers/sdd/discord-followup/): set by the Discord webhook route
   * (connectors/discord/webhook/route.ts) from the inbound interaction's own
   * `token`/`application_id` fields. Discord-only; telegram/slack payloads
   * never carry these. Both travel together — see `buildDoorInitiatorAuth`,
   * which treats one without the other as no credential at all.
   */
  interactionToken?: string;
  applicationId?: string;
  /**
   * Slack-only (#1479's Slack half): the thread this conversation lives in.
   * Set by the Slack door from `resolveSlackThread`. eve's Slack continuation
   * token IS `channelId:threadTs` — with none, `slackChannel().receive` falls
   * back to `crypto.randomUUID()` and every turn starts a new session. A
   * telegram/discord payload never carries this.
   */
  threadTs?: string;
  /**
   * Slack-only (Task 4, docs/superpowers/specs/2026-07-29-slack-multi-
   * workspace-design.md §4): the Slack `team_id` this row's installation was
   * resolved against, written by the Slack door (`connectors/slack/events/
   * route.ts`) from its own already-verified `getSlackInstallation` lookup —
   * never re-derived here. This is the ONE value that lets a reply later
   * choose the right customer's bot token: carried into `auth.attributes`
   * below (`buildDoorInitiatorAuth`) and forwarded to `sendSystemChannelMessage`
   * for every in-dispatcher system send, so both the Eve turn's reply (via
   * jace's new console reply route) and a system send (/connect, workspace
   * picker, pin confirmation, guardrail notice) resolve the SAME team's
   * token, never a default, never another team's. A telegram/discord payload
   * never carries this key.
   */
  teamId?: string;
  /**
   * The thread-engagement envelope (spec: docs/superpowers/specs/2026-07-28-
   * thread-native-jace-design.md), read by `buildThreadInbound` below to run
   * `decideEngagement`. `threadId` is Discord-only — `discord-inbound.ts`
   * writes it on EVERY discord row (never conditionally omitted), `string`
   * inside a known thread, `null` outside one. Slack carries the equivalent
   * fact as `threadTs` above instead (no separate `threadId` key — see
   * `buildThreadInbound`'s own doc-comment for why one key does double duty
   * there). `mentionsBot`/`mentionsOtherUsers`/`repliesToBot` are read
   * tolerantly (only an actual `boolean` is kept) so a row from BEFORE this
   * feature existed, or a Slack row enqueued with `SLACK_BOT_USER_ID` unset
   * (see `connectors/slack/events/route.ts`'s own header doc), degrades to
   * `undefined` here rather than a cast or a crash — `buildThreadInbound`
   * then supplies the conservative default (`false`/`null`).
   */
  threadId?: string | null;
  mentionsBot?: boolean;
  mentionsOtherUsers?: boolean;
  repliesToMessageId?: string | null;
  repliesToBot?: boolean;
  /**
   * The real Discord message id this row's turn arrived as (Jace-opens-
   * threads Task 2) — the source message the "relocate a channel mention
   * into its own thread" feature below needs for
   * `createDiscordThreadFromMessage`. Discord-only, and only present for the
   * Gateway-listener door: `discord-inbound.ts`'s `DiscordInboundMessage.messageId`
   * doc-comment explains why the `/jace` slash-command webhook door never
   * sets it (a slash-command interaction has no backing channel message) —
   * that absence is exactly what excludes that door from relocation, rather
   * than any thread/DM check. Also legitimately absent on any row enqueued
   * before this field existed; the relocation gate below treats a missing
   * `messageId` as "do not relocate", never as a reason to fail the row.
   */
  messageId?: string;
}

/**
 * TOLERANT extraction for the #1277 `replyContext` field — malformed shapes
 * (wrong `kind`, non-integer/non-positive `issueNumber`) resolve to
 * `undefined` rather than failing the whole row, same tolerance
 * `messageThreadId` already gets below. This is internal, already-parsed
 * data (the webhook route only ever writes a well-formed value via
 * `parseOutcomeIssueNumber`), so this is belt-and-suspenders, not an
 * attacker-input boundary.
 */
function extractReplyContext(value: unknown): RunOutcomeReplyContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  if (r["kind"] !== "run_outcome") return undefined;
  const issueNumber = r["issueNumber"];
  if (
    typeof issueNumber !== "number" ||
    !Number.isSafeInteger(issueNumber) ||
    issueNumber <= 0
  ) {
    return undefined;
  }
  return { kind: "run_outcome", issueNumber };
}

/**
 * Extract + validate the fields this dispatcher needs from a claimed row's
 * loosely-typed `payload` (jsonb, `Record<string, unknown>` at the query
 * layer). Returns `null` on any malformed shape so the caller can fail the
 * row rather than crash the loop — this is internal, already-enqueued data
 * (PR ①'s webhook route builds it), so a malformed shape here means a
 * wiring bug, not attacker input.
 */
function extractPayload(payload: unknown): TelegramInboxPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const chatId = p["chatId"];
  const text = p["text"];
  if (
    (typeof chatId !== "number" && typeof chatId !== "string") ||
    typeof text !== "string"
  ) {
    return null;
  }
  const messageThreadId = p["messageThreadId"];
  const result: TelegramInboxPayload = { chatId, text };
  if (typeof messageThreadId === "number" || typeof messageThreadId === "string") {
    result.messageThreadId = messageThreadId;
  }
  // Telegram's chat.type passthrough — see TelegramInboxPayload's own
  // doc-comment on `chatType`. Read tolerantly, same posture as every other
  // optional field here: a row enqueued before this field existed just comes
  // back `undefined`, never a cast or a crash.
  if (typeof p["chatType"] === "string") {
    result.chatType = p["chatType"];
  }
  const replyContext = extractReplyContext(p["replyContext"]);
  if (replyContext) result.replyContext = replyContext;
  // Prod bug fix — discord-only, tolerantly extracted the same way as
  // messageThreadId above; a telegram/slack payload simply never has these
  // keys, so `extractPayload`'s behavior for those channels is unchanged.
  const interactionToken = p["interactionToken"];
  if (typeof interactionToken === "string" && interactionToken.trim()) {
    result.interactionToken = interactionToken;
  }
  const applicationId = p["applicationId"];
  if (typeof applicationId === "string" && applicationId.trim()) {
    result.applicationId = applicationId;
  }
  // Discord-only (see TelegramInboxPayload.messageId's doc-comment) — same
  // tolerant, omit-if-malformed extraction as interactionToken/applicationId
  // above.
  const messageId = p["messageId"];
  if (typeof messageId === "string" && messageId.trim()) {
    result.messageId = messageId;
  }
  const threadTs = p["threadTs"];
  if (typeof threadTs === "string" && threadTs.trim()) {
    result.threadTs = threadTs;
  }
  // Slack-only (Task 4) — same tolerant, omit-if-malformed extraction as
  // threadTs above. See TelegramInboxPayload.teamId's own doc-comment.
  const teamId = p["teamId"];
  if (typeof teamId === "string" && teamId.trim()) {
    result.teamId = teamId;
  }
  // The thread-engagement envelope — see TelegramInboxPayload's doc-comment
  // on these fields. `threadId`/`repliesToMessageId` are `string | null`
  // (both a real value and an explicit `null` are meaningful and kept; only
  // a missing/malformed key resolves to `undefined`, never a cast).
  const threadId = p["threadId"];
  if (threadId === null || typeof threadId === "string") {
    result.threadId = threadId;
  }
  if (typeof p["mentionsBot"] === "boolean") {
    result.mentionsBot = p["mentionsBot"];
  }
  if (typeof p["mentionsOtherUsers"] === "boolean") {
    result.mentionsOtherUsers = p["mentionsOtherUsers"];
  }
  const repliesToMessageId = p["repliesToMessageId"];
  if (repliesToMessageId === null || typeof repliesToMessageId === "string") {
    result.repliesToMessageId = repliesToMessageId;
  }
  if (typeof p["repliesToBot"] === "boolean") {
    result.repliesToBot = p["repliesToBot"];
  }
  return result;
}

/**
 * Build the pure `ThreadInbound` envelope `decideEngagement` needs, from a
 * claimed row's already-extracted payload. Discord/Slack ONLY — see this
 * file's `processRow` call site for the channel guard.
 *
 * `isDM`: NEITHER door writes an explicit `isDM` key into
 * `channel_inbox.payload` (see `discord-inbound.ts`'s and
 * `connectors/slack/events/route.ts`'s own header comments) — each carries a
 * different STRUCTURAL PROXY instead, and this function reads the exact same
 * proxy each door's own admission gate already relies on:
 *
 *   - Discord: `threadId === null`. Per `discord-inbound.ts`'s own header
 *     doc, "the interactions webhook always sets `mentionsBot: true` ... and
 *     the Gateway listener's `screenMessage` only ever forwards a non-thread
 *     message here when it is a DM or a mention" — so a `threadId === null`
 *     row that does NOT mention the bot must be a DM. A `threadId === null`
 *     row that DOES mention the bot short-circuits `decideEngagement`'s own
 *     `mentionsBot` check FIRST (see thread-engagement.ts), which returns
 *     the IDENTICAL `nextState` either way (`{ dormantSince: null,
 *     engagedSpeakerId: inbound.senderId }`) — so mislabeling `isDM` there
 *     is harmless; only the (unobserved) `reason` string would differ.
 *   - Slack: `threadTs === undefined`. `resolveSlackThread` (lib/slack-
 *     thread.ts) roots every non-DM message — even an un-threaded top-level
 *     one — at its own `ts`, so `threadTs` is present on every enqueued
 *     Slack row EXCEPT a genuine DM (`resolveSlackThread`'s `isDirectMessage`
 *     branch never sets it). Slack's `repliesToMessageId`/`repliesToBot` are
 *     hardcoded rather than read from `payload`, per the design spec: "Slack
 *     has no in-channel reply primitive — a Slack reply IS a thread."
 */
function buildThreadInbound(
  channel: "discord" | "slack",
  payload: TelegramInboxPayload,
  senderId: string
): ThreadInbound {
  if (channel === "slack") {
    return {
      channel,
      isDM: payload.threadTs === undefined,
      threadId: payload.threadTs ?? null,
      senderId,
      mentionsBot: payload.mentionsBot ?? false,
      mentionsOtherUsers: payload.mentionsOtherUsers ?? false,
      repliesToMessageId: null,
      repliesToBot: false,
    };
  }
  return {
    channel,
    isDM: payload.threadId === undefined || payload.threadId === null,
    threadId: payload.threadId ?? null,
    senderId,
    mentionsBot: payload.mentionsBot ?? false,
    mentionsOtherUsers: payload.mentionsOtherUsers ?? false,
    repliesToMessageId: payload.repliesToMessageId ?? null,
    repliesToBot: payload.repliesToBot ?? false,
  };
}

/**
 * Hoists group-vs-DM to a first-class fact at this dispatch seam (spec §9
 * slice 0) — a later slice's per-person seat gate needs to know whether a
 * conversation is a group or a DM, and today that fact is buried inside
 * each channel's own admission-gate proxy, re-derived ad hoc wherever it's
 * needed. Pure, no I/O.
 *
 * Telegram: `payload.chatType` is the raw `chat.type` Telegram sends
 * (`private|group|supergroup|channel`, see `TelegramInboxPayload`'s own
 * doc-comment) — `group`/`supergroup`/`channel` -> "group", `private` or a
 * missing/unrecognized value -> "dm" (conservative default, same posture as
 * this file's other tolerant-extraction fields).
 *
 * Slack/Discord: mirrors `buildThreadInbound`'s existing `isDM` VERBATIM
 * (see that function's own doc-comment for the structural-proxy rationale
 * behind each check) rather than inventing a second rule that could drift
 * from the one `decideEngagement` already runs on.
 *
 * Console: always "dm" — see `ConsoleInboxPayload`'s own doc-comment (no
 * chatId; the row's own resolved workspaceId + conversationKey IS the
 * destination, and there is no group concept on this channel). Any other/
 * future channel value also falls to "dm" — the same conservative default
 * as an unrecognized Telegram chatType.
 */
export function conversationKind(
  channel: string,
  payload: TelegramInboxPayload
): "dm" | "group" {
  if (channel === "telegram") {
    switch (payload.chatType) {
      case "group":
      case "supergroup":
      case "channel":
        return "group";
      default:
        return "dm";
    }
  }
  if (channel === "slack") {
    return payload.threadTs === undefined ? "dm" : "group";
  }
  if (channel === "discord") {
    return payload.threadId === undefined || payload.threadId === null ? "dm" : "group";
  }
  return "dm";
}

/** The three chat channels this dispatcher's seat-claim hook recognizes —
 * `row.channel`/`payload`'s own type is a plain DB `string`, not a literal
 * union (see `ClaimedChannelInboxRow`), so `decideSeatClaimForServedTurn`
 * below narrows through this type guard rather than an unchecked cast.
 * `processRow` never reaches this helper for "console" (its own early
 * return dispatches those to `processConsoleRow` instead — see that
 * function's own doc-comment), so in practice this is always true by the
 * time it's called; the guard exists for defensiveness against a future/
 * unexpected `channel` value, not a case this dispatcher expects to hit. */
function isChatSeatClaimChannel(channel: string): channel is "telegram" | "discord" | "slack" {
  return channel === "telegram" || channel === "discord" || channel === "slack";
}

/**
 * Seat-claim decision for a served CHAT turn (spec §5 rule 1: "a seat is
 * claimed automatically the first time a person … is served a chat turn in
 * a conversation pinned to one of the account's workspaces. Messages Jace
 * was never going to answer … claim nothing" —
 * `docs/superpowers/specs/2026-07-29-subscription-platform-design.md`).
 * Pure, no I/O, so it's unit-testable without the dispatch harness
 * (`channel-dispatch-seat-claim.test.ts`) — see `claimSeatForServedTurn`
 * below for the impure, DB-backed continuation (resolving the billing
 * account id and the actual `claimSeat` write).
 *
 * `processRow`'s ONE call site passes this `workspaceId` and `channel`
 * straight from its own already-resolved locals, taken AFTER the
 * thread-engagement gate has already decided this row IS a real turn (a
 * message the gate filters completes-and-returns before ever reaching this
 * point — see that block's own doc-comment) — so every call into this
 * function is, by construction, already past the "was this even going to
 * be answered" question. This function only decides the remaining two
 * questions: is there a workspace to attribute the seat to yet, and who is
 * the subject.
 *
 * Returns `null` (skip, no claim) when:
 * - `workspaceId` is `null` — the 'intro' path, a stranger whose
 *   conversation isn't pinned to any workspace yet. Spec §5 rule 1 requires
 *   a conversation "pinned to one of the account's workspaces"; an intro
 *   turn has no account to attribute a seat to, full stop, regardless of
 *   whether Jace replies to it.
 * - `channel` isn't one of the three recognized chat channels
 *   (`isChatSeatClaimChannel` above) — defensive only, see that guard's own
 *   doc-comment.
 *
 * Subject selection matches `SeatSubject`'s own exactly-one-of contract
 * (`packages/db-postgres/src/queries/seats.ts`): a chat identity already
 * linked to a console account (`identity.userId` set) claims the USER seat
 * directly, so the same person DMing Jace on a platform they've `/connect`ed
 * claims the identical seat a console session would rather than a redundant
 * identity-seat; an unlinked identity claims by `chatIdentityId` instead,
 * and `/connect` is what later collapses that into a user-seat
 * (`collapseIdentitySeatsForUser`, same module).
 */
export function decideSeatClaimForServedTurn(params: {
  workspaceId: string | null;
  channel: string;
  identity: { userId: string | null; chatIdentityId: string };
}): { workspaceId: string; subject: SeatSubject; claimedVia: "telegram" | "discord" | "slack" } | null {
  if (!params.workspaceId) return null;
  if (!isChatSeatClaimChannel(params.channel)) return null;

  const subject: SeatSubject = params.identity.userId
    ? { userId: params.identity.userId }
    : { chatIdentityId: params.identity.chatIdentityId };

  return { workspaceId: params.workspaceId, subject, claimedVia: params.channel };
}

/**
 * Fire-and-forget seat claim for a served turn (spec §5 rule 1) — the
 * impure, DB-backed continuation of `decideSeatClaimForServedTurn` above.
 * SHARED by both call sites: `processRow` (chat channels, gated through
 * that decision helper) and `processConsoleRow` (console, whose subject is
 * always `{userId: row.senderId}` with no skip condition to decide — a
 * console row's `workspaceId` is already guaranteed non-null by the checks
 * above that call site, and there is no engagement gate on that path to
 * filter anything out — see `processConsoleRow`'s own doc-comment).
 *
 * Claiming is UNCONDITIONAL data collection (slice 4 plan: "pre-populating
 * the seat ledger before enforcement … grandfathers existing teams") — NO
 * feature-flag read anywhere in this function or either caller. Enforcement
 * (caps, upgrade prompts) is a later slice's job, reading the rows this
 * writes; gating the WRITE itself behind a flag would leave that later
 * enforcement flipping on to an empty ledger and immediately over-blocking
 * every existing team's already-active people.
 *
 * NEVER awaited by either call site (both call this bare, no `await`/`void`
 * needed AT the call site — see below for why) — a slow or failing claim
 * must never delay or fail the turn it rides in on. This function itself
 * swallows its entire promise chain via the trailing `.catch`, so nothing
 * about it can become an unhandled rejection either; `void` is applied
 * HERE, once, rather than duplicated at every call site.
 *
 * Resolves `billingAccountId` via `getBillingAccountIdForWorkspace` and
 * skips SILENTLY when it's `null` — a "transitional" workspace (no
 * backfill/checkout has bound it to a billing account yet; same null
 * contract `getBillingAccountForWorkspace`'s own doc-comment describes) has
 * nothing to attribute a seat to. That is an expected, ordinary state
 * during rollout, not an error worth logging — only a genuine failure
 * (thrown by either query) reaches the `.catch` below, logged with a
 * namespaced prefix so it's greppable without being confused for a turn
 * failure.
 */
function claimSeatForServedTurn(params: {
  workspaceId: string;
  subject: SeatSubject;
  claimedVia: "console" | "telegram" | "discord" | "slack";
}): void {
  void (async () => {
    const billingAccountId = await getBillingAccountIdForWorkspace(db, params.workspaceId);
    if (!billingAccountId) return;
    await claimSeat(db, {
      billingAccountId,
      subject: params.subject,
      claimedVia: params.claimedVia,
    });
  })().catch((err) => {
    console.error(
      `[channel-dispatch] claimSeatForServedTurn failed (workspace=${params.workspaceId}, channel=${params.claimedVia}):`,
      err instanceof Error ? err.message : String(err)
    );
  });
}

/**
 * Chat SEAT GATE (spec §6 "Enforcement seams" point 1, slice 5 Task 4): once
 * a billing account is at its plan's seat cap, a brand-new person's chat
 * turn gets an upgrade prompt instead of service. An EXISTING seat-holder
 * (the claim `claimSeatForServedTurn` above already covers, spec §5 rule 1)
 * and a workspace owner/admin (spec §5 rule 4) are never blocked by this.
 *
 * Pure truth-table, no I/O: `"gate"` ONLY when every one of these holds
 * SIMULTANEOUSLY — `enforced` (the arc kill-switch), NOT `degraded` (billing
 * data must be trustworthy to enforce against — same hard contract
 * `resolvePolicyForWorkspace`'s own doc-comment states), a real
 * `billingAccountId`, the subject does NOT already hold a seat, the subject
 * is NOT a workspace owner/admin, and the account is already at-or-over its
 * `seatLimit`. Every other combination is `"pass"` — there is no third,
 * "ambiguous" outcome.
 *
 * `activeSeatCount >= seatLimit`, not `>`: the count fed in here is always
 * taken BEFORE any claim for the CURRENT turn, so "already at the limit"
 * already means "no room left for one more" — the boundary itself blocks,
 * it does not wait for the account to go one seat over first.
 *
 * Known semantics (documented here, not enforced by this function, since
 * neither is this function's job): accepted invites claim UNCONDITIONALLY
 * (slice 4's `claimSeatForServedTurn`/console invite-accept path) — a
 * pending invite accepted while the account is already at cap can push
 * `activeSeatCount` over `seatLimit`. Those members hold real seats and are
 * never re-blocked here (`subjectHasSeat` short-circuits them to `"pass"`
 * regardless of the count); an over-cap account resolves by removing a
 * member or upgrading the plan, never by locking out someone who already has
 * a seat. Separately: this function has no lock, so two brand-new people
 * racing for the last open seat can both independently observe
 * `activeSeatCount < seatLimit` and both `"pass"` this gate (a plain
 * count-then-claim read, not a compare-and-swap) — an accepted fail-open
 * bias, same spirit as the CAS below only deduping the PROMPT, never the
 * admission decision itself.
 */
export function decideSeatGate(params: {
  enforced: boolean;
  degraded: boolean;
  billingAccountId: string | null;
  seatLimit: number;
  subjectHasSeat: boolean;
  activeSeatCount: number;
  isWorkspaceAdmin: boolean;
}): "pass" | "gate" {
  const shouldGate =
    params.enforced &&
    !params.degraded &&
    params.billingAccountId !== null &&
    !params.subjectHasSeat &&
    !params.isWorkspaceAdmin &&
    params.activeSeatCount >= params.seatLimit;
  return shouldGate ? "gate" : "pass";
}

/**
 * The seat-limit upgrade-prompt copy (spec §6) — byte-exact, never
 * paraphrased at a call site. Customer-facing copy never mentions dollars, a
 * model name, or the word "budget" (spec §6's own copy rule): this prompt is
 * entirely about SEATS, so neither would even come up naturally, but the
 * rule is worth restating here since a future edit to this string is the one
 * place that could accidentally violate it.
 *
 * The `/connect` hint is appended ONLY when the account holds at least one
 * active IDENTITY-keyed seat (`hasUnlinkedIdentitySeats`, sourced from
 * `countActiveIdentitySeats` — spec §5 rule 3): telling someone to `/connect`
 * is only useful when there is a real chance the blocked person already has
 * an unlinked identity-seat sitting in THIS SAME account that `/connect`
 * would collapse into a user-seat, freeing capacity
 * (`collapseIdentitySeatsForUser`, `queries/seats.ts`). An account with only
 * user-seats never shows this second sentence — there is nothing for
 * `/connect` to free there.
 */
export function buildSeatLimitPrompt(hasUnlinkedIdentitySeats: boolean): string {
  const base =
    "You've reached your team's seat limit. Upgrade your plan or remove an inactive member.";
  if (!hasUnlinkedIdentitySeats) return base;
  return `${base} Already have a seat? Use /connect to link your account.`;
}

/** Owner/admin bypass (spec §5 rule 4) — the house per-file pattern (see
 * e.g. `app/api/v1/workspaces/[workspaceId]/api-keys/[keyId]/route.ts`'s own
 * `ADMIN_ROLES`), duplicated here rather than imported: every existing
 * instance of this constant lives in the API-route tree, and this
 * dispatcher has no reason to reach into it for one shared literal. */
const ADMIN_ROLES = ["owner", "admin"] as const;

/**
 * UTC `YYYY-MM-DD` — the seat-limit prompt's daily cooldown key
 * (`schema/upgrade_prompt_events.ts`'s own `periodKey` doc-comment:
 * `'seat_limit'` is one of the two daily-cooldown kinds). `toISOString()` is
 * always UTC regardless of the host's local timezone, matching
 * `digest-panel-helpers.ts`'s own `shiftWeek` idiom for the identical
 * "date-only, UTC" shape. Takes `now` as a parameter (rather than calling
 * `new Date()` internally) purely so a future caller/test can pin the clock;
 * every current call site passes a freshly-constructed `Date`.
 */
function utcDayPeriodKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Seat-gate prompt delivery for a chat-channel row — `processRow`'s own
 * `deliver` callback into {@link applySeatGateForServedTurn}. Discord prefers
 * the interaction-followup webhook (Task 3, `sendSystemDiscordMessagePreferFollowup`)
 * over the shared bot post, reading `interactionToken`/`applicationId`
 * straight off the row's already-parsed `payload` — this MUST be read before
 * `completeChannelMessage` scrubs both keys from the STORED row
 * (`packages/db-postgres/src/queries/channel_inbox.ts`'s own
 * `completeChannelMessage` doc-comment); calling this from inside
 * `applySeatGateForServedTurn`, which the caller always `await`s BEFORE its
 * own `completeChannelMessage`, is what guarantees that ordering here. Pinned
 * by a `mock.invocationCallOrder` assertion in `channel-dispatch.test.ts`'s
 * discord seat-gate wiring test (review round 1, order-hardening finding) —
 * today the ordering is incidental (this reads the row's already-parsed,
 * in-memory `payload`, which `completeChannelMessage`'s scrub can't touch
 * either way), and only becomes load-bearing if a FUTURE refactor ever
 * re-reads this row's payload from the DB after completing it — that pinned
 * test is what would catch a reorder that silently reintroduces the
 * dependency. Telegram/slack reuse the existing `sendSystemChannelMessage`
 * seam, with the EXACT SAME argument derivation as the guardrail-block
 * notice elsewhere in `processRow` (`channel-dispatch.ts`'s guardrail
 * `!guard.allowed` branch) — copied verbatim rather than factored out, so
 * the two call sites can never silently drift apart from a partial edit to
 * one.
 */
function deliverSeatLimitPromptForChatRow(
  channel: string,
  payload: TelegramInboxPayload,
  text: string
): Promise<unknown> {
  if (channel === "discord") {
    return sendSystemDiscordMessagePreferFollowup({
      channelId: String(payload.chatId),
      text,
      interactionToken: payload.interactionToken,
      applicationId: payload.applicationId,
    });
  }
  return sendSystemChannelMessage(
    channel,
    String(payload.chatId),
    text,
    payload.messageThreadId !== undefined ? String(payload.messageThreadId) : undefined,
    payload.threadTs,
    payload.teamId
  );
}

/**
 * Impure, DB-backed orchestration behind {@link decideSeatGate} (spec §6
 * point 1) — SHARED by both call sites (`processRow` for telegram/discord/
 * slack, `processConsoleRow` for console), the same sharing shape
 * {@link claimSeatForServedTurn} above uses. Unlike that function, this one
 * is AWAITED and gates the turn: a `"gated"` result means the caller must
 * NOT proceed to the seat claim, guardrails, or Eve — only
 * `completeChannelMessage` + return `"completed"`.
 *
 * 1. The arc kill-switch, `subscriptionsEnforced()`, is read FIRST — before
 *    any billing read at all — so flag-off is byte-identical to this
 *    function never having been called (spec §6: a single kill-switch gates
 *    all four enforcement seams; every existing caller's behavior must be
 *    unchanged while it's off).
 * 2. Everything after that lives inside ONE try/catch: §6's fail-open rule
 *    applies to the seat gate exactly as it does inside
 *    `resolvePolicyForWorkspace` itself — a thrown error anywhere below must
 *    never turn into a blocked customer, only a loud, namespaced
 *    `console.error` and a served turn.
 * 3. `resolvePolicyForWorkspace` is the ONE billing read — called with a
 *    zeroed `fetchMonthSpendUsd` dep (review round 1, hot-path cost finding;
 *    see that call site's own doc-comment for the full why). `degraded` or a
 *    `null` `billingAccountId` skips the gate outright (the same "not safe
 *    to enforce against" contract that function's own doc-comment states) —
 *    neither `hasActiveSeat` nor `countActiveSeats` is even callable with a
 *    `null` account id, so this is a hard requirement, not just caution.
 * 4. `hasActiveSeat` runs BEFORE `countActiveSeats`/`getWorkspaceMembership`,
 *    and short-circuits them entirely when it resolves `true`: an existing
 *    seat-holder is the common case on every turn after a conversation's
 *    first, and `decideSeatGate`'s own truth table makes the other two
 *    inputs moot once `subjectHasSeat` is `true` — so skipping those two
 *    extra round-trips costs nothing but latency on the hot path.
 * 5. On `"gate"`: `recordUpgradePromptOnce` is the CAS. Only the caller that
 *    wins it (`won === true`) builds and delivers the prompt. A lost CAS
 *    (another concurrent turn in the same conversation already prompted
 *    today) still returns `"gated"`, just silently — and so does a WON CAS
 *    whose `countActiveIdentitySeats` or `deliver` call then throws (review
 *    rounds 1 and 2, delivery-throw / identity-seat-count-failure findings):
 *    the CAS row is already committed by the time either runs, so the
 *    decision is final, and each has its OWN narrow inner try/catch (below)
 *    that stops its throw from reaching the outer catch and flipping an
 *    already-decided `"gate"` back into `"pass"`. A count failure defaults
 *    `hasUnlinkedIdentitySeats` to `false` (drop the /connect hint rather
 *    than guess) and still attempts delivery. Either way, the gate ALWAYS
 *    blocks once decided; only whether a prompt was shown, and whether it
 *    carried the hint, varies.
 */
async function applySeatGateForServedTurn(params: {
  workspaceId: string;
  channel: string;
  conversationKey: string;
  identity: { userId: string | null; chatIdentityId: string | null };
  deliver: (text: string) => Promise<unknown>;
}): Promise<"pass" | "gated"> {
  if (!subscriptionsEnforced()) return "pass";

  try {
    // Skip the real economics hydration (ClickHouse `aggregateWorkspaceCosts`,
    // one call per account workspace, `resolve-policy.ts`'s own
    // `defaultFetchMonthSpendUsd`) — this gate reads only
    // `billingAccountId`/`degraded`/`policy.seatLimit` off the resolved
    // policy, never `economics`, so paying for a real spend aggregation on
    // EVERY served turn (while the flag is on) is pure waste — and since the
    // dispatch drain loop is single-threaded/serial, a ClickHouse slowdown
    // would queue every chat turn in the process behind it (review round 1,
    // hot-path cost finding). `fetchMonthSpendUsd: async () => 0` still runs
    // the SAME resolver: the real account fetch, the real plan/override
    // merge, the real workspace-id fan-out — `degraded` only flips `true` on
    // a genuine throw from one of those, so this stub doesn't change when
    // the gate fails open. It only short-circuits the one sub-step this
    // caller never reads. Any FUTURE consumer of the `ResolvedPolicy`
    // returned HERE that starts reading `policy.economics` MUST remove this
    // stub first — as written, `currentSpendUsd`/`remainingBudgetUsd` on
    // this particular result are always a lie (0 spent / full budget).
    const resolved = await resolvePolicyForWorkspace(params.workspaceId, {
      fetchMonthSpendUsd: async () => 0,
    });
    if (resolved.degraded || resolved.billingAccountId === null) {
      return "pass";
    }
    const billingAccountId = resolved.billingAccountId;

    if (!params.identity.userId && !params.identity.chatIdentityId) {
      // Defensive only — unreachable from this function's two real call
      // sites (processRow always supplies a real chatIdentityId;
      // processConsoleRow always supplies a real userId). There is no
      // subject to check or gate against otherwise.
      return "pass";
    }
    const subject: SeatSubject = params.identity.userId
      ? { userId: params.identity.userId }
      : { chatIdentityId: params.identity.chatIdentityId as string };

    const subjectHasSeat = await hasActiveSeat(db, { billingAccountId, subject });

    let activeSeatCount = 0;
    let isWorkspaceAdmin = false;
    if (!subjectHasSeat) {
      activeSeatCount = await countActiveSeats(db, billingAccountId);
      if (params.identity.userId) {
        const membership = await getWorkspaceMembership(params.identity.userId, params.workspaceId);
        isWorkspaceAdmin =
          membership !== null &&
          ADMIN_ROLES.includes(membership.role as (typeof ADMIN_ROLES)[number]);
      }
    }

    const verdict = decideSeatGate({
      enforced: true,
      degraded: resolved.degraded,
      billingAccountId,
      seatLimit: resolved.policy.seatLimit,
      subjectHasSeat,
      activeSeatCount,
      isWorkspaceAdmin,
    });

    if (verdict === "pass") return "pass";

    const won = await recordUpgradePromptOnce(db, {
      billingAccountId,
      kind: "seat_limit",
      conversationKey: params.conversationKey,
      channel: params.channel,
      periodKey: utcDayPeriodKey(new Date()),
    });

    if (won) {
      // Two DELIBERATELY NARROW inner try/catches follow, both narrower than
      // the outer one above — and both exist for the same reason (review
      // rounds 1 and 2): by this point `recordUpgradePromptOnce` has already
      // WON the CAS, the row is committed in Postgres, so the decision to
      // gate this turn is final. The outer catch's fail-open contract exists
      // for BILLING READS, where serving a paying customer beats blocking on
      // a Postgres/ClickHouse hiccup — it was never meant to cover a failure
      // AFTER a good-data decision has already been made and recorded.
      // Letting either of the two calls below throw past this point would
      // flip an already-decided `"gate"` back to `"pass"`: the person gets
      // served, a seat gets claimed over cap, and the CAS slot stays burned
      // for the rest of the period with no prompt ever having been shown —
      // exactly the bug each of these two catches closes for its own call.

      // Narrow catch #1 (review round 2, identity-seat-count-failure
      // finding): defaults `hasUnlinkedIdentitySeats` to `false` (omit the
      // /connect hint rather than guess at it) and falls through to STILL
      // attempt delivery — a failed count is a reason to drop one sentence
      // of copy, never a reason to skip showing the prompt at all.
      let hasUnlinkedIdentitySeats = false;
      try {
        hasUnlinkedIdentitySeats = (await countActiveIdentitySeats(db, billingAccountId)) > 0;
      } catch (countErr) {
        console.error(
          `[seat-gate] countActiveIdentitySeats failed (workspace=${params.workspaceId}, channel=${params.channel}), defaulting to no /connect hint:`,
          countErr instanceof Error ? countErr.message : String(countErr)
        );
      }

      // Narrow catch #2 (review round 1, delivery-throw finding): `deliver`
      // is realistically throwable — the console path's `appendJaceMessage`
      // is a bare `db.insert` with no internal catch. Catching here keeps
      // the turn blocked regardless of outcome, exactly like a lost CAS —
      // silently, but still blocked.
      try {
        await params.deliver(buildSeatLimitPrompt(hasUnlinkedIdentitySeats));
      } catch (deliverErr) {
        console.error(
          `[seat-gate] prompt delivery failed (workspace=${params.workspaceId}, channel=${params.channel}):`,
          deliverErr instanceof Error ? deliverErr.message : String(deliverErr)
        );
      }
    }

    return "gated";
  } catch (err) {
    console.error(
      `[seat-gate] applySeatGateForServedTurn failed (workspace=${params.workspaceId}, channel=${params.channel}):`,
      err instanceof Error ? err.message : String(err)
    );
    return "pass";
  }
}

/**
 * Log a structured line on each engagement TRANSITION only — `entered
 * dormant` and `reactivated` — never per skipped message (spec: "a dormant
 * thread can absorb many messages and must not spam the logs"). A thread
 * that stays dormant, stays engaged, or was never engaged at all produces no
 * log line here; the timestamp column itself already records when a
 * transition happened, so this is observability, not an audit trail.
 */
function logEngagementTransition(params: {
  channel: string;
  conversationKey: string;
  previous: EngagementState | null;
  next: EngagementState;
  reason: string;
}): void {
  const wasDormant = params.previous?.dormantSince != null;
  const isDormant = params.next.dormantSince != null;
  if (!wasDormant && isDormant) {
    console.log(
      `[channel-dispatch] engagement: entered dormant (${params.channel}/${params.conversationKey}) — ${params.reason}`
    );
  } else if (wasDormant && !isDormant) {
    console.log(
      `[channel-dispatch] engagement: reactivated (${params.channel}/${params.conversationKey}) — ${params.reason}`
    );
  }
}

/** The console (#1288) inbox payload: just the member's text — no chatId,
 * since the destination is the row's OWN `workspaceId` + `conversationKey`
 * (already resolved at enqueue time by the authenticated send endpoint, not
 * derived from any identity spine). */
interface ConsoleInboxPayload {
  text: string;
}

function extractConsolePayload(payload: unknown): ConsoleInboxPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const text = p["text"];
  if (typeof text !== "string" || !text.trim()) return null;
  return { text };
}

/**
 * Parse an 'ask' conversation's reply as a workspace choice: an exact
 * case-insensitive workspace-name match, or (only if no name matches) an
 * integer 1..N (1-indexed against `options`). Returns `null` for anything
 * else (the "invalid reply" path, which re-sends the same options).
 *
 * Name match MUST run before the numeric-index check: a workspace can
 * legitimately be named "2", and it may not sit at position 2 — checking
 * the index first would silently mis-pin whatever happens to occupy that
 * position instead of the workspace the reply actually names.
 */
function parseWorkspaceChoice(
  text: string,
  options: readonly ReachableWorkspace[]
): ReachableWorkspace | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const byName = options.find((option) => option.name.toLowerCase() === lower);
  if (byName) return byName;
  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed) - 1;
    return options[index] ?? null;
  }
  return null;
}

/**
 * The initiator identity carried into `session.auth.initiator` — the ONLY
 * way Jace's tools/subagents can later attribute a session back to the
 * originating chat identity / workspace (see annex-eve-internals.md's
 * `auth.initiator` section). Mirrors `notify.ts`'s `jaceInitiatorAuth` shape
 * and voice; deliberately a separate small helper (not imported from
 * notify.ts, which is the OUTBOUND run-outcome path — unrelated lifecycle).
 *
 * `principalId` is the workspace when one is resolved, else the chat
 * identity (an intro conversation has no workspace yet). `workspaceId` is
 * `null`, not omitted, in `attributes` for an intro turn — the console side
 * of this contract is a plain JSON object, not eve's `SessionAuthContext`
 * type, so this is not constrained by that interface's `string`-only
 * attribute values (only the jace-side receiver would be, and it forwards
 * `auth` through unchanged without re-typing it — see hosted-inbound.ts).
 *
 * Prod bug fix (private-channel Discord replies vanish — root-caused
 * 2026-07-25, see .superpowers/sdd/discord-followup/; corrected 2026-07-26
 * per a follow-up adversarial review, same doc dir, fix-1-brief.md finding
 * 1): `interactionToken`/`applicationId`, when both present, ride in
 * `attributes` alongside the chat-identity fields above — deliberately NOT
 * in `target` (the channel's documented NON-SECRET destination key; see this
 * file's HOSTED_INBOUND_TARGET_KEY doc-comment, and note discord's proactive
 * target shape eve exposes for `receive()` is `{ channelId }` only, with no
 * room for either field — verified against eve@0.19.0's own
 * discordChannel.d.ts, so putting them in `target` would silently drop
 * them). `auth` is the field eve forwards UNCHANGED into BOTH
 * `session.auth.current` (refreshed on every subsequent turn — eve's REAL
 * compiled runtime, apps/jace/.output/server/_libs/eve.mjs, sets this from
 * each `deliver`-turn's own `auth`) AND `session.auth.initiator` (set ONCE,
 * at session start, never touched again). Jace's discord channel event
 * handler reads `current` first (falling back to `initiator` only for turn
 * 1, where eve seeds both identically) via
 * `resolveSessionAuthAttributes(ctx.session.auth)` to build the interaction
 * followup webhook URL — see apps/jace/agent/lib/discord-followup.core.mjs
 * and apps/jace/agent/channels/discord.ts. This function's OWN job is
 * unaffected by that distinction: it always sends the CURRENT turn's fresh
 * `interactionToken`/`applicationId` as `auth`, for eve to route into
 * whichever of `current`/`initiator` its runtime updates — reading the right
 * one back out is entirely the discord channel handler's concern. A partial
 * pair (only one of the two present) is treated as no credential at all — a
 * followup URL needs both, mirroring `discord-followup.core.mjs`'s own
 * `extractFollowupCredentials`. Telegram/Slack calls never pass these
 * params, so `attributes` for those channels stays byte-identical to before
 * this fix.
 *
 * `teamId` (Task 4, docs/superpowers/specs/2026-07-29-slack-multi-workspace-
 * design.md §4): Slack-only, the SAME `attributes` seam carries the team id
 * a Slack reply needs to choose the right installation's bot token. This is
 * the ONLY place a Slack turn's team id enters `auth` — never inferred from
 * `channel`/`conversationKey`, never read from ambient state — so eve
 * forwarding `auth` unchanged into `session.auth.current`/`.initiator` is
 * what lets `apps/jace/agent/channels/slack.ts`'s `message.completed` read it
 * back out (mirroring `resolveSessionAuthAttributes`'s current-then-initiator
 * preference) and pass it, explicit and unmodified, to the console's new
 * Slack-reply route. Included whenever present, independent of
 * interactionToken/applicationId's paired requirement above — a telegram/
 * discord/console call never passes it, so `attributes` for those channels
 * stays byte-identical.
 */
function buildDoorInitiatorAuth(params: {
  chatIdentityId: string;
  workspaceId: string | null;
  channel: string;
  conversationKey: string;
  interactionToken?: string;
  applicationId?: string;
  teamId?: string;
}): Record<string, unknown> {
  const attributes: Record<string, unknown> = {
    chatIdentityId: params.chatIdentityId,
    workspaceId: params.workspaceId,
    channel: params.channel,
    conversationKey: params.conversationKey,
  };
  if (params.interactionToken && params.applicationId) {
    attributes["interactionToken"] = params.interactionToken;
    attributes["applicationId"] = params.applicationId;
  }
  if (params.teamId) {
    attributes["teamId"] = params.teamId;
  }
  return {
    authenticator: "agentrail",
    principalType: "service",
    principalId: params.workspaceId ?? params.chatIdentityId,
    attributes,
  };
}

/**
 * The initiator identity for a console (#1288) turn — a workspace member
 * already authenticated in the dashboard, never a chat identity (that spine
 * exists to resolve STRANGERS to a workspace; a console sender IS a
 * workspace member by construction — the send endpoint already checked
 * membership before this row was ever enqueued). `principalType: "user"`
 * (not `"service"`, unlike `buildDoorInitiatorAuth`'s chat-identity-anchored
 * channels) distinguishes a real authenticated human from every other
 * channel's platform-verified-but-unauthenticated sender.
 */
function buildConsoleInitiatorAuth(params: {
  workspaceId: string;
  userId: string;
  conversationKey: string;
}): Record<string, unknown> {
  return {
    authenticator: "agentrail",
    principalType: "user",
    principalId: params.userId,
    attributes: {
      workspaceId: params.workspaceId,
      channel: "console",
      conversationKey: params.conversationKey,
    },
  };
}

type EveTurnOutcome =
  | { ok: true; sessionId: string; continuationToken: string }
  | { ok: false; reason: string };

/**
 * POST one turn to Jace's hosted-inbound door and resolve to a discriminated
 * result — never throws; a network failure and a non-200 both resolve to
 * `ok: false` so the caller can `failChannelMessage` either the same way.
 */
async function runEveTurn(params: {
  message: string;
  /** Which hosted-inbound channel module receives this turn (#1284/#1285 —
   * default "telegram" so every pre-existing call site, which never set
   * this, is byte-unchanged). */
  channel?: string;
  chatId?: number | string;
  messageThreadId?: number | string;
  /** Slack-only — see TelegramInboxPayload.threadTs. Ignored for every other
   * channel, so their targets stay byte-unchanged. */
  threadTs?: string;
  /**
   * Console (#1288): a pre-built target object, used AS-IS instead of the
   * chatId/channelId-keyed shape every external channel builds below.
   * Console's destination is a COMPOUND key (`workspaceId` +
   * `conversationKey`, not a single platform id — see
   * `hosted_inbound.core.mjs`'s console branch), so it doesn't fit
   * `HOSTED_INBOUND_TARGET_KEY`'s one-key-per-channel convention. When set,
   * `chatId` is ignored entirely.
   */
  target?: Record<string, unknown>;
  /**
   * The row's own `conversationKey` — the STABLE per-conversation id this
   * door is already keyed on. Used only to pin `target.conversationId` for
   * the channels in `HOSTED_INBOUND_PINS_CONVERSATION` (#1479); every other
   * channel's target is byte-unchanged whether this is passed or not.
   *
   * It must be the conversation's id, never anything per-message: a
   * per-message value would re-key the session on every turn, which is the
   * exact bug being fixed.
   */
  conversationKey?: string;
  auth: Record<string, unknown>;
}): Promise<EveTurnOutcome> {
  const channel = params.channel ?? "telegram";
  // The wire-level target key is channel-specific (Telegram `chatId`;
  // Discord/Slack `channelId` — see HOSTED_INBOUND_TARGET_KEY above); the
  // VALUE is always `params.chatId` regardless of channel, since every
  // webhook route (telegram/discord/slack) enqueues its conversation id
  // under that same internal payload field. Console (#1288) supplies its own
  // compound `target` instead — see the param doc above.
  const targetKey = HOSTED_INBOUND_TARGET_KEY[channel] ?? "chatId";
  // #1479: pin `conversationId` for the channels that need it, from the row's
  // own stable conversationKey (falling back to the destination id, which for
  // discord IS the channelId this conversation is keyed on). Never per-message
  // — see HOSTED_INBOUND_PINS_CONVERSATION. `normalizeHostedInbound` forwards
  // `target.conversationId` through untouched, so nothing changes Jace-side.
  const pinnedConversationId = HOSTED_INBOUND_PINS_CONVERSATION.has(channel)
    ? params.conversationKey ?? (params.chatId !== undefined ? String(params.chatId) : undefined)
    : undefined;
  const target =
    params.target ??
    {
      [targetKey]: params.chatId,
      ...(pinnedConversationId !== undefined && pinnedConversationId !== ""
        ? { conversationId: pinnedConversationId }
        : {}),
      ...(params.messageThreadId !== undefined
        ? { messageThreadId: params.messageThreadId }
        : {}),
      ...(channel === "slack" && params.threadTs !== undefined
        ? { threadTs: params.threadTs }
        : {}),
    };
  let response: Response;
  try {
    response = await fetchWithTimeout(HOSTED_INBOUND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: params.message,
        channel,
        target,
        auth: params.auth,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      reason: `hosted-inbound unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!response.ok) {
    return { ok: false, reason: `hosted-inbound returned ${response.status}` };
  }

  const body = (await response.json().catch(() => null)) as
    | { sessionId?: unknown; continuationToken?: unknown }
    | null;
  if (!body || typeof body.sessionId !== "string") {
    return { ok: false, reason: "hosted-inbound response missing sessionId" };
  }
  return {
    ok: true,
    sessionId: body.sessionId,
    continuationToken: typeof body.continuationToken === "string" ? body.continuationToken : "",
  };
}

/**
 * #1277 (replyable run-outcome threads) — when the inbound payload carries a
 * run-outcome `replyContext` (the webhook parsed it out of a Telegram
 * reply's quoted text), resolve the latest run for that issue
 * WORKSPACE-SCOPED to the conversation's OWN server-resolved `workspaceId`
 * — never anything read out of the payload/quoted text itself, see
 * route.ts's `resolveReplyContext` threat-model note — and prepend a
 * server-built bracketed preface to the message Jace receives.
 *
 * No workspace yet (an 'intro' conversation — `workspaceId` null) or no
 * `replyContext` at all: the message is returned UNTOUCHED, byte-identical
 * to before this feature existed. (An 'intro' conversation replying to a
 * run-outcome ping is not a real scenario in practice — a ping is only ever
 * sent to an already-connected/bound conversation — but the guard is here
 * regardless: there is no workspace to scope a lookup to.)
 */
async function withReplyContextPreface(
  workspaceId: string | null,
  payload: TelegramInboxPayload
): Promise<string> {
  if (!workspaceId || !payload.replyContext) return payload.text;
  const found = await latestRunForIssue(workspaceId, payload.replyContext.issueNumber);
  const preface = buildRunOutcomeReplyPreface(payload.replyContext.issueNumber, found);
  return `${preface}\n${payload.text}`;
}

/**
 * THE INPUT-GUARDRAIL SEAM (spec: docs/superpowers/specs/2026-07-28-jace-
 * input-guardrails-design.md).
 *
 * Every channel — telegram, discord, slack, console — converges on this
 * dispatcher, so screening here covers all four with ONE seam rather than
 * four webhook-side copies. It runs BEFORE `runEveTurn`, so a blocked message
 * costs zero model tokens, and it runs against an already-durable
 * `channel_inbox` row, so the audit trail survives a crash mid-screen.
 *
 * Returns what the caller needs to proceed and nothing else: whether the turn
 * may run, the (possibly PII-cleansed) text it should run on, and an optional
 * user-facing notice. It performs NO channel I/O itself — the caller sends the
 * notice through its own channel's sender, because console (`appendJaceMessage`)
 * and the chat channels (`sendSystemChannelMessage`) have different seams.
 *
 * NEVER THROWS. `recordGuardrailEvent` swallows its own write failures, and
 * the moderation layer fails open by contract, so a guardrail problem can
 * never fail an inbox row or kill the drain loop.
 */
async function applyInputGuardrails(params: {
  text: string;
  trust: GuardrailTrust;
  channel: string;
  conversationKey: string;
  workspaceId: string | null;
  chatIdentityId: string | null;
}): Promise<{ allowed: boolean; text: string; notice: string | null }> {
  const { text, trust, channel, conversationKey, workspaceId, chatIdentityId } = params;

  const screened = screenInboundMessage(text, { trust });

  // One audit row per FINDING, so a category can be counted independently.
  // `normalizedText` is hashed by the query helper and never stored.
  const audit = (
    finding: Finding,
    verdict: "allow" | "redact" | "block" | "error"
  ) =>
    recordGuardrailEvent({
      workspaceId,
      chatIdentityId,
      channel,
      conversationKey,
      category: finding.category,
      verdict,
      detector: finding.detector,
      reason: finding.reason,
      matchTypes: [{ type: finding.type, offsets: finding.offsets }],
      normalizedText: screened.text,
    });

  for (const finding of screened.findings) {
    // A PII finding is always a redact; an injection finding is a block only
    // for a stranger — for a bound member it is recorded as `allow`, which is
    // exactly the "warn" tier (see injection.ts's trust tiers).
    const verdict =
      finding.category === "pii"
        ? "redact"
        : screened.verdict === "block"
          ? "block"
          : "allow";
    await audit(finding, verdict);
  }

  if (screened.verdict === "block") {
    return { allowed: false, text: screened.text, notice: blockNotice(screened.findings) };
  }

  // Layer 3 runs LAST and only on a message the free layers allowed, so a
  // message already rejected for injection never costs a moderation call.
  const moderation = await moderationGate(screened.text);

  if (moderation.finding) {
    // A finding is recorded whether or not it blocks: a non-blocking hazard
    // (S14, see MODERATION_NON_BLOCKING_HAZARDS) still belongs in the audit
    // trail so its rate stays visible.
    await audit(moderation.finding, moderation.blocked ? "block" : "allow");
    if (moderation.blocked) {
      return {
        allowed: false,
        text: screened.text,
        notice: blockNotice([moderation.finding]),
      };
    }
  }

  if (moderation.errorReason) {
    // Fail-open: the turn still runs. Recorded so a silent outage is visible.
    await recordGuardrailEvent({
      workspaceId,
      chatIdentityId,
      channel,
      conversationKey,
      category: "moderation",
      verdict: "error",
      detector: "model",
      reason: moderation.errorReason,
      normalizedText: screened.text,
    });
  }

  return {
    allowed: true,
    text: screened.text,
    notice: screened.verdict === "redact" ? redactionNotice(screened.findings) : null,
  };
}

/**
 * Process one claimed CONSOLE (#1288) row end to end — the authenticated
 * dashboard chat path, deliberately NOT routed through `processRow`'s
 * identity-spine machinery below ('ask'/'intro'/'single'/'pinned'): a
 * console row's `workspaceId` is already resolved and stamped at enqueue
 * time by the send endpoint (session + membership already checked there),
 * so there is no stranger identity to resolve here — only a session ledger
 * entry to keep continuity across turns, exactly like every other channel.
 *
 * Same "never throws" contract as `processRow`: every failure mode resolves
 * to `"failed"` via `failChannelMessage` so the drain loop always moves on.
 */
async function processConsoleRow(row: ClaimedChannelInboxRow): Promise<"completed" | "failed"> {
  try {
    if (row.kind !== "message") {
      await failChannelMessage(
        row.id,
        `channel-dispatch: unsupported inbox kind '${row.kind}' for console`
      );
      return "failed";
    }

    const payload = extractConsolePayload(row.payload);
    if (!payload) {
      await failChannelMessage(row.id, "channel-dispatch: malformed console payload (missing text)");
      return "failed";
    }

    // Invariant this dispatcher assumes but does not enforce: a console row
    // always carries a real workspace_id (channel_inbox's CHECK constraint
    // only requires workspace_id OR chat_identity_id, but the console send
    // endpoint never enqueues without one — there is no "intro" state for an
    // already-authenticated workspace member).
    if (!row.workspaceId) {
      await failChannelMessage(row.id, "channel-dispatch: console row missing workspaceId");
      return "failed";
    }

    const session = await getOrCreateJaceSession(row.workspaceId, "console", row.conversationKey);

    const auth = buildConsoleInitiatorAuth({
      workspaceId: row.workspaceId,
      userId: row.senderId,
      conversationKey: row.conversationKey,
    });

    // row.workspaceId is guaranteed non-null past the check above; aliased
    // to a plain const here so the narrowed type survives inside the
    // `deliver` closure below — TypeScript discards a property's control-flow
    // narrowing across a nested function boundary, but never for a `const`
    // local (see applySeatGateForServedTurn's own call in processRow, which
    // needs no such alias because its `deliver` closure never touches
    // `workspaceId` at all).
    const workspaceId = row.workspaceId;

    // --- seat gate (spec §6 "Enforcement seams" point 1, slice 5 Task 4): a
    // gated member must not reach the seat claim below. Console has no
    // engagement gate and no group/DM concept (see this function's own
    // doc-comment) — every row that reaches this line is, by construction, a
    // served turn from an authenticated workspace member — so unlike
    // processRow there is no workspaceId-null skip to apply here either
    // (row.workspaceId was already checked non-null above). Prompt delivery
    // rides the same appendJaceMessage seam the guardrail notice just below
    // uses (this function has no out-of-band sender — see this function's
    // own doc-comment on that).
    const seatGateResult = await applySeatGateForServedTurn({
      workspaceId,
      channel: row.channel,
      conversationKey: row.conversationKey,
      identity: { userId: row.senderId, chatIdentityId: null },
      deliver: (text) =>
        appendJaceMessage({ workspaceId, conversationKey: row.conversationKey, role: "jace", text }),
    });
    if (seatGateResult === "gated") {
      await completeChannelMessage(row.id);
      return "completed";
    }

    // --- seat claim (spec §5 rule 1, slice 4 Task 2): a console row is
    // ALWAYS a served turn once the checks above pass — an authenticated
    // workspace member sending a message, with no engagement gate on this
    // path to filter anything out (see this function's own doc-comment) —
    // so, unlike processRow, there is no skip decision to make here.
    // row.senderId IS the console user id directly (no separate chat-
    // identity lookup on this path). Fire-and-forget, shared wrapper — see
    // claimSeatForServedTurn's own doc-comment for the no-await/no-flag
    // contract.
    claimSeatForServedTurn({
      workspaceId: row.workspaceId,
      subject: { userId: row.senderId },
      claimedVia: "console",
    });

    // --- input guardrails, same seam as every other channel ---
    // Trust is always 'bound' here: a console row is an authenticated
    // workspace member (session + membership are checked by the send endpoint
    // before it ever enqueues), so there is no stranger tier on this path.
    const guard = await applyInputGuardrails({
      text: payload.text,
      trust: "bound",
      channel: "console",
      conversationKey: row.conversationKey,
      workspaceId: row.workspaceId,
      chatIdentityId: null,
    });

    // Console has no out-of-band sender — a notice IS a chat message, written
    // as an assistant turn exactly the way `runner/chat-reply` writes Jace's
    // own replies, so the client's existing `after_seq` poll renders it with
    // no new plumbing.
    if (guard.notice) {
      await appendJaceMessage({
        workspaceId: row.workspaceId,
        conversationKey: row.conversationKey,
        role: "jace",
        text: guard.notice,
      });
    }

    if (!guard.allowed) {
      // COMPLETE, not fail — requeuing would replay the block at the user.
      await completeChannelMessage(row.id);
      return "completed";
    }

    const turn = await runEveTurn({
      message: guard.text,
      channel: "console",
      auth,
      target: { workspaceId: row.workspaceId, conversationKey: row.conversationKey },
    });

    if (!turn.ok) {
      await failChannelMessage(row.id, `channel-dispatch: ${turn.reason}`);
      return "failed";
    }

    await bindEveSession(session.id, turn.sessionId);
    await completeChannelMessage(row.id);
    return "completed";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await failChannelMessage(row.id, message);
    } catch (failErr) {
      console.error("[channel-dispatch] failChannelMessage itself failed (console row):", failErr);
    }
    return "failed";
  }
}

const LINK_TOKEN_BYTES = 24;
const LINK_TOKEN_TTL_MS = 30 * 60 * 1000;

/**
 * Resolve CONSOLE_PUBLIC_URL exactly ONCE per row, trimmed with any trailing
 * slash(es) stripped. `deploy/.env.production.example` marks this REQUIRED
 * with an empty placeholder (`CONSOLE_PUBLIC_URL=`) — an operator who copies
 * that file to `deploy/.env` without filling it in gets an EMPTY STRING via
 * docker-compose's `env_file` loading, not merely unset. It can ALSO be
 * genuinely unset (deploy/.env predates this var, or the var is dropped from
 * the environment some other way) — `??` alone (nullish-only) would not
 * catch the empty-string case, which is why this also folds in `""` via
 * `?? ""` before the trim; both call sites below (the `ensureConnectLink`
 * link-building path and the `no_workspaces` copy) must treat "unset" and
 * "empty" identically, which is why they both read this ONE resolved value
 * rather than each reading `process.env` independently.
 *
 * Warns when the resolved value is empty, since this failure mode is
 * otherwise perfectly silent: every `/connect` from an unlinked chat gets the
 * same generic failure copy forever, with nothing in the logs pointing at
 * the cause. Never logs the link token (there isn't one to log here — the
 * token doesn't exist yet at this point).
 */
function resolveConsolePublicUrl(): string {
  const resolved = (process.env["CONSOLE_PUBLIC_URL"] ?? "").trim().replace(/\/+$/, "");
  if (!resolved) {
    console.warn(
      "[channel-dispatch] CONSOLE_PUBLIC_URL is unset/empty — /connect cannot mint " +
        "connect links; every unlinked chat will get a generic failure reply until " +
        "this is set (see deploy/.env.production.example)."
    );
  }
  return resolved;
}

/**
 * Return a usable connect URL for this identity, re-sending an existing
 * unexpired token rather than minting a new one. Re-minting is last-write-wins
 * (`setChatIdentityLinkToken`), so a fresh mint would silently kill a link the
 * user is about to tap; re-sending is idempotent and self-rate-limits repeated
 * /connect. Returns undefined when `base` (the caller's already-resolved
 * CONSOLE_PUBLIC_URL, see `resolveConsolePublicUrl`) is empty or the write
 * fails — the caller renders honest failure copy rather than a broken link.
 */
async function ensureConnectLink(
  identity: { linkToken: string | null; linkTokenExpiresAt: Date | null },
  chatIdentityId: string,
  base: string
): Promise<string | undefined> {
  if (!base) return undefined;

  const live =
    identity.linkToken &&
    identity.linkTokenExpiresAt &&
    identity.linkTokenExpiresAt.getTime() > Date.now();
  if (live) return `${base}/connect/${identity.linkToken}`;

  try {
    const token = randomBytes(LINK_TOKEN_BYTES).toString("hex");
    await setChatIdentityLinkToken(
      chatIdentityId,
      token,
      new Date(Date.now() + LINK_TOKEN_TTL_MS)
    );
    return `${base}/connect/${token}`;
  } catch (err) {
    // Never log `token` — this is the ONLY thing that can turn into a live
    // connect link. Log the identity + underlying error so an operator can
    // tell "mint failed" (this) apart from "CONSOLE_PUBLIC_URL unset" (the
    // warn in resolveConsolePublicUrl) — both render the same in-channel
    // copy, but need different fixes (DB health vs. env config).
    console.error(
      `[channel-dispatch] setChatIdentityLinkToken failed for chatIdentityId=${chatIdentityId}:`,
      err instanceof Error ? err.message : String(err)
    );
    return undefined;
  }
}

/**
 * After a pin/re-pin that did not land, report the state that ACTUALLY
 * exists rather than the one we intended. Re-resolves exactly once — never
 * retries in a loop — matching pinConversationWorkspace's own race contract:
 * a caller must treat its result as "this call's write landed", never as
 * "this workspace is now the exclusive answer".
 */
async function reportActualPin(
  chatIdentityId: string,
  row: { channel: string; conversationKey: string },
  reachable: WorkspaceRef[]
): Promise<ConnectCommandAction> {
  const now = await resolveConversationWorkspace({
    chatIdentityId,
    channel: row.channel,
    conversationKey: row.conversationKey,
  });
  const nowId = now.kind === "pinned" ? now.workspaceId : null;
  if (!nowId) return { kind: "repin_refused" };
  return {
    kind: "already_pinned",
    // null when we cannot reach it — never echo an unreachable workspace.
    workspace: reachable.find((w) => w.id === nowId) ?? null,
    alternatives: reachable.filter((w) => w.id !== nowId),
  };
}

/**
 * Process exactly one claimed row end to end. NEVER throws: every failure
 * mode — malformed payload, no identity, sidecar down, an unexpected
 * exception anywhere in the chain — resolves to `"failed"` via
 * `failChannelMessage`, so the drain loop can always move on to the next
 * row ("never kill the loop").
 */
async function processRow(row: ClaimedChannelInboxRow): Promise<"completed" | "failed"> {
  // Console (#1288) rows skip the identity-spine machinery entirely — see
  // processConsoleRow's own doc-comment for why.
  if (row.channel === "console") {
    return processConsoleRow(row);
  }

  try {
    if (row.kind !== "message") {
      // Approvals ride the Eve-native callback_query path today (out of
      // scope for this PR — see the brief's "Out of scope" section); a
      // non-message kind here would be a future kind this dispatcher does
      // not yet understand, not a crash.
      await failChannelMessage(
        row.id,
        `channel-dispatch: unsupported inbox kind '${row.kind}' (not handled by this dispatcher yet)`
      );
      return "failed";
    }

    const payload = extractPayload(row.payload);
    if (!payload) {
      await failChannelMessage(row.id, "channel-dispatch: malformed payload (missing chatId/text)");
      return "failed";
    }

    // INVARIANT this dispatcher assumes but does not enforce: channel_inbox's
    // (channel, senderId) here MUST equal the (platform, platformUserId) a
    // chat_identities row was created under. The Telegram webhook (route.ts)
    // guarantees it today (same String(from.id) feeds both). A future
    // Discord/Slack writer that breaks this pairing dead-letters silently below.
    const identity = await getChatIdentity(row.channel, row.senderId);
    if (!identity) {
      await failChannelMessage(
        row.id,
        `channel-dispatch: no chat identity for ${row.channel}/${row.senderId}`
      );
      return "failed";
    }
    const chatIdentityId = identity.id;

    let decision: ResolveConversationWorkspaceResult = await resolveConversationWorkspace({
      chatIdentityId,
      channel: row.channel,
      conversationKey: row.conversationKey,
    });

    // --- '/connect': consumed here, never forwarded to Jace. Runs BEFORE the
    // resolution below so it works on conversations that cannot resolve at
    // all — a repair path with the same precondition as the broken thing is
    // not a repair path. Deterministic string match, never the model.
    const command = parseConnectCommand(payload.text);
    if (command.isCommand) {
      // Whole-block try/catch (must-fix #2, whole-branch review): every call
      // below (listWorkspacesForChatIdentity, pinConversationWorkspace,
      // repinConversationWorkspace, reportActualPin's re-resolve) can throw —
      // repinConversationWorkspace explicitly re-throws non-23505 errors,
      // pinned by its own test. Without this, any of those throws falls
      // through to processRow's outer catch, which calls failChannelMessage
      // and sends NOTHING to the channel — silence, exactly what /connect
      // exists to eliminate (see the spec's Error handling section: "/connect
      // never leaves a user with silence"). On catch: reply with a generic
      // in-channel failure message, then COMPLETE (not fail) the row —
      // requeuing would replay the identical failure to the user N times,
      // and /connect is trivially retypable, so there is no retry value in
      // failing it. `sendSystemChannelMessage` is plain HTTP to
      // Telegram/Discord/Slack, so it is unaffected by e.g. a Postgres outage
      // upstream — the reply gets through in exactly the case that matters
      // most. Log the underlying error server-side; never log `identity` or
      // any token.
      try {
        // Resolved ONCE here, per `resolveConsolePublicUrl`'s doc-comment — both
        // the link-building path below and the reply's `consoleUrl` fallback
        // read this SAME local, never two independent `process.env` reads.
        const consolePublicUrl = resolveConsolePublicUrl();
        const reachable = await listWorkspacesForChatIdentity(chatIdentityId);
        const pinnedId = decision.kind === "pinned" ? decision.workspaceId : null;
        const pinned = pinnedId
          ? reachable.find((w) => w.id === pinnedId) ?? { id: pinnedId, name: null }
          : null;

        const action = decideConnectCommand({
          arg: command.arg,
          identity: { userId: identity.userId },
          pinned,
          reachable,
        });
        // What we actually tell the user. Diverges from `action` only when a
        // write below loses a race — see the repin branch.
        let reportAction: ConnectCommandAction = action;

        let linkUrl: string | undefined;
        if (action.kind === "send_link") {
          linkUrl = await ensureConnectLink(identity, chatIdentityId, consolePublicUrl);
        } else if (action.kind === "pin") {
          const pinResult = await pinConversationWorkspace({
            chatIdentityId,
            channel: row.channel,
            conversationKey: row.conversationKey,
            workspaceId: action.workspace.id,
          });
          // Lost a race (already_pinned_elsewhere) or unreachable: report the
          // state that actually exists rather than echoing back the success
          // copy for a pin that never landed.
          if (!pinResult.ok) {
            reportAction = await reportActualPin(chatIdentityId, row, reachable);
          }
        } else if (action.kind === "repin") {
          const moved = await repinConversationWorkspace({
            chatIdentityId,
            channel: row.channel,
            conversationKey: row.conversationKey,
            fromWorkspaceId: action.from.id,
            toWorkspaceId: action.to.id,
          });
          // Lost a race, or the authority re-check refused: re-resolve ONCE and
          // report the state that actually exists, never retry in a loop. Same
          // posture as pinConversationWorkspace's own race contract.
          if (!moved.ok) {
            reportAction = await reportActualPin(chatIdentityId, row, reachable);
          }
        }

        await sendSystemChannelMessage(
          row.channel,
          String(payload.chatId),
          renderConnectReply(reportAction, {
            linkUrl,
            // `||`, not `??` — an empty string (the stock-deploy case; see
            // resolveConsolePublicUrl's doc-comment) must fall back the same
            // way an unset var does, or the no_workspaces copy renders "Create
            // one at , then send /connect again."
            consoleUrl: consolePublicUrl || "the console",
          }),
          payload.messageThreadId !== undefined ? String(payload.messageThreadId) : undefined,
          payload.threadTs,
          payload.teamId
        );
        await completeChannelMessage(row.id);
        return "completed";
      } catch (err) {
        console.error(
          "[channel-dispatch] /connect handling threw:",
          err instanceof Error ? err.message : String(err)
        );
        await sendSystemChannelMessage(
          row.channel,
          String(payload.chatId),
          "Something went wrong handling /connect. Try again in a moment.",
          payload.messageThreadId !== undefined ? String(payload.messageThreadId) : undefined,
          payload.threadTs,
          payload.teamId
        );
        await completeChannelMessage(row.id);
        return "completed";
      }
    }

    // --- 'ask': the reply itself may BE the workspace choice; consumed, never forwarded to Jace. ---
    if (decision.kind === "ask") {
      const chosen = parseWorkspaceChoice(payload.text, decision.options);
      if (chosen) {
        const pin = await pinConversationWorkspace({
          chatIdentityId,
          channel: row.channel,
          conversationKey: row.conversationKey,
          workspaceId: chosen.id,
        });
        if (pin.ok) {
          await sendSystemChannelMessage(
            row.channel,
            String(payload.chatId),
            buildPinConfirmationMessage(chosen.name),
            payload.messageThreadId !== undefined ? String(payload.messageThreadId) : undefined,
            payload.threadTs,
            payload.teamId
          );
          await completeChannelMessage(row.id);
          return "completed";
        }
        // Refused (not_reachable / already_pinned_elsewhere): fall through
        // to the same "invalid choice" handling below. A concurrent pin
        // means the NEXT message resolves as 'pinned' on its own.
      }
      await sendSystemChannelMessage(
        row.channel,
        String(payload.chatId),
        buildWorkspaceChoiceMessage(decision.options),
        payload.messageThreadId !== undefined ? String(payload.messageThreadId) : undefined,
        payload.threadTs,
        payload.teamId
      );
      await completeChannelMessage(row.id);
      return "completed";
    }

    // --- resolve the effective workspaceId (if any) + the jace_sessions ledger row ---
    let workspaceId: string | null = null;
    let ledgerSessionId: string;

    if (decision.kind === "intro") {
      const session = await getOrCreateIntroJaceSession(chatIdentityId, row.channel, row.conversationKey);
      ledgerSessionId = session.id;
    } else {
      if (decision.kind === "single") {
        const pin = await pinConversationWorkspace({
          chatIdentityId,
          channel: row.channel,
          conversationKey: row.conversationKey,
          workspaceId: decision.workspaceId,
        });
        if (!pin.ok) {
          // Races are expected (annex #1261 contract): re-resolve ONCE and
          // proceed with whatever it is now, rather than retry in a loop.
          decision = await resolveConversationWorkspace({
            chatIdentityId,
            channel: row.channel,
            conversationKey: row.conversationKey,
          });
          if (decision.kind !== "pinned") {
            // Unreachable in practice — a pin refusal implies a
            // workspace-anchored session now exists for this
            // (channel, conversationKey). Fail loudly rather than guess.
            await failChannelMessage(
              row.id,
              `channel-dispatch: re-resolve after pin refusal yielded unexpected kind '${decision.kind}'`
            );
            return "failed";
          }
        }
      }
      // decision is now 'single' (pinned this turn) or 'pinned' (already was,
      // or just became so via the re-resolve above) — both carry workspaceId.
      workspaceId = (decision as { workspaceId: string }).workspaceId;
      if (workspaceId) {
        // Back-stamp the resolved workspace onto the channel_inbox row
        // (spec §9 slice 0): the row's own workspace_id is only the
        // SENDER's binding at enqueue time (NULL for a stranger the
        // identity spine hadn't bound yet), which is exactly the population
        // per-workspace activity counting (seat billing) needs to see.
        // Fire-and-forget — a stamp failure is a bookkeeping gap, never a
        // reason to fail or delay this turn.
        void stampChannelInboxWorkspace(db, row.id, workspaceId).catch((err) => {
          console.error(
            `[channel-dispatch] stampChannelInboxWorkspace failed for row=${row.id}:`,
            err instanceof Error ? err.message : String(err)
          );
        });
      }
      const session = await getOrCreateJaceSession(workspaceId, row.channel, row.conversationKey);
      ledgerSessionId = session.id;
    }

    const auth = buildDoorInitiatorAuth({
      chatIdentityId,
      workspaceId,
      channel: row.channel,
      conversationKey: row.conversationKey,
      interactionToken: payload.interactionToken,
      applicationId: payload.applicationId,
      teamId: payload.teamId,
    });

    // Group-vs-DM, hoisted to a first-class fact (spec §9 slice 0) — see
    // `conversationKind`'s own doc-comment. Nothing reads this yet (a later
    // slice's per-person seat gate does); computed here, ahead of the
    // engagement block below, so that slice has one place to read it rather
    // than re-deriving it.
    const conversationKindForRow = conversationKind(row.channel, payload);

    // --- thread engagement (spec: docs/superpowers/specs/2026-07-28-thread-
    // native-jace-design.md) — MUST run and persist BEFORE any guardrail
    // notice can reach the channel (final whole-branch review, finding #2).
    // The old order ran guardrails first: a bow-out message could still get
    // "I cleansed your message..." posted into the thread on the very turn
    // Jace was declining to speak, and the guardrail BLOCK path `return`ed
    // before this block ever ran at all — silently skipping
    // `setThreadEngagement`, so the dormant/engaged latch never updated on a
    // blocked message. Moving the decision here means: a message that is NOT
    // a turn produces zero channel output and still persists its `nextState`;
    // a message that IS a turn falls through to the guardrail seam below
    // completely unchanged — guardrail screening only ever runs on a message
    // that will actually reach Eve, so its ordering relative to `runEveTurn`
    // is untouched. Only "is this even a turn" moved earlier. Discord and
    // Slack ONLY: telegram/console/iMessage never reach this block, so they
    // stay byte-unchanged — no engagement lookup, no state write, no
    // behavioral difference, and the guardrail seam right after this block
    // runs exactly where it always has for them. (Console never reaches
    // `processRow` at all — see `processConsoleRow`'s own doc-comment.)
    //
    // `engagementSaidTurn` (Jace-opens-threads Task 2): captured here for the
    // Discord thread-relocation gate below, which needs to know whether THIS
    // block actually decided "turn" — the `decision` above is a NEW binding
    // scoped to this if-block (shadowing the outer resolveConversationWorkspace
    // `decision`), so it isn't visible past the closing brace. Stays `false`
    // when engagement was never configured (no decision was made at all): "no
    // decision" does not count as "the engagement decision said turn".
    let engagementSaidTurn = false;
    if (row.channel === "discord" || row.channel === "slack") {
      // Final whole-branch review, finding #1 (critical): Slack's door
      // (connectors/slack/events/route.ts) omits the ENTIRE engagement
      // envelope — no `mentionsBot` key at all — when `SLACK_BOT_USER_ID` is
      // unset (see that file's own "FAIL TOWARD TODAY'S BEHAVIOR" doc). In
      // that configuration `mentionsBot` can never resolve to `true`, so
      // running `decideEngagement` here would trap every non-DM Slack
      // message in `turn: false` FOREVER — permanent, silent muting, exactly
      // the opposite of the stated invariant ("when SLACK_BOT_USER_ID is
      // unset, Slack must behave exactly as it did before engagement
      // existed"). `extractPayload` only ever sets `mentionsBot` on the
      // payload when the door supplies an actual boolean (see its own
      // doc-comment), so its absence here means "engagement is not
      // configured for this row" — skip the decision entirely and let it run
      // as a normal turn, same as before this feature existed. Discord's
      // doors always write this key (never conditionally omitted — see
      // discord-inbound.ts's own header doc), so this guard is a permanent
      // no-op for Discord rows the current doors produce; it only matters for
      // a pre-feature row still in flight, which degrades the same safe way.
      const engagementConfigured = payload.mentionsBot !== undefined;
      if (engagementConfigured) {
        const inbound = buildThreadInbound(row.channel, payload, row.senderId);
        const state = await getThreadEngagement({
          channel: row.channel,
          conversationKey: row.conversationKey,
        });
        const decision = decideEngagement({ inbound, state, now: new Date() });

        logEngagementTransition({
          channel: row.channel,
          conversationKey: row.conversationKey,
          previous: state,
          next: decision.nextState,
          reason: decision.reason,
        });

        await setThreadEngagement({
          channel: row.channel,
          conversationKey: row.conversationKey,
          dormantSince: decision.nextState.dormantSince,
          engagedSpeakerId: decision.nextState.engagedSpeakerId,
        });

        if (!decision.turn) {
          // Engagement declined the turn — COMPLETE, not fail: the row was
          // handled correctly, Jace simply chose to stay quiet. Requeuing
          // would just replay the same non-decision forever. No guardrail
          // screening, no notice, no Eve turn: nothing about a message Jace
          // never responds to needs to reach any of those seams.
          await completeChannelMessage(row.id);
          return "completed";
        }
        engagementSaidTurn = true;
      }
    }

    // --- seat gate (spec §6 "Enforcement seams" point 1, slice 5 Task 4): a
    // gated person must not reach the seat claim below, let alone guardrails
    // or Eve — see applySeatGateForServedTurn's own doc-comment for the full
    // orchestration. Placed here, BEFORE the seat claim, for the same reason
    // as that block's own placement: every path reaching this line IS being
    // served (the engagement block above already completed-and-returned for
    // anything it filtered out), so this is the earliest point a real
    // workspaceId exists to gate against. Skipped entirely when workspaceId
    // is null (the 'intro' path) — a conversation with no pinned workspace
    // has no billing account to count seats against, the exact same
    // null-workspaceId skip decideSeatClaimForServedTurn applies just below.
    // A blocked person's turn must never itself claim the seat it was just
    // denied, which is why this runs strictly BEFORE that hook, not after.
    if (workspaceId) {
      const seatGateResult = await applySeatGateForServedTurn({
        workspaceId,
        channel: row.channel,
        conversationKey: row.conversationKey,
        identity: { userId: identity.userId, chatIdentityId },
        deliver: (text) => deliverSeatLimitPromptForChatRow(row.channel, payload, text),
      });
      if (seatGateResult === "gated") {
        await completeChannelMessage(row.id);
        return "completed";
      }
    }

    // --- seat claim (spec §5 rule 1, slice 4 Task 2): only a SERVED turn
    // claims a seat. Deliberately placed HERE — after the engagement block
    // above (which already completed-and-returned for anything it filtered
    // out, so every path reaching this line IS being served) and after
    // `workspaceId` is resolved to whatever it actually is this turn — NOT
    // in the slice-0 back-stamp block earlier (`stampChannelInboxWorkspace`):
    // that one runs PRE-engagement and would claim a seat for every lurker
    // whose messages Jace goes on to ignore. `decideSeatClaimForServedTurn`
    // is pure (skips null-workspaceId itself, the 'intro' path); the actual
    // claim below is fire-and-forget — see claimSeatForServedTurn's own
    // doc-comment for the no-await/no-flag contract.
    const seatClaim = decideSeatClaimForServedTurn({
      workspaceId,
      channel: row.channel,
      identity: { userId: identity.userId, chatIdentityId },
    });
    if (seatClaim) {
      claimSeatForServedTurn(seatClaim);
    }

    // --- input guardrails: moderation / injection / PII, before any turn ---
    // Trust tier comes straight from the identity spine resolved above: no
    // workspace resolved means the 'intro' path — a stranger DMing the shared
    // bot, which is exactly the threat model injection blocking targets.
    const guard = await applyInputGuardrails({
      text: payload.text,
      trust: workspaceId ? "bound" : "stranger",
      channel: row.channel,
      conversationKey: row.conversationKey,
      workspaceId,
      chatIdentityId,
    });

    if (!guard.allowed) {
      // COMPLETE, not fail: `failChannelMessage` requeues, which would replay
      // the identical block at the user N times. The message was handled —
      // the handling was "refused".
      if (guard.notice) {
        await sendSystemChannelMessage(
          row.channel,
          String(payload.chatId),
          guard.notice,
          payload.messageThreadId !== undefined ? String(payload.messageThreadId) : undefined,
          payload.threadTs,
          payload.teamId
        );
      }
      await completeChannelMessage(row.id);
      return "completed";
    }

    // Tell the user their message was cleansed — a silent redaction would
    // leave them wondering why Jace answered a question they didn't ask.
    if (guard.notice) {
      await sendSystemChannelMessage(
        row.channel,
        String(payload.chatId),
        guard.notice,
        payload.messageThreadId !== undefined ? String(payload.messageThreadId) : undefined,
        payload.threadTs,
        payload.teamId
      );
    }

    // The turn runs on the CLEANSED text, never `payload.text`.
    const message = await withReplyContextPreface(workspaceId, {
      ...payload,
      text: guard.text,
    });

    // --- Discord thread relocation (Jace-opens-threads Task 2; scope
    // widened, with the coordinator's authorization, to also thread a real
    // `messageId` through discord-inbound.ts + its Gateway-listener route —
    // see TelegramInboxPayload.messageId's doc-comment above for why
    // `channel_inbox.payload` never carried one before this) — a channel
    // mention gets answered inside its own NEW thread, so the channel stays
    // clean and the thread needs no further mentions. ALL of these must
    // hold, or the turn proceeds exactly as today, unrelocated:
    //
    //   1. row.channel === "discord"
    //   2. the engagement decision above said this is a turn (`engagementSaidTurn`)
    //   3. NOT already in a thread (payload.threadId absent/null)
    //   4. it is not a DM
    //   5. DISCORD_BOT_TOKEN is configured
    //   6. payload.messageId is present
    //   7. workspaceId is resolved (non-null) — `getOrCreateJaceSession`
    //      below requires one; an 'intro' (pre-workspace) conversation has no
    //      workspace-anchored row to redirect, so it is simply not relocated
    //
    // On condition 4 — this is NOT a DM check, despite appearances. A user
    // typing `@Jace <question>` INSIDE a DM produces exactly this same shape:
    // the Gateway reads Discord's raw `mentions` array off the message, and a
    // DM mention of the bot is present in it just like a channel mention is —
    // so `payload.mentionsBot === true` is true, and `payload.threadId` is
    // null, for a DM mention too. `buildThreadInbound`'s own `isDM` field
    // ABOVE mislabels this same shape as `isDM: true` (see its own
    // doc-comment) — harmless there only because `decideEngagement`'s
    // mentionsBot branch short-circuits either way. Nothing upstream of this
    // gate can actually distinguish a channel mention from a DM mention.
    //
    // What makes a DM mention safe here is NOT this gate — it is what
    // happens after it: a DM mention reaches `createDiscordThreadFromMessage`
    // below with a DM channel id, Discord rejects thread-create against a DM
    // (DMs cannot have threads at all), and the ordinary failure branch runs
    // — unrelocated, answered in the channel (the DM), exactly as before
    // this feature existed. The cost is one wasted API call and one error
    // log line per DM mention; there is no split-conversation risk, because
    // a DM has no separate thread for the reply to land in instead. A future
    // reader must NOT treat `payload.mentionsBot === true` combined with
    // `threadId === null` as proof of "not a DM" — it is not; the
    // rejection-and-fallback below is the actual safety net.
    //
    // On condition 6 — the `/jace` slash-command webhook door
    // (`connectors/discord/webhook/route.ts`) never sets `messageId`: a
    // slash-command INTERACTION has no backing channel message for Discord's
    // `POST /channels/{id}/messages/{messageId}/threads` to target, so there
    // is nothing true to supply, and that door is deliberately left
    // untouched rather than synthesizing one. Its absence is what correctly
    // excludes every slash-command invocation from relocation — including one
    // sent as a bot-DM, which this feature must never try to thread either —
    // rather than any thread/DM check having to know about slash commands at
    // all.
    // HONEST LIMITATION (self-review finding, recorded rather than hidden):
    // `engagementSaidTurn` is currently PROVABLY REDUNDANT with the
    // `threadId === null` + `mentionsBot === true` pair below, given
    // `buildThreadInbound`'s own imprecise `isDM` proxy above (`isDM:
    // threadId === null`, regardless of `mentionsBot`) — whenever `threadId
    // === null` and the engagement envelope is configured at all,
    // `decideEngagement` short-circuits to `turn: true` on the `isDM` branch
    // BEFORE it ever inspects `mentionsBot`. So today, no payload can satisfy
    // conditions 3+4 below while `engagementSaidTurn` is false; a mutation
    // deleting this line leaves the test suite green. It is kept anyway,
    // deliberately: it is the literal condition the brief specifies, and it
    // is NOT a no-op forever — it is the correct guard the day the known
    // FOLLOW-UP gap (progress.md: "put an explicit isDM on the wire") is
    // fixed, at which point a real per-message isDM signal could diverge
    // from `mentionsBot` in ways it cannot today.
    let turnChatId: number | string = payload.chatId;
    let turnConversationKey = row.conversationKey;
    let turnAuth = auth;

    const eligibleForThreadRelocation =
      row.channel === "discord" &&
      engagementSaidTurn &&
      (payload.threadId === undefined || payload.threadId === null) &&
      payload.mentionsBot === true &&
      typeof payload.messageId === "string" &&
      payload.messageId.length > 0 &&
      workspaceId !== null;

    if (eligibleForThreadRelocation) {
      const discordBotToken = process.env["DISCORD_BOT_TOKEN"];
      if (!discordBotToken) {
        // No token configured: fall through unrelocated, exactly as today.
        // Never a fail — the user still gets their answer, in the channel.
        console.error(
          `[channel-dispatch] discord thread relocation skipped for row ${row.id}: DISCORD_BOT_TOKEN is not configured`
        );
      } else {
        const created = await createDiscordThreadFromMessage(
          discordBotToken,
          String(payload.chatId),
          payload.messageId as string,
          deriveThreadName(guard.text)
        );
        // Discord returns `code: 160004` ("A thread has already been created
        // for this message") when a retry lands after attempt 1 already
        // created the thread — e.g. the console restarts mid-turn (a Railway
        // deploy) and `reclaimStaleChannelMessages` requeues the row past the
        // stale-processing window, so attempt 2's create call finds the
        // thread already there. Treat this as SUCCESS, not failure: Discord
        // guarantees a thread's id equals its source message id, so the
        // existing thread is exactly `payload.messageId` — relocate onto it
        // and continue as though creation had succeeded. Falling back
        // instead would answer THIS attempt in the channel while attempt 1's
        // answer (and the thread's latched engagement row) already live in
        // the thread — a conversation genuinely split across both places.
        const alreadyExists = !created.ok && created.code === 160004;
        if (created.ok || alreadyExists) {
          const threadId = created.ok ? created.threadId : (payload.messageId as string);
          // Step 2 — THE CORRECTNESS CRUX: resolve the ledger session under
          // the THREAD's key, not the channel-keyed one, and bind the Eve
          // session to THAT row (`ledgerSessionId` is what `bindEveSession`
          // below uses). Writing this under the channel key while the reply
          // goes to the thread would mean the very next message in the
          // thread finds no session at all — a brand-new conversation with
          // no memory, demanding another mention.
          const threadSession = await getOrCreateJaceSession(
            workspaceId as string,
            "discord",
            threadId
          );
          ledgerSessionId = threadSession.id;
          // Step 3: persist engagement for the THREAD's key, so the very
          // next un-mentioned message in it is a turn — no re-mention needed.
          await setThreadEngagement({
            channel: "discord",
            conversationKey: threadId,
            dormantSince: null,
            engagedSpeakerId: row.senderId,
          });
          // Step 4: the turn itself is addressed to, and keyed on, the thread.
          turnChatId = threadId;
          turnConversationKey = threadId;
          // Step 5: strip the interaction credential for THIS turn. A
          // Discord interaction followup cannot target a thread — if the
          // credential survived, `deliverDiscordReply` would prefer the
          // followup path and post the answer into the CHANNEL while the
          // conversation has moved to the thread, a split-brain conversation.
          const {
            interactionToken: _relocatedInteractionToken,
            applicationId: _relocatedApplicationId,
            ...strippedAttributes
          } = (auth["attributes"] as Record<string, unknown>) ?? {};
          turnAuth = { ...auth, attributes: strippedAttributes };
        } else {
          // On failure: log the numeric status + Discord's numeric code only
          // — never the token, never the URL — then fall through
          // UNRELOCATED, exactly as today: original chatId, original
          // conversationKey, credential intact. The user still gets their
          // answer, in the channel. CREATE_PUBLIC_THREADS is NOT confirmed
          // granted in production, so this fallback is load-bearing, not
          // theoretical.
          console.error(
            `[channel-dispatch] discord thread creation failed for row ${row.id}` +
              (created.status !== undefined ? ` status=${created.status}` : "") +
              (created.code !== undefined ? ` code=${created.code}` : "")
          );
        }
      }
    }

    const turn = await runEveTurn({
      message,
      channel: row.channel,
      chatId: turnChatId,
      conversationKey: turnConversationKey,
      messageThreadId: payload.messageThreadId,
      threadTs: payload.threadTs,
      auth: turnAuth,
    });

    if (!turn.ok) {
      await failChannelMessage(row.id, `channel-dispatch: ${turn.reason}`);
      return "failed";
    }

    await bindEveSession(ledgerSessionId, turn.sessionId);
    await completeChannelMessage(row.id);
    return "completed";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await failChannelMessage(row.id, message);
    } catch (failErr) {
      // Even the failure write itself is best-effort here: never let a
      // broken DB write take the whole drain down.
      console.error("[channel-dispatch] failChannelMessage itself failed:", failErr);
    }
    return "failed";
  }
}

async function drainQueue(): Promise<DispatchResult> {
  await reclaimStaleChannelMessages();

  let processed = 0;
  let failed = 0;
  for (;;) {
    const claimed = await claimNextChannelMessage();
    if (!claimed) break;
    const outcome = await processRow(claimed);
    if (outcome === "failed") failed++;
    else processed++;
  }
  return { processed, failed };
}

/** Module-level latch: collapses concurrent kicks into a single drain. */
let inflightDrain: Promise<DispatchResult> | null = null;

/**
 * Drain `channel_inbox` until empty: claim -> resolve conversation ->
 * workspace -> run the Eve turn (or consume an 'ask' reply) -> ledger ->
 * complete/fail, one row at a time, never throwing past a single poisoned
 * row.
 *
 * Concurrency: `claimNextChannelMessage` is already safe across processes
 * (`FOR UPDATE SKIP LOCKED` + advisory locks); this in-process latch only
 * collapses redundant PARALLEL drains within one console instance (e.g. two
 * webhook requests landing back to back) into the one already running. The
 * latch check + assignment below is synchronous (no `await` before
 * `inflightDrain` is set), so two synchronous calls in the same tick always
 * observe it correctly. A real worker process replaces this whole function
 * in Wave 2.
 *
 * `withReplyContextPreface` (issue #1277): the ONE seam where an inbound
 * payload's optional `replyContext` (a reply to a run-outcome ping, parsed
 * server-side by the webhook route) turns into a workspace-scoped
 * `latestRunForIssue` lookup and a bracketed preface prepended to the
 * message Jace actually receives — see that function's own doc comment for
 * the threat-model note.
 */
export function dispatchQueuedChannelMessages(): Promise<DispatchResult> {
  if (inflightDrain) return inflightDrain;
  const run = drainQueue().finally(() => {
    inflightDrain = null;
  });
  inflightDrain = run;
  return run;
}
