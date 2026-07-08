/**
 * Connector-agnostic run-outcome notify (#888).
 *
 * When a runner reports a TERMINAL outcome (`/api/v1/runner/result`), this posts
 * a concise operational message to every ENABLED gateway connector on the
 * workspace. It is the self-hosted-runner equivalent of the notify the legacy
 * Python heartbeat loop did — that loop never runs in this model, so without
 * this hook runner-executed runs finish silently.
 *
 * Design notes:
 *  - The CALLER decides terminality (it only invokes this when
 *    `recordRunnerResult` returns a non-null `terminalState`), so a retry
 *    (re-queued red/error) and a `running` heartbeat never reach here → no spam.
 *  - Per-channel routing: each channel is delivered on EXACTLY ONE path, chosen
 *    independently per workspace — its legacy console sender XOR Jace. Telegram
 *    (#888) and Discord (workspace-webhook) have legacy console senders; Slack is
 *    greenfield (Jace-only). An unconnected / disabled channel is a silent no-op.
 *  - Channel migration (#1047 Telegram, #1050 Discord + Slack): when a workspace
 *    has migrated a channel to Jace (`jaceOwns<Channel>Notify`), the outbound ping
 *    is delivered THROUGH Jace instead of the legacy sender — exclusive, so
 *    exactly one notification fires (no dark, no double). Default OFF; each
 *    channel's legacy path is unchanged until its per-workspace cutover.
 *  - BEST-EFFORT: every send is isolated and swallowed. A notify failure must
 *    NEVER change the route's response (AC3) — callers additionally wrap the
 *    whole thing in try/catch, but we also never throw from here.
 */
import {
  getConnector,
  getConnectorSecret,
  getDiscordWebhookUrl,
  jaceOwnsTelegramNotify,
  jaceOwnsDiscordNotify,
  jaceOwnsSlackNotify,
} from "@agentrail/db-postgres";
import { sendTelegramMessage } from "../../workspaces/[workspaceId]/connectors/secret/telegram";
import { sendDiscordMessage } from "../../workspaces/[workspaceId]/connectors/secret/discord";

/** A terminal queue outcome, in the queue state-machine vocabulary. */
export type NotifyOutcome = "green" | "escalated-to-human" | "blocked";

export interface NotifyParams {
  issueNumber: string;
  outcome: NotifyOutcome;
  prUrl?: string;
  costUsd?: number;
}

/** Run-Outcome headline for each terminal state (operator-facing wording). */
const OUTCOME_HEADLINE: Record<NotifyOutcome, string> = {
  green: "PR ready",
  "escalated-to-human": "Escalated to human",
  blocked: "Blocked",
};

/** Format a dollar cost, or "" when absent/non-finite. Mirrors the Py `_fmt_cost`. */
function fmtCost(costUsd: number | undefined): string {
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return "";
  return `$${costUsd.toFixed(2)}`;
}

/**
 * Build the one-line chat message. Pure + exported so it is unit-testable and
 * provider-agnostic (every gateway speaks the same Run-Outcome vocabulary).
 *
 * e.g. `AgentRail: PR ready — issue #42 (https://github.com/o/r/pull/9 · $1.20)`
 */
export function buildOutcomeMessage(params: NotifyParams): string {
  const headline = OUTCOME_HEADLINE[params.outcome];
  let line = `AgentRail: ${headline} — issue #${params.issueNumber}`;
  const extras: string[] = [];
  if (params.prUrl) extras.push(params.prUrl);
  const cost = fmtCost(params.costUsd);
  if (cost) extras.push(cost);
  if (extras.length) line = `${line} (${extras.join(" · ")})`;
  return line;
}

/**
 * Post `params` to the workspace's enabled Telegram gateway. No-op (returns
 * without sending) when Telegram is not connected, disabled, has no chat id, or
 * has no stored token. Best-effort: a send failure is swallowed.
 */
