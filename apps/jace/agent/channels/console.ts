// Jace's console-chat channel (#1288) — the AgentRail dashboard's own
// in-house "platform". Unlike telegram/discord/slack/imessage there is no
// external provider to integrate: a workspace member's message arrives via
// the console's own authenticated send endpoint
// (app/api/v1/workspaces/[workspaceId]/chat/route.ts), which enqueues it
// into `channel_inbox` (channel: "console") exactly like every other
// channel's webhook does. The console's dispatcher then claims that row
// (`channel-dispatch.ts`'s `processConsoleRow`, which deliberately SKIPS the
// chat-identity spine — a console sender is already an authenticated,
// membership-checked workspace member, not a stranger to resolve) and POSTs
// to the hosted-inbound door with `channel: "console"` and a COMPOUND
// `{ workspaceId, conversationKey }` target (see
// `agent/lib/hosted_inbound.core.mjs`'s console branch) — the SAME
// `args.receive(module, ...)` cross-channel hand-off every other channel
// rides (`agent/channels/hosted-inbound.ts`'s CHANNELS map).
//
// Jace's reply posts back through `events["message.completed"]` below by
// calling the console's OWN `POST /api/v1/runner/chat-reply` endpoint
// (`agent/lib/console_chat_reply.core.mjs`) — an authenticated HTTP call,
// not a direct DB write: apps/jace is deliberately EXCLUDED from this repo's
// pnpm workspace (see the root `package.json`'s `workspaces` array), so it
// has no access to `@agentrail/db-postgres` the way apps/console does. This
// mirrors every other channel's OWN post (`channel.telegram.post()`,
// `channel.discord.post()`, LoopMessage's Send API for iMessage) — console
// chat just has no external platform of its own to post to, so it posts
// back to the one place that reads jace_messages: the console itself. The
// console's OWN `/chat` GET route (polling) is what a workspace member's
// browser actually sees.
//
// Console has no native inbound webhook of its own; it is ONLY ever reached
// via the cross-channel `receive()` hand-off above. This mirrors imessage.ts's
// fully-custom (non-platform) `defineChannel` shape most closely of the
// existing channels, since — like iMessage — console has no first-class Eve
// integration to build on; unlike iMessage, it has no genuine inbound HTTP
// surface at all (LoopMessage at least receives webhooks).
//
// PROD BUG FIX (#1288 cross-service reply bug, root-caused after the Railway
// networking fix landed): this channel used to declare `routes: []`, which
// made `hosted-inbound.ts`'s `args.receive(console_, ...)` throw
// `args.receive(): the channel passed as the first argument is not
// registered in this agent's channels/` on EVERY console turn — Jace saved
// the member's message but never replied. Root cause, traced through
// eve@0.19.0's installed `channel/cross-channel-receive.js`:
// `resolveTargetByReference` first tries to find the passed-in module by
// OBJECT REFERENCE among the channels Eve's compiled-artifacts graph
// registered; only when that fails does it fall back to
// `resolveTargetByRouteFingerprint`, matching by the channel's sorted
// `METHOD path` route set. A route-less channel can ONLY ever be found by
// reference (`createRouteFingerprint` explicitly returns `null` when
// `routes.length === 0`, so the fallback is a no-op for it) — and in a
// bundled/serverless deployment (Nitro-based; see the `internal/nitro/`
// tree in eve's dist) each route can be compiled as its own isolated entry
// point, so `hosted-inbound.ts`'s imported `console_` reference is not
// guaranteed to be the SAME module instance the graph registered for
// "console", and reference equality silently fails. The single stub route
// below exists ONLY to give this channel a non-empty, UNIQUE route
// fingerprint so the documented fallback can find it — see the
// `routes` array's own comment. It carries no real inbound contract: console
// chat is still driven exclusively by the `receive()` hand-off above.
//
// NOTE: `defineChannel` shape follows the eve@0.19.0 docs (custom channels
// guide, "Cross-channel hand-off" + "Define a channel" sections).
import { defineChannel, POST } from "eve/channels";
import { postConsoleChatReply } from "../lib/console_chat_reply.core.mjs";

type ConsoleState = { workspaceId: string; conversationKey: string; model?: string };

/** Trim a possibly-non-string value to a string ("" when not a string). */
function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Stdlib `fetch`, narrowed to the `{ status }` shape console_chat_reply.core.mjs
// expects — mirrors every jace->console tool wrapper's own `realTransport`
// idiom (e.g. create_workspace.ts, fetch_workspace_memory.ts).
async function realTransport(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
): Promise<{ status: number }> {
  const res = await fetch(url, init);
  return { status: res.status };
}

const initialState: ConsoleState = { workspaceId: "", conversationKey: "" };

export default defineChannel<ConsoleState>({
  kindHint: "console",
  state: initialState,
  routes: [
    // NOT a real inbound surface — see the header comment above. This exists
    // solely so this channel has a non-empty, UNIQUE route fingerprint (the
    // sorted `METHOD path` set eve@0.19.0's `resolveTargetByRouteFingerprint`
    // matches on) for `args.receive(console_, ...)` to find it by when the
    // bundler-time object-reference match fails. Nothing should ever call
    // this path; if something does, it does nothing and answers 404.
    POST("/eve/v1/console-handoff", async () => new Response(null, { status: 404 })),
  ],
  context(state: ConsoleState) {
    return { state };
  },
  async receive(input, { send }) {
    // Cross-channel hand-off target for the console dispatcher
    // (`channel-dispatch.ts`'s `processConsoleRow` -> `runEveTurn`). Both
    // fields are required — see `hosted_inbound.core.mjs`'s console branch,
    // which already validates this before this route is ever reached; this
    // check is defense in depth, not the primary gate.
    const workspaceId = readString(input.target?.workspaceId);
    const conversationKey = readString(input.target?.conversationKey);
    if (!workspaceId || !conversationKey) {
      throw new Error(
        "console.receive requires target.workspaceId and target.conversationKey.",
      );
    }
    // The gateway model id the sender picked (#1288), merged onto the target by
    // hosted-inbound.ts. Observational only — the turn runs on THIS instance's
    // boot model; the console dispatcher routes to a differently-pinned Jace
    // host to actually switch models. Optional; blank/absent => undefined.
    const model = readString(input.target?.model) || undefined;
    const state: ConsoleState = { workspaceId, conversationKey, ...(model ? { model } : {}) };
    return send(input.message, {
      auth: input.auth,
      continuationToken: conversationKey,
      state,
    });
  },
  events: {
    async "message.completed"(data, channel) {
      if (data.finishReason === "tool-calls" || !data.message) return;
      // Unlike telegram/discord/imessage, no bubble-splitting here: console
      // chat is a scrolling dashboard thread (one row per completed turn),
      // not a cadence-sensitive chat app — chat-split.core.mjs's paragraph
      // splitter exists for those platforms' human-texting feel, which does
      // not apply to a polled web UI.
      await postConsoleChatReply({
        workspaceId: channel.state.workspaceId,
        conversationKey: channel.state.conversationKey,
        text: data.message,
        env: process.env,
        transport: realTransport,
      });
    },
  },
});
