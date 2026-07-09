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
// `events["message.completed"]` overrides Eve's default handler (which posts
// the full reply as one message to the thread) to instead split it into
// several bubbles on the model's own paragraph breaks — see
// agent/lib/chat-split.core.mjs for why, and instructions.md's "Voice and
// reply length" section for the model contract this relies on. The
// `finishReason`/`message` guard mirrors Eve's default exactly, so tool-call
// and empty-message turns behave unchanged. Delivery goes through
// `channel.thread` (not `channel.slack`), matching Eve's own docs example —
// `thread` owns the thread-scoped post/startTyping operations.
import { slackChannel } from "eve/channels/slack";
import { splitIntoChatMessages } from "../lib/chat-split.core.mjs";

export default slackChannel({
  events: {
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