async function notifyTelegram(
  workspaceId: string,
  text: string
): Promise<void> {
  const connector = await getConnector(workspaceId, "telegram");
  if (!connector || !connector.enabled || !connector.config.chatId) return;
  const token = await getConnectorSecret(workspaceId, "telegram");
  if (!token) return;
  await sendTelegramMessage(token, connector.config.chatId, text);
}

/**
 * Post `params` to the workspace's enabled Discord notify channel (the legacy
 * console path, #1050). Discord keeps its webhook on the workspace row
 * (`discord_webhook_url`), not in `connectors.secret`, so this reads the webhook
 * directly. No-op when Discord is not connected, disabled, or has no stored
 * webhook. Best-effort: a send failure is swallowed. This is the runner-model
 * port of the legacy Python `agentrail/connectors/discord.py` notify.
 */
async function notifyDiscord(
  workspaceId: string,
  text: string
): Promise<void> {
  const connector = await getConnector(workspaceId, "discord");
  if (!connector || !connector.enabled) return;
  const webhookUrl = await getDiscordWebhookUrl(workspaceId);
  if (!webhookUrl) return;
  await sendDiscordMessage(webhookUrl, text);
}

// --- Jace outbound route (#1047 Telegram, #1050 Discord + Slack) --------------

/** Where the Jace Eve sidecar listens (mirrors the jace inbound route). */
const EVE_HOST = process.env["EVE_HOST"] || "http://127.0.0.1:2000";

/**
 * The OUTBOUND notify boundary on the Jace sidecar. The console hands a terminal
 * run outcome to Jace here; Jace delivers it to the connected channel in a
 * repliable thread (the bidirectional round-trip). Overridable for tests /
 * non-default topologies.
 *
 * DEPLOY-GATED: the Jace-side handler for this path (channel delivery + thread
 * mapping) is the cutover work and is NOT built here (blocked on the deployed
 * sidecar, #1038). Because a channel routes here only when the operator has
 * explicitly opted in (`jaceOwns<Channel>Notify`, default OFF) AND this call is
 * best-effort, an undeployed endpoint is a harmless no-op until BOTH the flag is
 * flipped and the sidecar handler ships.
 */
const JACE_NOTIFY_URL =
  process.env["JACE_NOTIFY_URL"] || `${EVE_HOST}/eve/v1/notify`;

/**
 * Hand a terminal run outcome to the Jace sidecar for delivery on `channel`
 * (#1047 Telegram, #1050 Discord + Slack).
 *
 * This is the console half of the outbound migration: Jace holds the conversation
 * (and, post-migration, the per-channel allowlist), but has no DB, so the console
 * — the DB holder — passes the built message plus any NON-SECRET destination hint
 * (`extra`, e.g. Telegram's `chatId`). Secret destinations (a Discord webhook, a
 * Slack token) are resolved by the Jace-side handler, never sent over the wire.
 *
 * BEST-EFFORT and — critically for exactly-once — NO FALLBACK: if the sidecar is
 * unreachable we swallow and return. We must NOT fall back to the legacy sender,
 * or a transient blip after Jace already delivered would double-fire. The caller
 * is already terminal-only, so at most one outcome ever reaches here.
 */
async function notifyViaJace(
  workspaceId: string,
  channel: "telegram" | "discord" | "slack",
  params: NotifyParams,
  text: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await fetch(JACE_NOTIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId,
      channel,
      text,
      outcome: params.outcome,
      issueNumber: params.issueNumber,
      prUrl: params.prUrl,
      costUsd: params.costUsd,
      ...extra,
    }),
  });
}

/**
 * Telegram → Jace handoff (#1047). Passes the destination `chatId` (a non-secret
 * display field) so Jace can address the thread; the bot token stays server-side.
 */
async function notifyTelegramViaJace(
  workspaceId: string,
  params: NotifyParams,
  text: string
): Promise<void> {
  const connector = await getConnector(workspaceId, "telegram");
  const chatId = connector?.config.chatId;
  await notifyViaJace(workspaceId, "telegram", params, text, { chatId });
}

