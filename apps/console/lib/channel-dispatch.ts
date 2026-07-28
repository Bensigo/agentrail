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
  type ClaimedChannelInboxRow,
  type ReachableWorkspace,
  type ResolveConversationWorkspaceResult,
} from "@agentrail/db-postgres";
import { sendSystemTelegramMessage, buildWorkspaceChoiceMessage, buildPinConfirmationMessage } from "./telegram-system-message";
import { sendSystemDiscordMessage } from "./discord-system-message";
import { sendSystemSlackMessage } from "./slack-system-message";
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
 */
async function sendSystemChannelMessage(
  channel: string,
  targetId: string,
  text: string,
  messageThreadId?: string,
  slackThreadTs?: string
) {
  if (channel === "discord") return sendSystemDiscordMessage(targetId, text);
  if (channel === "slack") return sendSystemSlackMessage(targetId, text, slackThreadTs);
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
  const threadTs = p["threadTs"];
  if (typeof threadTs === "string" && threadTs.trim()) {
    result.threadTs = threadTs;
  }
  return result;
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
 */
function buildDoorInitiatorAuth(params: {
  chatIdentityId: string;
  workspaceId: string | null;
  channel: string;
  conversationKey: string;
  interactionToken?: string;
  applicationId?: string;
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
          payload.threadTs
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
          payload.threadTs
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
            payload.threadTs
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
        payload.threadTs
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
    });

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
          payload.threadTs
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
        payload.threadTs
      );
    }

    // The turn runs on the CLEANSED text, never `payload.text`.
    const message = await withReplyContextPreface(workspaceId, {
      ...payload,
      text: guard.text,
    });

    const turn = await runEveTurn({
      message,
      channel: row.channel,
      chatId: payload.chatId,
      conversationKey: row.conversationKey,
      messageThreadId: payload.messageThreadId,
      threadTs: payload.threadTs,
      auth,
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
