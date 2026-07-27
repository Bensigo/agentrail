// Jace's native Telegram channel (#1047).
//
// This is Eve's first-class Telegram integration — it handles inbound webhook
// updates AND outbound/proactive delivery (repliable threads), signature
// verification, and typing indicators natively. We do NOT hand-roll Telegram HTTP
// or token handling; Eve owns it. The channel id is this file's name (`telegram`),
// so Eve mounts the inbound webhook at `/eve/v1/telegram`.
//
// Self-host credentials come from the environment (no Vercel Connect required):
//   TELEGRAM_BOT_USERNAME        — the bot's @username (without the @)
//   TELEGRAM_BOT_TOKEN           — the BotFather token (proactive sends)
//   TELEGRAM_WEBHOOK_SECRET_TOKEN — the secret token Telegram signs updates with
// After deploy, register the webhook once with Telegram's setWebhook API pointing
// at `https://<host>/eve/v1/telegram` (see apps/jace/README.md).
//
// NOTE: signature/option shape follows the eve@0.19.0 docs; boot behavior when the
// env is unset and live delivery are verified against the running sidecar
// (#1038/#1101), behind the per-workspace `jaceOwnsTelegramNotify` opt-in.
//
// The message.completed handler overrides Eve's default handler (which posts
// the full reply as one message) to instead split it into several bubbles on
// the model's own paragraph breaks — see agent/lib/chat-split.core.mjs for
// why, and instructions.md's "Voice and reply length" section for the model
// contract this relies on. The `finishReason`/`message` guard mirrors Eve's
// default exactly, so tool-call and empty-message turns behave unchanged.
//
// The turn.started handler overrides Eve's default one-shot `startTyping()`.
// Telegram expires a typing indicator after ~5s, so on a slow model the chat
// looks dead for the rest of a 30s–2min turn. The keep-alive re-sends the
// action until the turn ends (stopped on message.completed / turn.completed;
// the failure path is backstopped by the keep-alive's own safety cap so we do
// not clobber Eve's default turn.failed / session.failed error handlers, which
// Eve does not export for chaining). See agent/lib/typing-keepalive.core.mjs.
//
// The ack is skipped for a Jace-initiated turn (run-outcome.ts's terminal-
// outcome / goal-loop hand-off) — see ack-on-silence.core.mjs's
// isProactiveTurn for why: composing that reply is a full model turn that
// routinely exceeds the ack window, and there is no human message behind it
// to acknowledge.
//
// INBOUND SHIM (#1472, docs/superpowers/specs/2026-07-27-jace-connect-command-design.md
// "Part 2 — Telegram transport shim"): this native `/eve/v1/telegram` webhook
// used to turn every inbound Update straight into an Eve turn, bypassing the
// console's own workspace resolver entirely (resolveInboundChatIdentity /
// enqueueChannelMessage / the jace_sessions ledger write) — every
// workspace-scoped tool 404'd, because the conversation was never registered.
// Behind JACE_TELEGRAM_FORWARD_TO_CONSOLE (default off — unset/falsy is
// today's behaviour byte-for-byte), `onMessage` normalizes the raw update and
// POSTs it to the console's intake (agent/lib/telegram_forward.core.mjs,
// mirroring discord_gateway.core.mjs's shape) instead of admitting it here,
// returning `null` — eve's documented "drop this message, do not start a
// turn" signal for onMessage (see eve/channels/{slack,teams}.mdx: "Return
// `null` to drop the message"). The console's dispatcher resolves the
// workspace and hands the turn BACK to this same module via
// `args.receive(telegram, ...)` (agent/channels/hosted-inbound.ts), which is
// why outbound delivery below is completely unchanged: message.completed /
// turn.started still fire for that continued turn exactly as they do today.
// When the flag is off, `onMessage` is `undefined` — not a conditionally
// no-op handler — so eve's own default admission/turn-start logic (which
// this shim does not attempt to reproduce) is the thing that runs, unchanged.
import { telegramChannel, type TelegramContext } from "eve/channels/telegram";
import { splitIntoChatMessages } from "../lib/chat-split.core.mjs";
import { createTypingKeepalive } from "../lib/typing-keepalive.core.mjs";
import {
  createAckOnSilence,
  ACK_TEXT,
  isProactiveTurn,
} from "../lib/ack-on-silence.core.mjs";
import { forwardTelegramInbound } from "../lib/telegram_forward.core.mjs";

const botUsername = (process.env["TELEGRAM_BOT_USERNAME"] ?? "").trim();

