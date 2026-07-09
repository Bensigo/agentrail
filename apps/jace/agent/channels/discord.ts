// Jace's native Discord channel (#1050).
//
// Eve's first-class Discord integration: inbound interactions (signature-verified
// via the Ed25519 headers) AND outbound/proactive posting, deferred-response
// editing, and followups — all native. We do NOT hand-roll Discord webhooks or
// bot HTTP. The channel id is this file's name (`discord`), so Eve mounts the
// inbound endpoint at `/eve/v1/discord`.
//
// Self-host credentials come from the environment (no Vercel Connect required):
//   DISCORD_PUBLIC_KEY      — verifies X-Signature-Ed25519 + timestamp
//   DISCORD_APPLICATION_ID  — edits the deferred response / sends followups
//   DISCORD_BOT_TOKEN       — proactive messages + typing indicators
//
// NOTE: shape follows the eve@0.19.0 docs; boot behavior when the env is unset and
// live delivery are verified against the running sidecar (#1038/#1101), behind the
// per-workspace `jaceOwnsDiscordNotify` opt-in.
//
// `events["message.completed"]` overrides Eve's default handler (which posts
// the full reply as one message, splitting only at Discord's 2000-char hard
// limit) to instead split it into several bubbles on the model's own
// paragraph breaks — see agent/lib/chat-split.core.mjs for why, and
// instructions.md's "Voice and reply length" section for the model contract
// this relies on. The `finishReason`/`message` guard mirrors Eve's default
// exactly, so tool-call and empty-message turns behave unchanged.
import { discordChannel } from "eve/channels/discord";
import { splitIntoChatMessages } from "../lib/chat-split.core.mjs";

export default discordChannel({
  events: {
    async "message.completed"(data, channel) {
      if (data.finishReason === "tool-calls" || !data.message) return;
      const messages = splitIntoChatMessages(data.message);
      for (const [index, message] of messages.entries()) {
        if (index > 0) await channel.discord.startTyping();
        await channel.discord.post(message);
      }
    },
  },
});