/**
 * Discord → Jace handoff (#1050). The destination (the channel webhook) is a
 * secret resolved by the DEFERRED Jace-side handler, so the console passes only
 * the outcome — never the webhook — over the wire.
 */
async function notifyDiscordViaJace(
  workspaceId: string,
  params: NotifyParams,
  text: string
): Promise<void> {
  await notifyViaJace(workspaceId, "discord", params, text);
}

/**
 * Slack → Jace handoff (#1050). Slack is greenfield (no legacy console path), so
 * this is the ONLY Slack delivery — it fires solely when the workspace has opted
 * Slack into Jace. Destination resolution is the DEFERRED Jace-side handler.
 */
async function notifySlackViaJace(
  workspaceId: string,
  params: NotifyParams,
  text: string
): Promise<void> {
  await notifyViaJace(workspaceId, "slack", params, text);
}

/** A per-channel sender: posts `text` to that gateway for the workspace. */
type GatewaySender = (workspaceId: string, text: string) => Promise<void>;

/**
 * Fan out a terminal run outcome to each channel's chosen sender. Each sender is
 * isolated: one channel failing (or throwing) never blocks the others, and this
 * function never throws — the route's response is unaffected (AC3).
 *
 * PER-CHANNEL ROUTING (#1047 Telegram, #1050 Discord + Slack). Every channel is
 * delivered on EXACTLY ONE path, chosen independently per workspace:
 *  - MIGRATED (`jaceOwns<Channel>Notify` — the `jace` connector is enabled AND
 *    `config.<channel>Notify` is opted in) → deliver via Jace and SKIP the legacy
 *    sender for that channel. Exclusive by construction: no dark, no double.
 *  - DEFAULT (no jace row / disabled / opt-in off) → the legacy console sender for
 *    that channel, unchanged. Telegram (#888) + Discord (workspace-webhook) have
 *    one; Slack is greenfield, so un-migrated Slack simply produces NO
 *    notification (there is no legacy Slack path to fall back to, and none is
 *    created here).
 *
 * Exactly-once & retry-silence: the caller invokes this ONLY on a non-null
 * `terminalState`, so a retry / re-queue / heartbeat never reaches here — that
 * hard rule is preserved regardless of which route each channel takes.
 */
export async function notifyRunOutcome(
  workspaceId: string,
  params: NotifyParams
): Promise<void> {
  const text = buildOutcomeMessage(params);

  // Resolve the jace connector ONCE. Isolated: a lookup blip falls back to the
  // all-legacy route (never throws, never dark by default), matching the
  // best-effort contract of the senders themselves. The per-channel ownership
  // decisions below are pure and never touch the db.
  let jaceConnector: Awaited<ReturnType<typeof getConnector>> = null;
  try {
    jaceConnector = await getConnector(workspaceId, "jace");
  } catch {
    jaceConnector = null;
  }

  // One sender per channel: the Jace handoff (migrated) XOR the legacy console
  // sender (default). Replacement, never addition — so a terminal outcome is
  // delivered on each channel exactly once (no dark, no double).
  const senders: GatewaySender[] = [
    jaceOwnsTelegramNotify(jaceConnector)
      ? (ws, t) => notifyTelegramViaJace(ws, params, t)
      : notifyTelegram,
    jaceOwnsDiscordNotify(jaceConnector)
      ? (ws, t) => notifyDiscordViaJace(ws, params, t)
      : notifyDiscord,
  ];

  // Slack (#1050) is greenfield: NO legacy console sender, so it is delivered
  // ONLY when migrated to Jace. Un-migrated Slack adds no sender at all (not a
  // fallback) — do not create a legacy Slack path in the console.
  if (jaceOwnsSlackNotify(jaceConnector)) {
    senders.push((ws, t) => notifySlackViaJace(ws, params, t));
  }

  await Promise.all(
    senders.map(async (send) => {
      try {
        await send(workspaceId, text);
      } catch {
        // best-effort — a gateway blip must never affect the result response.
      }
    })
  );
}
