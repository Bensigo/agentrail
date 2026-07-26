// Jace's Discord GATEWAY listener (#1050 follow-up — see
// docs/superpowers/specs/2026-07-26-discord-gateway-listener-design.md) —
// the thin, impure socket wrapper. Every DECISION this file needs (admit
// this message? what does a close code mean? what does the console's intake
// door expect?) lives in ./discord_gateway.core.mjs and is unit-tested there
// without a live socket; this file only wires a maintained Gateway client to
// those decisions. Kept thin on purpose, matching the repo's channel-wrapper
// convention (agent/channels/telegram.ts, agent/channels/discord.ts).
//
// WHY THIS EXISTS SEPARATELY FROM agent/channels/discord.ts: that file is
// Eve's own native `discordChannel` — HTTP interactions only (slash
// commands), no Gateway socket, see its own header comment. Discord has no
// HTTP delivery for a plain typed message or an @mention — only a
// persistent Gateway WebSocket carries those (MESSAGE_CREATE). This file
// opens that connection; agent/channels/discord.ts is untouched by it.
//
// WHY .mjs, NOT .ts (this file has no TypeScript-only syntax — plain ESM +
// JSDoc, matching agent/lib/standup.db.mjs's own "impure lib file with a
// real external dependency" precedent): agent/instrumentation.ts is the only
// place that starts this listener (see that file's own comment), and
// instrumentation.test.mjs imports agent/instrumentation.ts DIRECTLY (not
// structurally) to pin its default-export shape. Under `tsc`'s `nodenext`
// resolution a sibling `.ts` file is correctly imported via a `.js`
// specifier (`./discord-gateway.js`), and eve's real build performs that
// mapping — but Node's own native TypeScript stripping (what `node --test`
// uses here, with no separate build step) does not implement that
// remapping, so a `.ts` file importing another sibling `.ts` file via `.js`
// fails to resolve at test time with `ERR_MODULE_NOT_FOUND` (confirmed by
// hitting exactly this while wiring it in — every OTHER cross-`.ts` import
// in this codebase, e.g. hosted-inbound.ts's `./discord.js`, sidesteps the
// same gap only because nothing tests those files by direct import; they are
// all tested structurally instead, see e.g. test/hosted-inbound-channel.test.mjs's
// own header comment). Landing this as `.mjs` avoids the whole class of
// problem: an `.mjs` specifier never gets renamed by any build step, so it
// resolves identically in tests, `eve dev`, and the compiled `eve build`
// output.
//
// LIBRARY CHOICE — @discordjs/ws (2.0.4) + @discordjs/rest (2.6.3) +
// discord-api-types (0.38.51), not the full `discord.js` package. Verified
// against the live discord.js docs (context7, discord.js@14.26.2) AND the
// actual installed package's own compiled source
// (node_modules/@discordjs/ws/dist/index.js /.d.ts) before choosing:
//   - `WebSocketManager` is the exact "Gateway networking layer" discord.js
//     itself is built on, published standalone for exactly this use case —
//     inbound events + presence + connection lifecycle, no guild/channel/
//     member CACHING overhead discord.js's `Client` carries by default,
//     which this listener has no use for (it only reads raw MESSAGE_CREATE
//     dispatch payloads and forwards admitted ones to console).
//   - Heartbeat (at the HELLO interval), RESUME vs full re-IDENTIFY, and
//     backoff are handled INSIDE `WebSocketShard` — verified by reading its
//     compiled `onClose(code)` switch directly: every one of the six
//     Discord documents as non-recoverable (Reconnect: false — 4004, 4010,
//     4011, 4012, 4013, 4014) calls `destroy({ code })` with NO `recover`
//     option, so the shard does not attempt Resume or a fresh Identify and
//     instead emits `error` — everything else calls `destroy({ code,
//     recover: Resume | Reconnect })`, picking per-code exactly as Discord's
//     own close-event-codes table documents. This file does not re-implement
//     or second-guess that decision (see discord_gateway.core.mjs's
//     `classifyCloseCode` doc comment) — it only reacts to the outcome.
//
// FATAL CLOSE HANDLING — never hot-loop. `WebSocketShardEvents.Error` MUST
// be listened to, not just for logging: `WebSocketManager` extends
// `AsyncEventEmitter`, and the shard's fatal-code path does
// `this.emit("error", new Error(...))` — an emitted `error` event with zero
// listeners throws (standard EventEmitter semantics), which would crash the
// ENTIRE jace process, not just the Discord listener, turning "Discord
// disabled the Message Content intent" into "Jace is completely down". The
// listener below is attached before `connect()` for exactly this reason. On
// a FATAL close this file additionally calls `manager.destroy()` itself
// (defense in depth beyond the shard's own internal stop) and never calls
// `connect()` again for the life of the process — there is no retry timer,
// no schedule, nothing that could re-attempt Identify with the same
// disallowed intents a second later.
//
// INITIAL-CONNECT RETRY (I4) — the manager's own initial connect (not a
// later Closed event) can reject: it fetches GET /gateway/bot over REST
// before opening any socket, and can also throw on `session_start_limit`.
// That REST-layer failure mode is unrelated to the fatal-close-code path
// above — verified against the installed @discordjs/ws@2.0.4 source
// (node_modules/@discordjs/ws/dist/index.mjs, `WebSocketShard#connect`): a
// FATAL close during the initial IDENTIFY never settles that shard's own
// "ready"/"resumed" race (there is no listener racing against a timeout, and
// nothing else rejects it), so that initial connect call neither resolves
// nor rejects on that path — only the `error`/`Closed` events already wired
// below carry it, and they run independently of whatever triggered the
// connect. So retrying only the thrown/rejected path (`connectWithRetry`,
// below) cannot ever retry a 4014/4004-style fatal close: there is no call
// site for that inside the Closed handler, then or now. Without this retry,
// one blip at boot (a transient network error, or `session_start_limit`)
// left Jace permanently offline until a redeploy — see `connectWithRetry`.
//
// MULTI-REPLICA STANCE — the jace service runs at ONE replica in steady
// state (no `numReplicas` is configured for it, mirroring the fleet
// service's own documented convention, deploy/fleet/README.md: "Never
// numReplicas for throughput — a second replica just stands by idle").
// Railway's own deploy-overlap window (briefly running old+new together
// during a deploy) is the one place two Gateway connections could exist for
// a moment; this is deliberately NOT guarded with a distributed lock,
// because the pipeline this listener feeds already neutralizes the only
// harmful outcome of that overlap: `enqueueChannelMessage`'s
// `ON CONFLICT (channel, provider_message_id) DO NOTHING` means a
// MESSAGE_CREATE observed twice (once by each connection) produces at most
// ONE `channel_inbox` row and ONE Eve turn — the second POST to
// discord-inbound comes back `deduped: true` and is a no-op, never a double
// reply. Each connection is independent/stateless in-memory, so an overlap
// cannot corrupt either side's session state either. A real leader lease
// (mirroring `fleet_leases`, deploy/fleet/README.md's #1390) would need jace
// to reach a lock the console owns — jace has no direct Postgres access — so
// it is flagged here as a deliberate follow-up, not built now: this
// listener's blast radius if ever run at steady-state N>1 replicas is
// wasted Discord bandwidth and duplicate log lines, never duplicate replies.
import { REST } from "@discordjs/rest";
import { WebSocketManager, WebSocketShardEvents } from "@discordjs/ws";
import { GatewayDispatchEvents, GatewayIntentBits } from "discord-api-types/v10";
import {
  admitMessage,
  classifyCloseCode,
  computeInitialConnectBackoffMs,
  INITIAL_CONNECT_MAX_ATTEMPTS,
  postDiscordInboundMessage,
  shapeInboundPayload,
} from "./discord_gateway.core.mjs";

