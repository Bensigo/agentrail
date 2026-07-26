// Pure, dependency-free core for Jace's Discord GATEWAY listener (the
// @mention / DM path — spec docs/superpowers/specs/2026-07-26-discord-gateway-listener-design.md).
//
// Today Jace only ever sees Discord traffic Discord chooses to deliver over
// HTTP: interactions (the `/jace` slash command), handled entirely by Eve's
// own `discordChannel` (agent/channels/discord.ts) and the console's
// interactions webhook. Discord never delivers a plain typed message or an
// @mention over HTTP — only over a persistent Gateway WebSocket, which is
// what agent/lib/discord-gateway.mjs (the thin, impure socket wrapper) opens.
// This module is everything about that listener that can be decided WITHOUT
// a live socket: is an inbound MESSAGE_CREATE for us or noise, what payload
// to send onward, and what a Gateway close code means — unit-tested with
// `node --test`, mirroring chat-split.core.mjs / run_outcome.core.mjs's split
// between "pure decision" and "thin transport".
//
// Three concerns, matching the spec's pure-core split exactly:
//   1. Message admission  — is this MESSAGE_CREATE for us, or noise?
//   2. Payload shaping     — what does the console's intake route receive?
//   3. Close-code classification — must we stop forever, or is this transient?
//
// Plus the small "POST the admitted message to console" transport shim,
// mirroring console_chat_reply.core.mjs's injected-`transport` pattern
// (Jace has no direct Postgres access — apps/jace is deliberately excluded
// from this repo's pnpm workspace — so this is how a Gateway-observed
// message becomes a `channel_inbox` row: an authenticated HTTP call to the
// console's own `/api/v1/runner/discord-inbound`, not a DB write).
//
// Same env resolution as every other Jace->console core module
// (JACE_CONSOLE_BASE_URL / JACE_CONSOLE_TOKEN); deliberately duplicated
// verbatim rather than imported from console_chat_reply.core.mjs — see that
// module's own note (borrowed from create_workspace.core.mjs) on why each
// core module here stays dependency-free of the others.

// --- 1. Message admission ---------------------------------------------------

/**
 * A Discord user object carries `bot: true` on every bot account, including
 * OUR OWN — this single check is what keeps the listener from replying to
 * itself (an infinite ping-pong) and from replying to any other bot's
 * messages. There is no separate "is this me" check because a stricter one
 * is unnecessary: ANY bot author is noise for this door.
 */
export function isFromBot(author) {
  return Boolean(author && author.bot === true);
}

/** Discord omits `guild_id` entirely on a DM MESSAGE_CREATE (present on every
 * guild message) — the standard, documented way to tell them apart without a
 * channel-type cache lookup. */
export function isDirectMessage(message) {
  return message?.guild_id == null;
}

/**
 * True iff `botUserId` appears in the message's explicit `mentions` array.
 * Discord populates `mentions` only for actual `<@id>` tokens — an
 * `@everyone`/`@here` sweep (tracked separately as `mention_everyone`) does
 * NOT add every member to this array, and a mentioned ROLE the bot happens
 * to hold does not either (that is `mention_roles`, a different field). So
 * this is already exactly "did they explicitly @ the bot", nothing extra to
 * exclude.
 */
export function mentionsBot(mentions, botUserId) {
  if (!botUserId || !Array.isArray(mentions)) return false;
  return mentions.some((user) => user && user.id === botUserId);
}

/**
 * Decide whether a raw Gateway MESSAGE_CREATE payload should become a Jace
 * turn. Admits when it mentions the bot OR is a DM; ignores the bot's own
 * messages, other bots, and empty content — exactly the spec's rule, nothing
 * extra layered on. `botUserId` is the Gateway session's own bot user id
 * (known only after READY; see discord-gateway.mjs) — with no botUserId yet
 * there is no way to tell a real mention from noise, so nothing is admitted.
 *
 * @param {{ author?: { id?: string, bot?: boolean } | null, guild_id?: string | null,
 *           mentions?: Array<{ id?: string }>, content?: string }} message
 * @param {string | null | undefined} botUserId
 * @returns {{ admit: boolean, reason: string }}
 */
export function admitMessage(message, botUserId) {
  if (!botUserId) {
    return { admit: false, reason: "bot user id not yet known (gateway not ready)" };
  }
  if (!message || typeof message !== "object") {
    return { admit: false, reason: "malformed message payload" };
  }
  if (isFromBot(message.author)) {
    return { admit: false, reason: "from a bot (self or another bot)" };
  }
  const content = typeof message.content === "string" ? message.content.trim() : "";
  if (!content) {
    return { admit: false, reason: "empty content" };
  }
  if (isDirectMessage(message)) {
    return { admit: true, reason: "direct message" };
  }
  if (mentionsBot(message.mentions, botUserId)) {
    return { admit: true, reason: "mentions the bot" };
  }
  return { admit: false, reason: "guild message without a mention of the bot" };
}

