// Jace's native Slack channel (#1050).
//
// Eve's first-class Slack integration: inbound events (app mentions, DMs,
// interactions — signature-verified via the Slack signing secret) AND
// outbound/proactive posting into repliable threads, all native. We do NOT
// hand-roll Slack's Events API, request signing, or Web API calls. The channel
// id is this file's name (`slack`), so Eve mounts the inbound endpoint at
// `/eve/v1/slack`.
//
// Self-host credentials come from the environment (no Vercel Connect required).
// Per the eve@0.19.0 `SlackChannelCredentials` type, `slackChannel()` falls back
// to these when no explicit credentials are passed — the same env-based shape as
// the telegram/discord channels here:
//   SLACK_BOT_TOKEN      — the bot user OAuth token (`xoxb-…`) for proactive
//                          posts + Web API calls. (SlackChannelCredentials.botToken
//                          "Falls back to process.env.SLACK_BOT_TOKEN when omitted".)
//   SLACK_SIGNING_SECRET — verifies inbound request signatures.
//                          (SlackChannelCredentials.signingSecret "Falls back to
//                          process.env.SLACK_SIGNING_SECRET" when neither it nor a
//                          webhookVerifier is supplied.)
// Point Slack's Event Subscriptions + Interactivity request URLs at
// `https://<host>/eve/v1/slack` (see apps/jace/README.md).
//
// Vercel Connect (`connectSlackCredentials`) would only be needed for out-of-band
// webhook verification / per-installation token resolution in a hosted
// multi-tenant deployment; it is a one-line `credentials:` swap and is out of
// scope for the current single-shared-bot, per-workspace-cutover model.
//
// NOTE: shape follows the eve@0.19.0 docs; boot behavior when the env is unset and
// live delivery are verified against the running sidecar (#1038/#1101), behind the
// per-workspace `jaceOwnsSlackNotify` opt-in.
//
// The message.completed handler overrides Eve's default handler (which posts
// the full reply as one message to the thread) to instead split it into
// several bubbles on the model's own paragraph breaks — see
// agent/lib/chat-split.core.mjs for why, and instructions.md's "Voice and
// reply length" section for the model contract this relies on. The
// `finishReason`/`message` guard mirrors Eve's default exactly, so tool-call
// and empty-message turns behave unchanged. Delivery goes through
// `channel.thread` (not `channel.slack`), matching Eve's own docs example —
// `thread` owns the thread-scoped post/startTyping operations.
//
// Slack is the ONE ack-less channel, on purpose. telegram/discord/console arm
// agent/lib/ack-on-work.core.mjs from `actions.requested` to post a short line
// naming the work in flight; Slack does not, because eve's own default
// `actions.requested` ALREADY does the equivalent natively and better — it sets
// the thread typing status to `Running <toolName, ...>...`, live and per-step,
// with no thread clutter. Overriding it to add our own message would mean
// reproducing that default here (Slack resolves one handler per event, see
// below), and its status text runs through `truncateTypingStatus` /
// `stripTypingStatusMarkdown` from #public/channels/slack/limits.js — helpers
// eve does NOT re-export from `eve/channels/slack`. Hand-copying that regex into
// our tree buys a duplicate of a signal Slack already shows, and silently rots
// the day eve changes it. So: leave the default alone and declare no
// `actions.requested` handler here.
//
// eve's slackChannel resolves ONE handler per event — roughly
// `events[eventName] ?? defaultEvents[eventName]` — rather than chaining
// ours over its default the way telegram/discord merge
// `{...defaultEvents, ...events}` — so declaring our own turn.started here
// REPLACES eve's default rather than adding to it. That default (verified
// against eve@0.19.0's REAL compiled runtime,
// apps/jace/.output/server/_libs/eve.mjs — search defaultEvents' entry for
// this same event) does four things: clears `state.pendingToolCallMessage`,
// `state.lastReasoningTypingAtMs`, and `state.lastReasoningTypingStatus`,
// then posts "Working..." typing. Losing that clear makes the still-default
// `reasoning.appended` handler wrongly suppress the first reasoning status of
// a new turn whenever the previous turn ended under 5s ago (it compares
// against the stale `lastReasoningTypingAtMs`), and losing the "Working..."
// call drops the per-turn typing status entirely on the proactive
// `receive()` path. Reproduced below rather than skipped.
import { slackChannel } from "eve/channels/slack";
import { splitIntoChatMessages } from "../lib/chat-split.core.mjs";

export default slackChannel({
  events: {
    async "turn.started"(_data, channel) {
      // Reproduce eve's default turn.started (see the header comment above)
      // since declaring this handler replaces it rather than chaining over
      // it.
      channel.state.pendingToolCallMessage = null;
      channel.state.lastReasoningTypingAtMs = null;
      channel.state.lastReasoningTypingStatus = null;
      await channel.thread.startTyping("Working...");
    },
    // No "turn.completed" handler: it existed only to disarm the ack, and eve
    // declares no slack default for it, so nothing is shadowed by its absence.
    async "message.completed"(data, channel) {
      if (data.finishReason === "tool-calls" || !data.message) return;
      const messages = splitIntoChatMessages(data.message);
      for (const [index, message] of messages.entries()) {
        if (index > 0) await channel.thread.startTyping();
        await channel.thread.post(message);
      }
    },
  },
});
