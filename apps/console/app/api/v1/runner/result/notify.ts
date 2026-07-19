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
 *    (#888) and Discord (workspace-webhook) have legacy console senders; Slack
 *    (#1050) and iMessage (#1100) are greenfield (Jace-only). An unconnected /
 *    disabled channel is a silent no-op.
 *  - Channel migration (#1047 Telegram, #1050 Discord + Slack, #1100 iMessage):
 *    when a workspace has migrated a channel to Jace (`jaceOwns<Channel>Notify`),
 *    the outbound ping is delivered THROUGH Jace's NATIVE Eve channel instead of
 *    the legacy sender — exclusive, so exactly one notification fires (no dark,
 *    no double). Default OFF; each channel's legacy path is unchanged until its
 *    per-workspace cutover. The console posts to Jace's real `/eve/v1/run-outcome`
 *    Eve channel route with the built message + the NON-SECRET destination
 *    (`target`); Jace's channel holds the shared bot credentials and does
 *    delivery + threading. (This replaces an earlier bespoke `/eve/v1/notify`
 *    handoff — Eve has no such endpoint; channels are its first-class primitive.)
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
  jaceOwnsIMessageNotify,
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
  /**
   * #1278 PR②: true when merge permission was ON and the console actually
   * squash-merged this PR (route.ts, after a successful
   * `mergePullRequestSquash`). Only ever meaningful alongside
   * `outcome === "green"` (a merge only happens after the gate is green) —
   * changes ONLY the headline word ("Merged" vs "PR ready"); everything
   * else about the message (issue #, PR link, cost) is unchanged, so a
   * permission-OFF or non-green outcome is byte-identical to before this
   * field existed.
   */
  merged?: boolean;
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
 *
 * #1278 PR②: `params.merged` swaps the headline to "Merged" — the smallest
 * honest change (everything else about the line is unchanged). Coordinate
 * with the #1277 lane's format module if/when it lands; this stays the
 * inline template until then.
 */
export function buildOutcomeMessage(params: NotifyParams): string {
  const headline =
    params.outcome === "green" && params.merged
      ? "Merged"
      : OUTCOME_HEADLINE[params.outcome];
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

// --- Jace outbound route (#1047 Telegram, #1050 Discord + Slack, #1100 iMessage) --------------

/** Where the Jace Eve sidecar listens (mirrors the jace inbound route). */
const EVE_HOST = process.env["EVE_HOST"] || "http://127.0.0.1:2000";

/**
 * The REAL Eve custom-channel route Jace mounts for outbound run-outcome delivery
 * (`apps/jace/agent/channels/run-outcome.ts` → `/eve/v1/run-outcome`). The console
 * hands a terminal outcome here; Jace's route `args.receive`s it into the native
 * platform channel, so the ping lands in a repliable thread. Overridable for
 * tests / non-default topologies.
 *
 * DEPLOY-GATED: running the route (live delivery, per-workspace cutover) needs the
 * deployed sidecar (#1038/#1101). Because a channel routes here only when the
 * operator has explicitly opted in (`jaceOwns<Channel>Notify`, default OFF) AND
 * this call is best-effort, an unreachable sidecar is a harmless no-op until BOTH
 * the flag is flipped and the sidecar is deployed.
 */
const JACE_RUN_OUTCOME_URL =
  process.env["JACE_RUN_OUTCOME_URL"] || `${EVE_HOST}/eve/v1/run-outcome`;

/**
 * The initiator identity Eve forwards to `session.auth.initiator` so Jace's
 * channel handlers and tools can attribute the session to the originating
 * workspace. Non-secret; a service principal, not an end user.
 */
function jaceInitiatorAuth(
  workspaceId: string,
  params: NotifyParams
): Record<string, unknown> {
  return {
    authenticator: "agentrail",
    principalType: "service",
    principalId: workspaceId,
    attributes: { issueNumber: params.issueNumber, outcome: params.outcome },
  };
}

/**
 * Hand a terminal run outcome to Jace's native run-outcome channel for delivery
 * on `channel` (#1047 Telegram, #1050 Discord + Slack, #1100 iMessage).
 *
 * This is the console half of the outbound migration: Jace holds the conversation
 * but has no DB, so the console — the DB holder — passes the built `message`, the
 * channel-appropriate NON-SECRET `target` (`{ chatId }` / `{ channelId }`), and an
 * initiator `auth`. Secret credentials (the bot token, a webhook) live in Jace's
 * env and are NEVER sent over the wire. The payload is exactly what Jace's route
 * normalizes for `args.receive(channel, { message, target, auth })`.
 *
 * BEST-EFFORT and — critically for exactly-once — NO FALLBACK: if the sidecar is
 * unreachable we swallow and return. We must NOT fall back to the legacy sender,
 * or a transient blip after Jace already delivered would double-fire. The caller
 * is already terminal-only, so at most one outcome ever reaches here.
 */
async function notifyViaJace(
  workspaceId: string,
  channel: "telegram" | "discord" | "slack" | "imessage",
  params: NotifyParams,
  message: string,
  target: Record<string, string | undefined>
): Promise<void> {
  await fetch(JACE_RUN_OUTCOME_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId,
      channel,
      message,
      target,
      auth: jaceInitiatorAuth(workspaceId, params),
      outcome: params.outcome,
      issueNumber: params.issueNumber,
      prUrl: params.prUrl,
      costUsd: params.costUsd,
    }),
  });
}

/**
 * Telegram → Jace handoff (#1047). The non-secret `chatId` (a display field on the
 * telegram connector) is the `receive` target; the bot token stays server-side.
 */
async function notifyTelegramViaJace(
  workspaceId: string,
  params: NotifyParams,
  message: string
): Promise<void> {
  const connector = await getConnector(workspaceId, "telegram");
  await notifyViaJace(workspaceId, "telegram", params, message, {
    chatId: connector?.config.chatId,
  });
}

/**
 * Discord → Jace handoff (#1050). Jace's native Discord channel posts to a
 * `channelId` (non-secret), distinct from the legacy path's webhook secret. The
 * console passes only that id; the bot credentials live in Jace's env.
 */
async function notifyDiscordViaJace(
  workspaceId: string,
  params: NotifyParams,
  message: string
): Promise<void> {
  const connector = await getConnector(workspaceId, "discord");
  await notifyViaJace(workspaceId, "discord", params, message, {
    channelId: connector?.config.channelId,
  });
}

/**
 * Slack → Jace handoff (#1050). Slack is greenfield (no legacy console path), so
 * this is the ONLY Slack delivery — it fires solely when the workspace has opted
 * Slack into Jace. The non-secret `channelId` on the slack connector is the target.
 */
async function notifySlackViaJace(
  workspaceId: string,
  params: NotifyParams,
  message: string
): Promise<void> {
  const connector = await getConnector(workspaceId, "slack");
  await notifyViaJace(workspaceId, "slack", params, message, {
    channelId: connector?.config.channelId,
  });
}

/**
 * iMessage → Jace handoff (#1100). iMessage is greenfield (no legacy console
 * path), so this is the ONLY iMessage delivery — it fires solely when the
 * workspace has opted iMessage into Jace. The destination handle and the Messages
 * BRIDGE (BlueBubbles / commercial API) it is delivered through are resolved by
 * the DEFERRED Jace-side handler; the console passes only the outcome over the
 * wire, never a bridge URL or secret — there is no non-secret destination field to
 * send, so `target` is empty.
 */
async function notifyIMessageViaJace(
  workspaceId: string,
  params: NotifyParams,
  message: string
): Promise<void> {
  await notifyViaJace(workspaceId, "imessage", params, message, {});
}

/** A per-channel sender: posts `text` to that gateway for the workspace. */
type GatewaySender = (workspaceId: string, text: string) => Promise<void>;

/**
 * Fan out a terminal run outcome to each channel's chosen sender. Each sender is
 * isolated: one channel failing (or throwing) never blocks the others, and this
 * function never throws — the route's response is unaffected (AC3).
 *
 * PER-CHANNEL ROUTING (#1047 Telegram, #1050 Discord + Slack, #1100 iMessage).
 * Every channel is delivered on EXACTLY ONE path, chosen independently per
 * workspace:
 *  - MIGRATED (`jaceOwns<Channel>Notify` — the `jace` connector is enabled AND
 *    `config.<channel>Notify` is opted in) → deliver via Jace and SKIP the legacy
 *    sender for that channel. Exclusive by construction: no dark, no double.
 *  - DEFAULT (no jace row / disabled / opt-in off) → the legacy console sender for
 *    that channel, unchanged. Telegram (#888) + Discord (workspace-webhook) have
 *    one; Slack and iMessage are greenfield, so un-migrated they simply produce NO
 *    notification (there is no legacy path to fall back to, and none is created
 *    here).
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

  // iMessage (#1100) is greenfield too — it has no official bot/webhook API and
  // is driven only through a Jace-side Messages bridge, so there is NO legacy
  // console sender. Delivered ONLY when migrated to Jace; un-migrated iMessage
  // adds no sender at all (not a fallback) — no legacy iMessage path exists here.
  if (jaceOwnsIMessageNotify(jaceConnector)) {
    senders.push((ws, t) => notifyIMessageViaJace(ws, params, t));
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
