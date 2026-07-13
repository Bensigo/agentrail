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
// `events["message.completed"]` overrides Eve's default handler (which posts
// the full reply as one message) to instead split it into several bubbles on
// the model's own paragraph breaks — see agent/lib/chat-split.core.mjs for
// why, and instructions.md's "Voice and reply length" section for the model
// contract this relies on. The `finishReason`/`message` guard mirrors Eve's
// default exactly, so tool-call and empty-message turns behave unchanged.
//
// `events["turn.started"]` overrides Eve's default one-shot `startTyping()`.
// Telegram expires a typing indicator after ~5s, so on a slow model the chat
// looks dead for the rest of a 30s–2min turn. The keep-alive re-sends the
// action until the turn ends (stopped on message.completed / turn.completed;
// the failure path is backstopped by the keep-alive's own safety cap so we do
// not clobber Eve's default turn.failed / session.failed error handlers, which
// Eve does not export for chaining). See agent/lib/typing-keepalive.core.mjs.
import { telegramChannel } from "eve/channels/telegram";
import { splitIntoChatMessages } from "../lib/chat-split.core.mjs";
import { createTypingKeepalive } from "../lib/typing-keepalive.core.mjs";

const botUsername = (process.env["TELEGRAM_BOT_USERNAME"] ?? "").trim();

const typing = createTypingKeepalive();
const convoKey = (ctx: { session?: { id?: string } }) =>
  ctx?.session?.id ?? "telegram";

export default telegramChannel({
  botUsername,
  events: {
    "turn.started"(_data, channel, ctx) {
      typing.start(convoKey(ctx), () => channel.telegram.startTyping());
    },
    "turn.completed"(_data, _channel, ctx) {
      typing.stop(convoKey(ctx));
    },
    async "message.completed"(data, channel, ctx) {
      typing.stop(convoKey(ctx));
      if (data.finishReason === "tool-calls" || !data.message) return;
      const messages = splitIntoChatMessages(data.message);
      for (const [index, message] of messages.entries()) {
        if (index > 0) await channel.telegram.startTyping();
        await channel.telegram.post(message);
      }
    },
  },
});