/** Same "1"/"true" (case-insensitive) convention as
 * apps/console/lib/chat/feature-flags.ts's `isTruthyFlag` — not duplicated
 * across the app boundary since apps/jace installs standalone (see this
 * file's package.json note) and cannot import from apps/console. */
function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true";
}

const forwardToConsole = isTruthyFlag(process.env["JACE_TELEGRAM_FORWARD_TO_CONSOLE"]);

/**
 * Shown in-channel when a forward to the console fails — a console outage
 * (unreachable host, 502, unset JACE_CONSOLE_* vars) must never be silent:
 * eve already returns 200 to Telegram for this webhook delivery regardless
 * of what `onMessage` does, so Telegram will not retry, and nothing else in
 * this path enqueues the message. Short and dry (Jace's voice, no apology
 * paragraph) — something the sender can act on immediately.
 */
const FORWARD_FAILURE_NOTICE = "Couldn't reach the workspace to log that — try sending it again in a moment.";

/**
 * Inbound admission override, wired ONLY when `forwardToConsole` is true
 * (see the header comment). `message.raw` is eve's documented raw-payload
 * escape hatch on the normalized inbound `message` (the same shape every
 * first-class channel's `onMessage` exposes, e.g. Slack's
 * `message.raw.channel_type`) — here it is Telegram's raw `Message` object,
 * so it is wrapped as `{ message: message.raw }` to match
 * `shapeTelegramInbound`'s documented `Update` shape
 * (`update.message ?? update.edited_message`). Never throws: a forward
 * failure is logged, not re-attempted, and the door still returns `null` —
 * an inbound Telegram update should never fall through to starting a turn on
 * this door once the flag is on, forward failure or not.
 *
 * On a failed forward, also posts `FORWARD_FAILURE_NOTICE` in-channel via
 * `ctx.telegram.post` (see eve's `TelegramContext` — the minimal context
 * `onMessage` receives before a session exists, `{ readonly telegram:
 * TelegramHandle }`) BEFORE returning `null`, so a console outage never
 * blackholes the user's message with zero feedback (final-branch review
 * Finding 2). Posting the notice is itself wrapped in its own try/catch: it
 * must never throw out of `onMessage`, forward failure or not.
 */
async function onMessage(
  ctx: TelegramContext,
  message: { raw?: unknown },
): Promise<null> {
  const result = await forwardTelegramInbound({
    env: process.env,
    update: { message: message?.raw },
    transport: fetch,
  });
  if (!result.ok) {
    console.error("[telegram] forward-to-console failed:", result.reason);
    try {
      await ctx.telegram.post(FORWARD_FAILURE_NOTICE);
    } catch (err) {
      console.error("[telegram] forward-failure notice itself failed:", err);
    }
  }
  return null;
}

const typing = createTypingKeepalive();
const ack = createAckOnSilence();
const convoKey = (ctx: { session?: { id?: string } }) =>
  ctx?.session?.id ?? "telegram";

export default telegramChannel({
  botUsername,
  onMessage: forwardToConsole ? onMessage : undefined,
  events: {
    "turn.started"(_data, channel, ctx) {
      const key = convoKey(ctx);
      typing.start(key, () => channel.telegram.startTyping());
      // One-shot: if this turn goes quiet for ACK_AFTER_MS, tell the human
      // we're on it. Disarmed below the moment a real reply lands. Skipped
      // entirely for a Jace-initiated turn — see the header comment.
      if (!isProactiveTurn(ctx?.session?.auth)) {
        ack.start(key, () => channel.telegram.post(ACK_TEXT));
      }
    },
    "turn.completed"(_data, _channel, ctx) {
      const key = convoKey(ctx);
      typing.stop(key);
      ack.stop(key);
    },
    async "message.completed"(data, channel, ctx) {
      // NOTE: both stops sit BELOW this guard on purpose. A `tool-calls`
      // message.completed fires mid-turn while the turn keeps working —
      // stopping here would kill the typing indicator at the first tool call
      // (the pre-existing behaviour this fixes) and suppress the ack on
      // exactly the slow, tool-calling turns that most need it.
      if (data.finishReason === "tool-calls" || !data.message) return;
      const key = convoKey(ctx);
      typing.stop(key);
      ack.stop(key);
      const messages = splitIntoChatMessages(data.message);
      for (const [index, message] of messages.entries()) {
        if (index > 0) await channel.telegram.startTyping();
        await channel.telegram.post(message);
      }
    },
  },
});
