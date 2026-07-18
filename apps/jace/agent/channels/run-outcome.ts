// Jace's OUTBOUND run-outcome channel (#1047 / #1050) — the console's push target.
//
// This is a CUSTOM Eve channel (`defineChannel`) whose single route receives a
// terminal run outcome from the AgentRail console and hands it to the connected
// platform channel via `args.receive(channel, { message, target, auth })` — the
// documented cross-channel hand-off (the same primitive the docs' "incident
// webhook pivots to a Slack thread" example uses). The channel id is this file's
// name (`run-outcome`), so the route mounts at `/eve/v1/run-outcome`.
//
// This REPLACES the invented `/eve/v1/notify` endpoint the earlier migration
// pointed the console at — Eve has no such convention. Delivery, threading, and
// credentials belong to the native Telegram/Discord channels, not to hand-rolled
// HTTP. The console sends only the built message and the NON-SECRET destination
// (`target`); Jace's channels hold the shared bot credentials in env.
//
// All validation/normalization is in the pure, unit-tested
// `agent/lib/run_outcome.core.mjs`; this wrapper only maps the normalized channel
// id to its Eve module and calls `receive`.
//
// NOTE: `defineChannel`/`POST`/`args.receive` shape follows the eve@0.19.0 docs;
// receive-vs-post delivery semantics and threading are verified against the
// running sidecar (#1038/#1101). The route stays inert in practice until a
// workspace opts in via `jaceOwns<Channel>Notify` (default OFF).
import { defineChannel, POST } from "eve/channels";
import { normalizeRunOutcome } from "../lib/run_outcome.core.mjs";
import telegram from "./telegram.js";
import discord from "./discord.js";
import slack from "./slack.js";
import imessage from "./imessage.js";

/**
 * Channel id -> Eve channel module. Every channel `normalizeRunOutcome`
 * recognizes is wired: telegram/discord/slack to their native Eve channels and
 * imessage to Jace's hand-rolled LoopMessage channel (#1100). A recognized
 * channel that were ever absent here would yield a clear 400 rather than a silent
 * drop.
 */
const CHANNELS: Record<string, unknown> = { telegram, discord, slack, imessage };

/** Small JSON responder (the route contract is machine-to-machine, not a page). */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default defineChannel({
  routes: [
    // The path must be spelled out in full: Eve mounts defineChannel routes at
    // their LITERAL declared path — the /eve/v1/<id> convention is a default
    // parameter inside the built-in adapters (telegramChannel etc.), not a
    // framework rewrite. POST("/") here left this channel unreachable at the
    // documented URL in every environment.
    POST("/eve/v1/run-outcome", async (req, args) => {
      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return json({ error: "run-outcome: body is not valid JSON." }, 400);
      }

      let outcome: ReturnType<typeof normalizeRunOutcome>;
      try {
        outcome = normalizeRunOutcome(raw);
      } catch (err) {
        return json(
          { error: err instanceof Error ? err.message : String(err) },
          400,
        );
      }

      const channel = CHANNELS[outcome.channel];
      if (!channel) {
        return json(
          { error: `run-outcome: channel '${outcome.channel}' is not wired.` },
          400,
        );
      }

      // Hand off to the platform channel in its own thread. `waitUntil` keeps the
      // request alive until the parked session/fetch completes. Best-effort: the
      // console is terminal-only and never retries on this path.
      args.waitUntil(
        args.receive(channel, {
          message: outcome.message,
          target: outcome.target,
          ...(outcome.auth ? { auth: outcome.auth } : {}),
        }),
      );

      return json({ ok: true, channel: outcome.channel });
    }),
  ],
});
