// Jace's native Slack channel (#1050).
//
// Eve's first-class Slack integration handles INBOUND events (app mentions,
// DMs, interactions — signature-verified via the Slack signing secret) — we
// do NOT hand-roll Slack's Events API or request signing. The channel id is
// this file's name (`slack`), so Eve mounts the inbound endpoint at
// `/eve/v1/slack` (unreachable in THIS hosted deployment, same as
// discord.ts's own native `/eve/v1/discord` route — see that file's header
// comment: every Slack turn here arrives via the cross-channel
// `args.receive(slack, { target, auth, message })` hand-off from
// `hosted-inbound.ts`/`run-outcome.ts`, never this native webhook).
//
// OUTBOUND POSTING IS NOT NATIVE ANYMORE (Task 4, docs/superpowers/specs/
// 2026-07-29-slack-multi-workspace-design.md §4). `SLACK_BOT_TOKEN` — the ONE
// shared bot token this file used to fall back to via eve's own
// `SlackChannelCredentials.botToken` env default — is GONE, deleted from
// apps/jace entirely, because Slack issues a SEPARATE bot token per
// workspace install and there is no safe way to pick the right one from
// inside this process:
//   - eve's `botToken` credential is a THUNK resolved with NO arguments,
//     bound once at `slackChannel()` construction time, process-wide — there
//     is no per-turn hook to swap in a different customer's token.
//   - `slackChannel().receive()` — the entry point every turn here actually
//     uses — HARDCODES `teamId: null` in the session state it seeds
//     (verified against eve@0.19.0's REAL compiled runtime,
//     apps/jace/.output/server/_libs/eve.mjs: `receive` always sets
//     `state:{channelId:i,threadTs:c||null,teamId:null,triggeringUserId:null}`
//     regardless of what `target` carries — `SlackReceiveTarget` has no field
//     for it at all), so `channel.state.teamId` can NEVER be trusted here.
//   - The only remaining route would be ambient context (e.g. an
//     AsyncLocalStorage set at webhook time), and that is unsafe too: eve's
//     `turnStep` runs on `@workflow/core`, which serializes, parks, and
//     resumes turns — an ambient value can be stale by the time a reply
//     posts, and stale here means posting one customer's reply with another
//     customer's bot token.
// So `message.completed` below no longer calls `channel.thread.post()` at
// all. It hands the reply back to the CONSOLE instead (mirroring
// `agent/channels/console.ts`'s own hand-back, and
// `agent/lib/console_chat_reply.core.mjs`'s injected-transport pattern) via
// `agent/lib/slack_reply.core.mjs`'s `postSlackReply` — the console resolves
// the INSTALLING team's own bot token (from `slack_installations`, per
// `getSlackInstallation`) and posts via `chat.postMessage`. The team id
// travels explicitly: `channel-dispatch.ts` carries it into
// `auth.attributes.teamId`, eve forwards `auth` unchanged into
// `ctx.session.auth.current`/`.initiator`, and `resolveSlackReplyTeamId`
// reads it back out here (current-preferred, mirroring
// `discord-followup.core.mjs`'s `resolveSessionAuthAttributes`). Destination
// (`channelId`/`threadTs`) still comes from `channel.state`, which IS
// reliable — it's seeded straight from `target.channelId`/`target.threadTs`
// at `receive()` time (see the compiled-runtime excerpt above), unlike
// `teamId`.
//
// COST, ACCEPTED (spec §4): eve's native Slack typing indicator
// (`channel.thread.startTyping(...)`, still called below in `turn.started`
// and between bubbles) now silently no-ops — `SlackThread.startTyping`
// swallows its own errors internally (verified against the same compiled
// runtime), so a missing bot token just means no typing status is shown,
// never a thrown/unhandled error. This is an accepted, documented loss, not
// a bug to chase — do not attempt to proxy it.
//
// SLACK_SIGNING_SECRET still verifies this file's native (unreachable, in
// this deployment) webhook signature — unrelated to outbound posting, and
// unaffected by SLACK_BOT_TOKEN's removal.
//
// NOTE: shape follows the eve@0.19.0 docs; boot behavior when the env is
// unset and live delivery are verified against the running sidecar
// (#1038/#1101), behind the per-workspace `jaceOwnsSlackNotify` opt-in —
// that legacy single-shared-bot proactive-notify path
// (apps/console/app/api/v1/runner/result/notify.ts's `notifySlackViaJace`)
// predates Task 4, carries no `teamId` in its own `auth.attributes`, and was
// ALREADY non-functional the moment `SLACK_BOT_TOKEN` is removed (its reply,
// like every other Slack reply, now goes through `postSlackReply`, which
// throws loudly on a missing team id — no worse than the token-less
// `channel.thread.post()` it replaces, which itself throws with no token
// configured). Fixing that legacy path is out of scope here; it predates and
// is unrelated to the multi-workspace install design.
//
// The message.completed handler's `finishReason`/`message` guard mirrors
// Eve's default exactly, so tool-call and empty-message turns behave
// unchanged.
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
import { postSlackReply, resolveSlackReplyTeamId } from "../lib/slack_reply.core.mjs";

// Stdlib `fetch`, narrowed to the `{ status }` shape slack_reply.core.mjs
// expects — mirrors console.ts's/discord.ts's identical `realTransport`
// idiom.
async function realTransport(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
): Promise<{ status: number }> {
  const res = await fetch(url, init);
  return { status: res.status };
}

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
    async "message.completed"(data, channel, ctx) {
      if (data.finishReason === "tool-calls" || !data.message) return;
      // Task 4: the ONLY place this turn's Slack team id can safely come
      // from — see the header comment above for why `channel.state.teamId`
      // is always null and must never be read here instead.
      const teamId = resolveSlackReplyTeamId(ctx?.session?.auth);
      const messages = splitIntoChatMessages(data.message);
      for (const [index, message] of messages.entries()) {
        if (index > 0) await channel.thread.startTyping();
        await postSlackReply({
          teamId,
          channelId: channel.state.channelId ?? "",
          threadTs: channel.state.threadTs ?? undefined,
          text: message,
          env: process.env,
          transport: realTransport,
        });
      }
    },
  },
});
