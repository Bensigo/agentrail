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
import { telegramChannel } from "eve/channels/telegram";
import { splitIntoChatMessages } from "../lib/chat-split.core.mjs";
import { createTypingKeepalive } from "../lib/typing-keepalive.core.mjs";
import {
  createAckOnSilence,
  ACK_TEXT,
  isProactiveTurn,
} from "../lib/ack-on-silence.core.mjs";

const botUsername = (process.env["TELEGRAM_BOT_USERNAME"] ?? "").trim();

const typing = createTypingKeepalive();
const ack = createAckOnSilence();
const convoKey = (ctx: { session?: { id?: string } }) =>
  ctx?.session?.id ?? "telegram";

export default telegramChannel({
  botUsername,
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
