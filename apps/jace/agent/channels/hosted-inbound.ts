// Jace's hosted-inbound DOOR channel (#1262 PR ②; generalized to every
// hosted-shared-bot channel by #1284/#1285) — the AgentRail console's
// dispatcher target. A stranger's DM/message to a shared bot (Telegram,
// Discord, Slack) lands in `channel_inbox` via the console's webhook (PR ①
// per channel); the console's dispatcher then claims that row, resolves
// conversation -> workspace via the #1261 identity spine, and POSTs here so
// the message becomes a real Eve turn.
//
// This is a CUSTOM Eve channel (`defineChannel`) whose single route hands the
// message to the native channel module (telegram/discord/slack, selected by
// the normalized `channel` field — same CHANNELS-map convention as
// `run-outcome.ts` uses for the OUTBOUND direction) via `args.receive(module,
// { message, target, auth })` — the documented cross-channel hand-off. The
// route below is declared at the literal path `/eve/v1/hosted-inbound` —
// routes mount at the literal declared path; /eve/v1/<id> is an adapter
// default, not a framework rewrite, so the channel id alone does NOT
// determine the mount path (a bare "/" would be unreachable here).
//
// Unlike run-outcome.ts (which fires-and-forgets under `waitUntil` because the
// console only wants the request to survive, not a synchronous result), this
// route AWAITS `args.receive(...)`. `receive()` resolves to a `Session`
// `{ id, continuationToken }` at DISPATCH TIME — fast, because the turn itself
// continues as a durable workflow and the Telegram reply posts later through
// Eve's own sender when `message.completed` fires (see
// annex-eve-internals.md). The console's dispatcher needs that `sessionId`
// synchronously to write its `jace_sessions` ledger row
// (`bindEveSession`), which is the entire reason this route awaits rather
// than fires-and-forgets.
//
// Auth posture: same internal-trust level as run-outcome.ts (no header check)
// — EVE_HOST is an internal-network-only address, never exposed publicly;
// hardening this boundary is explicitly deferred to a later wave.
//
// Kept thin on purpose: no DB, no parsing beyond validation, no
// channel-specific logic besides selecting the module and passing `target`
// through. All validation/normalization is in the pure, unit-tested
// `agent/lib/hosted_inbound.core.mjs`; this wrapper only calls `receive`.
//
// NOTE: `defineChannel`/`POST`/`args.receive` shape follows the eve@0.19.0
// docs (verified against the installed `eve` package's own .d.ts files);
// receive-vs-post delivery semantics are documented in annex-eve-internals.md.
// `auth` is forwarded to `args.receive` as a loosely-typed object rather than
// eve's `SessionAuthContext` — that type is not part of eve's public
// `eve/channels` export surface (only reachable via eve's internal `#channel/
// types.js` path), so run-outcome.ts accepts the exact same looseness for its
// own `auth` field; apps/jace has no typecheck CI gate today (only
// `node --test`), so this mirrors an already-accepted repo convention rather
// than introducing a new one.
import { defineChannel, POST } from "eve/channels";
import { normalizeHostedInbound } from "../lib/hosted_inbound.core.mjs";
import telegram from "./telegram.js";
import discord from "./discord.js";
import slack from "./slack.js";

/**
 * Channel id -> Eve channel module — the SAME set `normalizeHostedInbound`
 * validates against (`HOSTED_INBOUND_CHANNELS`), mirroring run-outcome.ts's
 * own `CHANNELS` map for the outbound direction. iMessage is deliberately
 * absent: it has no inbound HTTP surface (LoopMessage is outbound-only, see
 * run_outcome.core.mjs's doc-comment) — normalizeHostedInbound would accept
 * `channel: "imessage"` (it shares run_outcome's TARGET_KEY set), but no
 * webhook route ever sends it, so this map staying telegram/discord/slack is
 * not a gap.
 */
const CHANNELS: Record<string, unknown> = { telegram, discord, slack };

/** Small JSON responder (the route contract is machine-to-machine, not a page). */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default defineChannel({
  routes: [
    // Routes mount at the literal declared path; /eve/v1/<id> is an adapter
    // default, not a framework rewrite (see the header comment above).
    POST("/eve/v1/hosted-inbound", async (req, args) => {
      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return json({ error: "hosted-inbound: body is not valid JSON." }, 400);
      }

      let normalized: ReturnType<typeof normalizeHostedInbound>;
      try {
        normalized = normalizeHostedInbound(raw);
      } catch (err) {
        return json(
          { error: err instanceof Error ? err.message : String(err) },
          400,
        );
      }

      const channelModule = CHANNELS[normalized.channel];
      if (!channelModule) {
        return json(
          { error: `hosted-inbound: channel '${normalized.channel}' is not wired.` },
          400,
        );
      }

      // AWAIT, not waitUntil: the dispatcher needs sessionId synchronously to
      // write its ledger (bindEveSession) — see the header comment above.
      const session = await args.receive(channelModule, {
        message: normalized.message,
        target: normalized.target,
        auth: normalized.auth,
      });

      return json({
        ok: true,
        sessionId: session.id,
        continuationToken: session.continuationToken,
      });
    }),
  ],
});
