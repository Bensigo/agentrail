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
// These three are passed to `discordChannel({ credentials })` EXPLICITLY
// below — do not remove that and rely on env alone (review finding C1).
// eve's docs (node_modules/eve/docs/channels/discord.mdx) and api.d.ts both
// document a same-named env-var fallback inside resolveDiscordBotToken /
// resolveDiscordApplicationId / resolveDiscordPublicKey, but reading the
// INSTALLED COMPILED runtime (node_modules/eve/dist/src/public/channels/
// discord/{api,discordChannel}.js) shows only applicationId and publicKey
// actually reach their fallback (both are called unconditionally). botToken's
// fallback is DEAD CODE: callDiscordApi only calls resolveDiscordBotToken
// (where `?? process.env.DISCORD_BOT_TOKEN` lives) inside
// `if (e.botToken !== void 0)` — so with no `credentials.botToken` passed,
// that branch never runs and no Authorization header is ever set, for ANY
// call (sendDiscordChannelMessage, triggerDiscordTypingIndicator, and
// `request()` with `botAuth: true`), env var set or not. A Gateway-sourced
// session (agent/lib/discord-gateway.mjs) has no interaction token, so its
// post() always takes the botToken-requiring sendViaChannel path — omitting
// `credentials` here means every such reply goes out unauthenticated (401)
// and the user gets nothing, not even a typing indicator. Verified by
// executing eve's own compiled functions with the env var set and observing
// `auth: null` — trust the compiled source over the docs/api.d.ts if they
// ever disagree again; this exact gap has now caused two bugs in this arc.
//
// NOTE: shape follows the eve@0.19.0 docs; boot behavior when the env is unset and
// live delivery are verified against the running sidecar (#1038/#1101), behind the
// per-workspace `jaceOwnsDiscordNotify` opt-in.
//
// The message.completed handler overrides Eve's default handler (which posts
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
// The turn.started handler overrides Eve's default one-shot `startTyping()`
// with a keep-alive (spec: docs/superpowers/specs/2026-07-26-discord-gateway-listener-design.md
// "Reply path" — Discord expires a typing indicator after ~10s, so on a slow
// model the chat looks dead for the rest of a 30s-2min turn). Refreshed here
// every 8000ms — comfortably under Discord's ~10s expiry, but NOT the
// keep-alive module's own 4000ms default, which is tuned to Telegram's much
// shorter ~5s expiry (see typing-keepalive.core.mjs); leaving Discord on that
// default would fire ~2.5x the /typing calls Discord actually needs. Mirrors
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
  deliverDiscordBubble,
  deliverDiscordReply,
  resolveSessionAuthAttributes,
} from "../lib/discord-followup.core.mjs";
import { recordDeliveredChannelReply } from "../lib/acceptance_intake_reply.core.mjs";
import { createTypingKeepalive } from "../lib/typing-keepalive.core.mjs";
import {
  createAckOnWork,
  workPhraseFor,
  isProactiveTurn,
} from "../lib/ack-on-work.core.mjs";

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

const typing = createTypingKeepalive({ refreshMs: 8000 });
const ack = createAckOnWork();
const convoKey = (ctx: { session?: { id?: string } }) =>
  ctx?.session?.id ?? "discord";

export default discordChannel({
  credentials: {
    botToken: process.env["DISCORD_BOT_TOKEN"],
    applicationId: process.env["DISCORD_APPLICATION_ID"],
    publicKey: process.env["DISCORD_PUBLIC_KEY"],
  },
  events: {
    "turn.started"(_data, channel, ctx) {
      const key = convoKey(ctx);
      typing.start(key, () => channel.discord.startTyping());
    },
    "actions.requested"(data, channel, ctx) {
      // Real work just started, and the payload names it. One-shot per turn.
      // Delivered on the same interaction-followup path message.completed uses
      // — a bare channel.discord.post() silently eats 50001 in private channels
      // (the #1463 bug). Skipped entirely for a Jace-initiated turn
      // (run-outcome.ts's hand-off) — see ack-on-work.core.mjs's
      // isProactiveTurn: those turns call tools too, and there is no human
      // message behind them to acknowledge.
      if (isProactiveTurn(ctx?.session?.auth)) return;
      const phrase = workPhraseFor(data.actions);
      if (!phrase) return;
      ack.arm(convoKey(ctx), data.turnId, () =>
        deliverDiscordBubble({
          content: phrase,
          attributes: resolveSessionAuthAttributes(ctx?.session?.auth),
          postFollowup: followupTransport,
          postViaBot: () => channel.discord.post(phrase),
        }),
      );
    },
    "turn.completed"(_data, _channel, ctx) {
      const key = convoKey(ctx);
      typing.stop(key);
      ack.stop(key);
    },
    async "message.completed"(data, channel, ctx) {
      // Both stops sit below the guard — see telegram.ts's identical comment.
      if (data.finishReason === "tool-calls" || !data.message) return;
      const key = convoKey(ctx);
      typing.stop(key);
      ack.stop(key);
      const attributes = resolveSessionAuthAttributes(ctx?.session?.auth);
      await deliverDiscordReply({
        text: data.message,
        attributes,
        postFollowup: followupTransport,
        postViaBot: (message) => channel.discord.post(message),
        startTyping: () => channel.discord.startTyping(),
        splitMessage: splitIntoChatMessages,
      });
      await recordDeliveredChannelReply({ session: ctx?.session, channel: "discord", text: data.message, env: process.env, transport: fetch });
    },
  },
});