const LOG_PREFIX = "[discord-gateway]";

const INTENTS =
  GatewayIntentBits.Guilds |
  GatewayIntentBits.GuildMessages |
  GatewayIntentBits.DirectMessages |
  GatewayIntentBits.MessageContent;

/** Module-level state — exactly one connection per process (see the
 * multi-replica note above for the cross-process story). `started` guards
 * against a second `startDiscordGateway()` call (e.g. a future second import
 * site) from ever opening a second connection within the SAME process. */
const state = {
  started: false,
  connected: false,
  stopped: false,
  botUserId: /** @type {string | null} */ (null),
};

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function warn(...args) {
  console.warn(LOG_PREFIX, ...args);
}

function error(...args) {
  console.error(LOG_PREFIX, ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry the manager's INITIAL connect up to `INITIAL_CONNECT_MAX_ATTEMPTS`
 * times with a capped exponential backoff + full jitter
 * (`computeInitialConnectBackoffMs`, unit-tested in
 * discord_gateway.core.test.mjs) before giving up (I4). See this file's
 * header comment ("INITIAL-CONNECT RETRY") for why this can never retry a
 * fatal close code: that path does not reject this call at all — it is
 * carried entirely by the Closed/Error listeners already attached above
 * (before this runs), which is what performs the actual permanent stop.
 *
 * Exported (unlike the rest of this file's internals) because, unlike
 * `startDiscordGateway`, it only needs an object shaped like
 * `{ connect(): Promise<void> }` — it never constructs a WebSocketManager or
 * opens a socket itself — so it CAN be exercised behaviorally with
 * `node --test` and a fake manager, see discord-gateway-wiring.test.mjs.
 * `deps.sleep` lets those tests skip real backoff delays.
 *
 * @param {WebSocketManager} manager
 * @param {{ sleep?: (ms: number) => Promise<void> }} [deps]
 */
export async function connectWithRetry(manager, deps = {}) {
  const wait = deps.sleep ?? sleep;
  for (let attempt = 1; attempt <= INITIAL_CONNECT_MAX_ATTEMPTS; attempt += 1) {
    try {
      await manager.connect();
      return;
    } catch (err) {
      if (attempt === INITIAL_CONNECT_MAX_ATTEMPTS) throw err;
      const delay = computeInitialConnectBackoffMs(attempt);
      warn(
        `initial connect failed (attempt ${attempt}/${INITIAL_CONNECT_MAX_ATTEMPTS}) — retrying in ${delay}ms:`,
        err instanceof Error ? err.message : String(err),
      );
      await wait(delay);
    }
  }
}

/**
 * Start the Discord Gateway listener once for this process. Safe to call
 * from a fire-and-forget context (see agent/instrumentation.ts): never
 * throws synchronously, and every async failure is caught and logged rather
 * than left as an unhandled rejection. A missing `DISCORD_BOT_TOKEN` is not
 * an error — it just means this deployment has not configured Discord, so
 * the listener quietly does not start (mirrors every other channel's
 * env-var-gated posture in this codebase).
 *
 * @param {Record<string, string | undefined>} [env]
 */
export async function startDiscordGateway(env = process.env) {
  if (state.started) {
    warn("startDiscordGateway called again in the same process — ignoring (already started).");
    return;
  }

  const token = (env.DISCORD_BOT_TOKEN ?? "").trim();
  if (!token) {
    log("DISCORD_BOT_TOKEN is not set — Discord gateway listener not started.");
    return;
  }

  state.started = true;

  try {
    const rest = new REST({ version: "10" }).setToken(token);
    const manager = new WebSocketManager({
      token,
      intents: INTENTS,
      rest,
      initialPresence: { since: null, activities: [], status: "online", afk: false },
    });

    manager.on(WebSocketShardEvents.Ready, (data) => {
      state.connected = true;
      state.botUserId = data.user.id;
      log(`connected — online as ${data.user.username} (shard ready).`);
    });

    manager.on(WebSocketShardEvents.Resumed, () => {
      log("session resumed.");
    });

    manager.on(WebSocketShardEvents.Closed, (code) => {
      state.connected = false;
      const { fatal, summary } = classifyCloseCode(code);
      if (fatal) {
        state.stopped = true;
        error(
          `FATAL close (code ${code}): ${summary} STOPPING — will not reconnect. Fix the underlying cause and redeploy.`,
        );
        // Defense in depth beyond the shard's own internal stop (see header
        // comment) — and the definitive point past which this process makes
        // no further connection attempt.
        void manager.destroy().catch((destroyErr) => {
          error("manager.destroy() after a fatal close itself failed:", destroyErr);
        });
      } else {
        log(`closed (code ${code}): ${summary}`);
      }
    });

    // MUST be attached — an unlistened `error` event throws inside
    // AsyncEventEmitter and would take the whole jace process down with it.
    // See the header comment's "FATAL CLOSE HANDLING" section.
    manager.on(WebSocketShardEvents.Error, (err) => {
      error("shard error:", err instanceof Error ? err.message : String(err));
    });

    manager.on(WebSocketShardEvents.SocketError, (err) => {
      warn("socket transport error:", err instanceof Error ? err.message : String(err));
    });

    manager.on(WebSocketShardEvents.Dispatch, (payload) => {
      if (payload.t !== GatewayDispatchEvents.MessageCreate) return;
      void handleMessageCreate(payload.d, env).catch((handlerErr) => {
        error("MESSAGE_CREATE handling failed:", handlerErr);
      });
    });

    await connectWithRetry(manager);
  } catch (err) {
    state.stopped = true;
    error(
      `failed to start after ${INITIAL_CONNECT_MAX_ATTEMPTS} attempts (e.g. persistent REST/network failure, session_start_limit, or bad Discord credentials) — giving up:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Handle one admitted-or-not MESSAGE_CREATE dispatch: run the pure admission
 * rule, and only for an admitted message, shape + POST it to the console's
 * discord-inbound door — the SAME pipeline the interactions door already
 * feeds (resolveInboundChatIdentity -> enqueueChannelMessage -> dispatcher ->
 * Eve turn), just reached over HTTP since this service has no direct
 * Postgres access. Never throws past the caller's own `.catch` above.
 *
 * @param {unknown} message raw GatewayMessageCreateDispatchData
 * @param {Record<string, string | undefined>} env
 */
async function handleMessageCreate(message, env) {
  const decision = admitMessage(message, state.botUserId);
  if (!decision.admit) return;

  const payload = shapeInboundPayload({ message, botUserId: state.botUserId });
  const result = await postDiscordInboundMessage({ ...payload, env, transport: fetch });
  if (!result.ok) {
    error(`discord-inbound POST failed for ${payload.channelId}:${payload.messageId}:`, result.error);
  }
}