// --- 2. Payload shaping ------------------------------------------------------

/**
 * Strip every `<@BOT_ID>` / `<@!BOT_ID>` mention token for `botUserId` out of
 * a message's raw content, collapsing the whitespace that leaves behind, so
 * Eve's turn sees "hello" rather than "<@1530306014740615328> hello". A DM
 * has no mention token to strip, so this is a harmless no-op there.
 */
export function stripBotMention(content, botUserId) {
  const text = typeof content === "string" ? content : "";
  if (!botUserId) return text.trim();
  const pattern = new RegExp(`<@!?${botUserId}>`, "g");
  return text.replaceAll(pattern, " ").replace(/\s+/g, " ").trim();
}

/** The dedupe key `enqueueChannelMessage` uniques on (channel, provider_message_id)
 * — same convention the interactions webhook door already uses for slash
 * commands (`${channelId}:${interactionId}`), just keyed off the Gateway
 * message id instead of an interaction id. */
export function buildProviderMessageId(channelId, messageId) {
  return `${channelId}:${messageId}`;
}

/** `global_name` (display name) falls back to `username`, then the raw id —
 * the SAME fallback chain the interactions webhook door's `displayNameFor`
 * already uses, kept consistent so a user's display name never depends on
 * which Discord door they reached Jace through. */
function displayNameFor(author) {
  return author?.global_name || author?.username || author?.id || "";
}

/**
 * Shape an ADMITTED raw Gateway message into the exact body
 * `POST /api/v1/runner/discord-inbound` expects — the console-side mirror of
 * what the interactions webhook already sends `enqueueChannelMessage`
 * (channel `discord`, conversationKey = channel id, payload `{ chatId, text,
 * fromId, fromUsername }`), just assembled here instead of on the console,
 * since the console route trusts a pre-shaped body from an authenticated
 * caller rather than re-deriving it.
 *
 * Call only on a message `admitMessage` already approved — this function
 * does not re-check admission.
 */
export function shapeInboundPayload({ message, botUserId }) {
  const channelId = String(message.channel_id);
  const messageId = String(message.id);
  const senderId = String(message.author.id);
  const senderUsername =
    typeof message.author.username === "string" ? message.author.username : null;
  return {
    channelId,
    messageId,
    senderId,
    senderDisplay: displayNameFor(message.author),
    senderUsername,
    text: stripBotMention(message.content, botUserId),
  };
}

// --- 3. Close-code classification -------------------------------------------

/**
 * Gateway close codes Discord documents as NON-recoverable — "Reconnect:
 * false" in the official close-event-codes table, cross-checked against
 * @discordjs/ws@2.0.4's own `WebSocketShard#onClose` (installed source,
 * `node_modules/@discordjs/ws/dist/index.js`): every one of these calls
 * `destroy({ code })` with NO `recover` option (so the shard does not
 * attempt Resume OR a fresh Identify) and emits an `error` event. 4014 is the
 * spec's named example (the Message Content — or another privileged —
 * intent is not enabled for this application), but it is one of six, not the
 * only one, and all six get the identical fatal treatment here.
 */
export const FATAL_CLOSE_CODES = Object.freeze({
  4004: "Authentication failed — DISCORD_BOT_TOKEN is missing, revoked, or wrong.",
  4010: "Invalid shard — the shard id/count this listener identified with is wrong.",
  4011: "Sharding required — this bot is in too many guilds for a single shard.",
  4012: "Invalid API version — the Gateway version this client requests is no longer supported.",
  4013: "Invalid intent(s) — a requested intent value is malformed.",
  4014: "Disallowed intent(s) — a privileged intent (e.g. Message Content) is not enabled for this application in the Discord Developer Portal.",
});

/** Non-fatal codes get a short human summary too, purely for readable logs —
 * @discordjs/ws already owns the actual resume-vs-reidentify decision for
 * every one of these (that correctness is exactly why the spec prefers a
 * maintained client over a hand-rolled one; this file does not re-derive or
 * second-guess it). */
const TRANSIENT_CLOSE_SUMMARIES = Object.freeze({
  1000: "Normal closure — Discord disconnected us; reconnecting.",
  4000: "Unknown error on Discord's side — reconnecting.",
  4001: "We sent an invalid opcode — reconnecting.",
  4002: "We sent an invalid payload — reconnecting.",
  4003: "A payload was sent before identifying — reconnecting.",
  4005: "More than one Identify was sent — reconnecting.",
  4007: "Invalid sequence number — reconnecting.",
  4008: "Rate limited on the socket — reconnecting.",
  4009: "Session timed out — reconnecting.",
});

