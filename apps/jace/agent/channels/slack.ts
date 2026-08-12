// Jace's native Slack channel (#1050).
//
// THIS FILE MAKES ZERO SLACK API CALLS, on purpose. Every workspace has its
// OWN bot token (`slack_installations`), the console is the only process
// that resolves the right one, and `SLACK_BOT_TOKEN` was deleted from this
// service entirely (see the Task 4 section below). eve's `slackChannel()`
// resolves exactly ONE handler per event — `events[name] ?? defaultEvents
// [name]` (see slackChannel.js's `m = {...defaultEvents, ...e.events, ...}`
// merge) — never both. That means leaving even ONE event undeclared here
// silently reinstates eve's Slack default for it, and several of those
// defaults call the Slack Web API directly and UNCAUGHT (`channel.thread
// .post(...)` with no try/catch — verified against the installed
// node_modules/eve/dist/src/public/channels/slack/defaults.js, the REAL
// compiled source, not the docs or the `.d.ts`, which have disagreed with
// runtime behavior before in this repo). With no bot token configured,
// that throws `Error: SLACK_BOT_TOKEN is required.` out of `resolveSlack
// BotToken`, uncaught, and kills the turn — this is the exact outage that
// prompted this file's rewrite: `turn.failed`/`session.failed`/`input
// .requested` were never overridden, so their un-overridden Slack defaults
// fired on every single turn and threw. Every event key eve's Slack channel
// can resolve a default for is declared below — as a no-op, or as a
// console-routed equivalent — so upgrading eve and getting a new default
// handler for a not-yet-declared event silently re-opens this exact trap
// (see the invariant test, slack-channel.test.mjs, which is built to fail
// loudly instead).
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
// TYPING INDICATORS ARE GONE, NOT JUST SILENCED. An earlier version of this
// file kept calling `channel.thread.startTyping(...)` in `turn.started` and
// between reply bubbles, reasoning that `SlackThread.startTyping` swallows
// its own errors internally (true — verified in the same compiled `api.js`:
// it wraps its one Slack call in try/catch and only logs). That reasoning
// was correct but insufficient: swallowing the error doesn't stop the call
// from being ATTEMPTED, and with no bot token every attempt fails and logs
// noise for nothing. Both calls are removed below, not just left in as an
// "accepted, silent" cost.
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
    // --- Every key below overrides one of eve's Slack DEFAULT event
    // handlers (or the separately-exported `input.requested` default
    // factory) so eve's own version never runs. See this file's header for
    // why an un-overridden default is a live outage risk, not a theoretical
    // one.

    async "turn.started"() {
      // eve's default: resets `state.pendingToolCallMessage`,
      // `.lastReasoningTypingAtMs`, `.lastReasoningTypingStatus`, then posts
      // a "Working..." typing status via `channel.thread.startTyping(...)`.
      // `startTyping` swallows its own errors (see header), so this default
      // would not have THROWN — but it would still attempt (and always
      // fail) a Slack Web API call with no bot token, exactly the I/O this
      // file exists to never perform. No-op, including the state resets:
      // they exist only to feed the `reasoning.appended`/`actions.requested`
      // defaults, which are also no-op'd below and never read them.
    },

    async "reasoning.appended"() {
      // eve's default: `channel.thread.startTyping(...)` per streamed
      // reasoning delta. Same startTyping-swallows-but-still-tries
      // reasoning as turn.started above. No-op.
    },

    async "actions.requested"() {
      // eve's default: `channel.thread.startTyping("Running <tool>...")`.
      // Same reasoning as turn.started above. No-op.
    },

    // THE reply. Unchanged from before except the between-bubbles
    // `channel.thread.startTyping()` call is removed (see header) —
    // splitting still happens, delivery still goes through the console.
    async "message.completed"(data, channel, ctx) {
      if (data.finishReason === "tool-calls" || !data.message) return;
      // Task 4: the ONLY place this turn's Slack team id can safely come
      // from — see the header comment above for why `channel.state.teamId`
      // is always null and must never be read here instead.
      const teamId = resolveSlackReplyTeamId(ctx?.session?.auth);
      const messages = splitIntoChatMessages(data.message);
      for (const message of messages) {
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

    // eve's default calls `channel.thread.post(...)` UNCAUGHT (verified:
    // defaults.js's `"turn.failed"` has no try/catch around its post) — this
    // is the exact throw that killed prod turns (see header). `ctx` IS
    // available here (unlike `session.failed` below), so the failure notice
    // CAN be routed through the console the same way the reply is. Wrapped
    // in its own try/catch: a failure to DELIVER the failure notice (no
    // teamId, console unreachable, etc.) must never itself throw and mask
    // the turn's real error — same defensive shape as
    // `telegram.ts`'s `onMessage` wrapping its own failure-notice post.
    async "turn.failed"(data, channel, ctx) {
      try {
        const teamId = resolveSlackReplyTeamId(ctx?.session?.auth);
        await postSlackReply({
          teamId,
          channelId: channel.state.channelId ?? "",
          threadTs: channel.state.threadTs ?? undefined,
          text: [
            `I hit an error while handling your request (${data.code}): ${data.message}`,
            "",
            "Please try again, rephrase, or reach out if it keeps failing.",
          ].join("\n"),
          env: process.env,
          transport: realTransport,
        });
      } catch (err) {
        console.error("[slack] turn.failed: could not deliver failure notice", err);
      }
    },

    // eve's default ALSO calls `channel.thread.post(...)` uncaught — same
    // bug shape as turn.failed. Unlike turn.failed, though, `session.failed`
    // handlers receive NO `ctx` (`SessionContext`) at all — verified against
    // eve@0.19.0's `SlackSessionFailedHandler`/`ChannelSessionFailedHandler`
    // types, which drop the third parameter entirely for this one event —
    // and `channel.state.teamId` is unusable here for the same reason it's
    // unusable in `message.completed` (eve hardcodes it to `null` at
    // `receive()`). There is NO available, trustworthy source for the Slack
    // team id in this handler, so there is no safe way to route this
    // through the console: `postSlackReply` refuses to post without one,
    // and guessing would risk posting into the wrong workspace with the
    // wrong bot token — the exact cross-tenant leak Task 4 exists to
    // prevent. Deliberate trade-off, not an oversight: Slack users get NO
    // failure notice when a whole SESSION (not just one turn) fails.
    // `turn.failed` above covers the far more common per-turn failure path.
    async "session.failed"() {},

    // eve's default already wraps every `thread.post`/`postEphemeral` call
    // in its own try/catch and logs rather than throws (verified:
    // defaults.js's `"authorization.required"`) — it did NOT cause this
    // outage. It also has no public `thread.post` escape hatch available to
    // an override at all (only `postEphemeral`/`postDirectMessage` — see
    // eve's `SlackAuthorizationEventContext`), so there is no console-routed
    // equivalent to build here even if we wanted one. No-op, for the
    // zero-Slack-I/O rule this file documents, not because it was unsafe.
    async "authorization.required"() {},

    // Same shape as authorization.required: eve's default wraps its one
    // `slack.request("chat.update", ...)` call in try/catch and logs, not
    // throws. No-op for the zero-I/O rule, not for safety.
    async "authorization.completed"() {},

    // NOT part of eve's `defaultEvents` map — `input.requested`'s default
    // comes from the separately-exported `defaultInputRequestedHandler()`
    // factory, resolved the exact same `events["input.requested"] ??
    // defaultInputRequestedHandler()` way (verified: slackChannel.js's
    // `m` construction). Its handler posts via `channel.thread.post(...)`
    // UNCAUGHT — same bug shape as message.completed's old bug. Jace's
    // Slack turns don't use HITL input requests today; no-op rather than
    // building an unused console round trip for a path that never fires.
    "input.requested": async () => {},
  },
});
