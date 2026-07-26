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
// PROD BUG FIX (root-caused 2026-07-25, see .superpowers/sdd/discord-followup/;
// hardened 2026-07-26 against a follow-up adversarial review, same doc dir,
// fix-1-brief.md):
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
// app/api/v1/connectors/discord/webhook/route.ts) inside `auth.attributes`.
// eve forwards that `auth` UNCHANGED into BOTH `ctx.session.auth.current`
// (refreshed on every subsequent turn) AND `ctx.session.auth.initiator` (set
// ONCE, at session start, never updated again) — verified against
// eve@0.19.0's REAL COMPILED RUNTIME, apps/jace/.output/server/_libs/eve.mjs
// (`.d.ts` type stubs alone don't show this distinction — reading them
// instead of the runtime is exactly how an earlier version of this fix read
// `initiator` and broke on a session's 2nd+ turn: a Discord conversation
// keeps reusing the SAME eve session via `bindEveSession`, so past turn 1
// `initiator` holds a stale, likely-expired interaction token forever).
// `resolveSessionAuthAttributes` (agent/lib/discord-followup.core.mjs) reads
// `current` first, falling back to `initiator` — identical on turn 1,
// correct on every turn after. `deliverDiscordReply`/`deliverDiscordBubble`
// (same module) hold the pure decide/build-URL/chunk/fall-back logic: when a
// credential is available, they POST straight to Discord's interaction
// followup webhook, chunked at 2000 chars with mentions suppressed (needs no
// channel permission, no auth header — the token IS the credential); on a
// missing credential, a followup failure (non-2xx, or the 15-minute window
// expired), or a transport-level throw, they fall back to the existing
// `channel.discord.post()` call unchanged, so every case that already works
// today keeps working — logging the numeric HTTP status + Discord error code
// on that fallback (never the token, never the URL) so a broken followup
// path is visible instead of silently indistinguishable from the original
// bug.
//
// `events["turn.started"]` overrides Eve's default one-shot `startTyping()`
// with a keep-alive (spec: docs/superpowers/specs/2026-07-26-discord-gateway-listener-design.md
// "Reply path" — Discord expires a typing indicator after ~10s, so on a slow
// model the chat looks dead for the rest of a 30s-2min turn). Mirrors
// telegram.ts's identical use of the SAME agent/lib/typing-keepalive.core.mjs
// (stopped on message.completed / turn.completed; the failure path is
// backstopped by the keep-alive's own safety cap, since eve does not export
// its default turn.failed / session.failed handlers for chaining — same
// rationale as telegram.ts's own header comment). This benefits BOTH reply
// paths equally: an interaction-backed session (channel.discord.startTyping()
// posts via the interaction token) and a Gateway-`receive()`-triggered
// session with no interaction token at all (posts via the Bot API directly —
// see agent/lib/discord-gateway.mjs's header comment on the reply path) both
// go through this same `channel.discord.startTyping()` call.
import { discordChannel } from "eve/channels/discord";
import { splitIntoChatMessages } from "../lib/chat-split.core.mjs";
import {
  deliverDiscordReply,
  resolveSessionAuthAttributes,
} from "../lib/discord-followup.core.mjs";
import { createTypingKeepalive } from "../lib/typing-keepalive.core.mjs";

/** Raw fetch, narrowed to the `{ status, body }` shape discord-followup.core.mjs
 * expects — mirrors every jace->external-API wrapper's own `realTransport`
 * idiom (e.g. console.ts, imessage.ts). Always drains the response body (a
 * non-2xx left unread otherwise leaves the undici connection un-freed) and
 * best-effort parses it as JSON so a fallback can log Discord's small
 * numeric `error.code` (fix-1-brief.md finding 4) — this function never logs
 * anything itself, and never returns anything derived from `url`/`init`
 * (which embed the interaction token). */
async function followupTransport(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
): Promise<{ status: number; body?: unknown }> {
  const res = await fetch(url, init);
  const text = await res.text().catch(() => "");
  let body: unknown;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }
  return { status: res.status, body };
}

const typing = createTypingKeepalive();
const convoKey = (ctx: { session?: { id?: string } }) =>
  ctx?.session?.id ?? "discord";

export default discordChannel({
  events: {
    "turn.started"(_data, channel, ctx) {
      typing.start(convoKey(ctx), () => channel.discord.startTyping());
    },
    "turn.completed"(_data, _channel, ctx) {
      typing.stop(convoKey(ctx));
    },
    async "message.completed"(data, channel, ctx) {
      typing.stop(convoKey(ctx));
      if (data.finishReason === "tool-calls" || !data.message) return;
      const attributes = resolveSessionAuthAttributes(ctx?.session?.auth);
      await deliverDiscordReply({
        text: data.message,
        attributes,
        postFollowup: followupTransport,
        postViaBot: (message) => channel.discord.post(message),
        startTyping: () => channel.discord.startTyping(),
        splitMessage: splitIntoChatMessages,
      });
    },
  },
});