/**
 * Classify a Gateway close code for OUR logging/control-flow purposes only:
 * `fatal: true` means never reconnect (log clearly and stop, per the spec);
 * `fatal: false` means transient — let @discordjs/ws's own internal
 * resume/reconnect logic run uninterrupted. This is deliberately a two-way
 * split, not a finer resume-vs-reidentify taxonomy: which of those two the
 * library picks per code is verified library-internal behavior (see
 * FATAL_CLOSE_CODES's doc comment), not something this listener should
 * re-implement or guess at.
 *
 * @param {number} code
 * @returns {{ fatal: boolean, summary: string }}
 */
export function classifyCloseCode(code) {
  const fatalReason = FATAL_CLOSE_CODES[code];
  if (fatalReason) {
    return { fatal: true, summary: fatalReason };
  }
  const transientSummary = TRANSIENT_CLOSE_SUMMARIES[code];
  return {
    fatal: false,
    summary: transientSummary ?? `Closed with code ${code} — reconnecting.`,
  };
}

// --- 4. Jace -> console transport (mirrors console_chat_reply.core.mjs) -----

export const DISCORD_INBOUND_PATH = "/api/v1/runner/discord-inbound";

/**
 * Resolve the console endpoint + bearer from the environment. Trims both,
 * strips a trailing slash from the base URL, and reports which var(s) are
 * missing. Same two vars, same shape, same behavior as
 * console_chat_reply.core.mjs's `resolveConsoleConfig` — duplicated rather
 * than imported (see this file's header comment).
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ ok: true, baseUrl: string, token: string } | { ok: false, missing: string[] }}
 */
export function resolveGatewayConsoleConfig(env = {}) {
  const baseUrl = String(env.JACE_CONSOLE_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env.JACE_CONSOLE_TOKEN ?? "").trim();
  const missing = [];
  if (!baseUrl) missing.push("JACE_CONSOLE_BASE_URL");
  if (!token) missing.push("JACE_CONSOLE_TOKEN");
  if (missing.length) return { ok: false, missing };
  return { ok: true, baseUrl, token };
}

/** Build the discord-inbound URL. */
export function buildDiscordInboundUrl(baseUrl) {
  return `${baseUrl}${DISCORD_INBOUND_PATH}`;
}

/**
 * POST one admitted Discord message to the console's discord-inbound door.
 *
 * Unlike `postConsoleChatReply` (which throws, because its caller is inside
 * an Eve turn that already has error handling), this NEVER throws: it is
 * called from a raw Gateway event handler with no such safety net, so every
 * failure mode — unset config, a network error, a non-2xx response —
 * resolves to a typed `{ ok: false, error }` the caller can log and move on
 * from, exactly like `sendDiscordChannelMessage`'s contract on the console
 * side.
 *
 * @param {{
 *   channelId: string, messageId: string, senderId: string,
 *   senderDisplay: string, senderUsername: string | null, text: string,
 *   env?: Record<string, string|undefined>,
 *   transport: (url: string, init: { method: string, headers: Record<string,string>, body: string }) =>
 *     Promise<{ status: number, json: () => Promise<unknown> }>,
 * }} args
 * @returns {Promise<{ ok: true, deduped: boolean } | { ok: false, error: string }>}
 */
export async function postDiscordInboundMessage({
  channelId,
  messageId,
  senderId,
  senderDisplay,
  senderUsername,
  text,
  env = {},
  transport,
}) {
  const cfg = resolveGatewayConsoleConfig(env);
  if (!cfg.ok) {
    return {
      ok: false,
      error: `discord-inbound: missing ${cfg.missing.join(", ")} — cannot deliver the message.`,
    };
  }

  let res;
  try {
    res = await transport(buildDiscordInboundUrl(cfg.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify({ channelId, messageId, senderId, senderDisplay, senderUsername, text }),
    });
  } catch (err) {
    return {
      ok: false,
      error: `discord-inbound: request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (res.status < 200 || res.status >= 300) {
    return { ok: false, error: `discord-inbound: console returned ${res.status}` };
  }

  let deduped = false;
  try {
    const body = await res.json();
    deduped = Boolean(body && typeof body === "object" && body.deduped === true);
  } catch {
    // A 2xx with a non-JSON/empty body is still a success — dedupe info is
    // best-effort observability, not load-bearing.
  }
  return { ok: true, deduped };
}
