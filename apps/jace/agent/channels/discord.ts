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
//
// PROD BUG FIX (root-caused 2026-07-25, see .superpowers/sdd/discord-followup/):
// this hosted-shared-bot deployment routes EVERY discord message through the
// console's own hand-rolled interactions webhook + the cross-channel
// `args.receive(discord, { target: { channelId }, auth, message })` hand-off
// (apps/jace/agent/channels/hosted-inbound.ts) — this channel's own native
// `/eve/v1/discord` inbound route never fires. That means Eve's internal
// per-session `DiscordChannelState.interactionToken`/`.applicationId` are
// always null here (the proactive `DiscordReceiveTarget` shape eve exposes
// for `receive()` is `{ channelId, conversationId?, initialMessage? }` only —
// verified against eve@0.19.0's own discordChannel.d.ts — there is no room in
// `target` for either field), so `channel.discord.post()` always falls back
// to a Bot-API channel message, which needs View Channel + Send Messages on
// that specific channel. A private channel that hasn't granted the shared
// bot's role that permission (or a user-install where the bot isn't in the
// guild at all) gets `50001 Missing Access`, silently swallowed — the user's
// own slash-command invocation still "works" because it's authorized by the
// USER's permissions, not the bot's.
//
// The fix: apps/console/lib/channel-dispatch.ts's `buildDoorInitiatorAuth`
// now carries the ORIGINAL interaction's `interactionToken`/`applicationId`
// (captured at the console's inbound webhook,
// app/api/v1/connectors/discord/webhook/route.ts) inside `auth.attributes` —
// the ONE field eve forwards UNCHANGED into `ctx.session.auth.initiator`
// (verified against eve@0.19.0's SessionAuthContext/SessionContext type
// declarations), which every channel event handler can read via the 3rd
// `ctx` argument. `deliverDiscordBubble` (agent/lib/discord-followup.core.mjs)
// holds the pure decide/build-URL/fall-back logic: when a credential is
// available, it POSTs straight to Discord's interaction followup webhook
// (needs no channel permission, no auth header — the token IS the
// credential); on a missing credential OR ANY followup failure (non-2xx, or
// the 15-minute window expired), it falls back to the existing
// `channel.discord.post()` call unchanged, so every case that already works
// today keeps working.
import { discordChannel } from "eve/channels/discord";
import { splitIntoChatMessages } from "../lib/chat-split.core.mjs";
import { deliverDiscordBubble } from "../lib/discord-followup.core.mjs";

/** Raw fetch, narrowed to the `{ status }` shape discord-followup.core.mjs
 * expects — mirrors every jace->external-API wrapper's own `realTransport`
 * idiom (e.g. console.ts, imessage.ts). */
async function followupTransport(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
): Promise<{ status: number }> {
  const res = await fetch(url, init);
  return { status: res.status };
}

export default discordChannel({
  events: {
    async "message.completed"(data, channel, ctx) {
      if (data.finishReason === "tool-calls" || !data.message) return;
      const attributes = ctx?.session?.auth?.initiator?.attributes;
      const messages = splitIntoChatMessages(data.message);
      for (const [index, message] of messages.entries()) {
        if (index > 0) await channel.discord.startTyping();
        await deliverDiscordBubble({
          content: message,
          attributes,
          postFollowup: followupTransport,
          postViaBot: () => channel.discord.post(message),
        });
      }
    },
  },
});
