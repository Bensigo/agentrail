// Jace's hosted-inbound DOOR channel (#1262 PR ②) — the AgentRail console's
// dispatcher target. A stranger's DM to the shared Telegram bot lands in
// `channel_inbox` via the console's webhook (PR ①); the console's dispatcher
// then claims that row, resolves conversation -> workspace via the #1261
// identity spine, and POSTs here so the message becomes a real Eve turn.
//
// This is a CUSTOM Eve channel (`defineChannel`) whose single route hands the
// message to the native `telegram` channel via `args.receive(channel,
// { message, target, auth })` — the documented cross-channel hand-off (the
// same primitive `run-outcome.ts` uses for the OUTBOUND direction). The
// channel id is this file's name (`hosted-inbound`), so the route mounts at
// `/eve/v1/hosted-inbound`.
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
// telegram-specific logic besides passing `target` through. All
// validation/normalization is in the pure, unit-tested
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

/** Small JSON responder (the route contract is machine-to-machine, not a page). */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default defineChannel({
  routes: [
    POST("/", async (req, args) => {
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

      // AWAIT, not waitUntil: the dispatcher needs sessionId synchronously to
      // write its ledger (bindEveSession) — see the header comment above.
      const session = await args.receive(telegram, normalized);

      return json({
        ok: true,
        sessionId: session.id,
        continuationToken: session.continuationToken,
      });
    }),
  ],
});
