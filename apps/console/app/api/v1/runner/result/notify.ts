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
 *  - Per-provider sender map: Telegram is wired now; Slack/Discord slot in by
 *    adding an entry (AC5). An unconnected / disabled provider is a silent
 *    no-op.
 *  - Channel migration (#1047): when a workspace has migrated Telegram to Jace
 *    (`jaceOwnsTelegramNotify`), the outbound ping is delivered THROUGH Jace
 *    instead of the legacy sender — exclusive, so exactly one notification fires.
 *    Default OFF; the legacy path is unchanged until per-workspace cutover.
 *  - BEST-EFFORT: every send is isolated and swallowed. A notify failure must
 *    NEVER change the route's response (AC3) — callers additionally wrap the
 *    whole thing in try/catch, but we also never throw from here.
 */
import {
  getConnector,
  getConnectorSecret,
  jaceOwnsTelegramNotify,
} from "@agentrail/db-postgres";
import { sendTelegramMessage } from "../../workspaces/[workspaceId]/connectors/secret/telegram";

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

// --- Jace outbound route (#1047) ---------------------------------------------

/** Where the Jace Eve sidecar listens (mirrors the jace inbound route). */
const EVE_HOST = process.env["EVE_HOST"] || "http://127.0.0.1:2000";

/**
 * The OUTBOUND notify boundary on the Jace sidecar. The console hands a terminal
 * run outcome to Jace here; Jace delivers it to the connected channel in a
 * repliable thread (the bidirectional round-trip, AC3). Overridable for tests /
 * non-default topologies.
 *
 * DEPLOY-GATED: the Jace-side handler for this path (channel delivery + thread
 * mapping) is the cutover work and is NOT built here. Because the route is chosen
 * only when the operator has explicitly opted in (`jaceOwnsTelegramNotify`,
 * default OFF) AND this call is best-effort, an undeployed endpoint is a harmless
 * no-op until BOTH the flag is flipped and the sidecar handler ships.
 */
const JACE_NOTIFY_URL =
  process.env["JACE_NOTIFY_URL"] || `${EVE_HOST}/eve/v1/notify`;

/**
 * Hand a terminal run outcome to the Jace sidecar for Telegram delivery (#1047).
 *
 * This is the console half of the outbound migration: Jace holds the conversation
 * (and, post-migration, the chat-id allowlist), but has no DB, so the console —
 * the DB holder — passes the destination `chatId` and the built message. Jace
 * posts it to Telegram in a thread the user can reply to.
 *
 * BEST-EFFORT and — critically for exactly-once — NO FALLBACK: if the sidecar is
 * unreachable we swallow and return. We must NOT fall back to the legacy sender,
 * or a transient blip after Jace already delivered would double-fire. The caller
 * is already terminal-only, so at most one outcome ever reaches here.
 */
async function notifyTelegramViaJace(
  workspaceId: string,
  params: NotifyParams,
  text: string
): Promise<void> {
  const connector = await getConnector(workspaceId, "telegram");
  const chatId = connector?.config.chatId;
  await fetch(JACE_NOTIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId,
      channel: "telegram",
      chatId,
      text,
      outcome: params.outcome,
      issueNumber: params.issueNumber,
      prUrl: params.prUrl,
      costUsd: params.costUsd,
    }),
  });
}

/** A per-provider sender: posts `text` to that gateway for the workspace. */
type GatewaySender = (workspaceId: string, text: string) => Promise<void>;

/**
 * The wired gateways. Telegram now (#888); Slack/Discord slot in here later
 * (AC5) — each entry is independently isolated by {@link notifyRunOutcome}.
 */
const GATEWAY_SENDERS: GatewaySender[] = [notifyTelegram];

/**
 * Fan out a terminal run outcome to every enabled gateway connector. Each
 * sender is isolated: one provider failing (or throwing) never blocks the
 * others, and this function never throws — the route's response is unaffected
 * (AC3).
 *
 * TELEGRAM ROUTING (#1047). Telegram outbound goes through EXACTLY ONE path,
 * chosen per workspace:
 *  - MIGRATED (`jaceOwnsTelegramNotify` — the `jace` connector is enabled AND
 *    `config.telegramNotify` is opted in) → deliver via Jace and SKIP the legacy
 *    Telegram sender. Exclusive by construction: a terminal outcome is delivered
 *    ONCE (no dark, no double).
 *  - DEFAULT (no jace row / disabled / opt-in off) → the legacy
 *    {@link GATEWAY_SENDERS} fan-out, unchanged. Safe no-op until cutover.
 *
 * Exactly-once & retry-silence: the caller invokes this ONLY on a non-null
 * `terminalState`, so a retry / re-queue / heartbeat never reaches here — that
 * hard rule is preserved regardless of which route is chosen.
 */
export async function notifyRunOutcome(
  workspaceId: string,
  params: NotifyParams
): Promise<void> {
  const text = buildOutcomeMessage(params);

  // Decide the Telegram route ONCE. Reading the jace connector is isolated: a
  // lookup blip falls back to the legacy path (never throws, never dark by
  // default), matching the best-effort contract of the senders themselves.
  let jaceOwnsTelegram = false;
  try {
    const jaceConnector = await getConnector(workspaceId, "jace");
    jaceOwnsTelegram = jaceOwnsTelegramNotify(jaceConnector);
  } catch {
    jaceOwnsTelegram = false;
  }

  // When Jace owns Telegram, the legacy Telegram sender is replaced (not added)
  // by the Jace handoff — never both. Non-telegram gateways (slack/discord, when
  // wired) would live outside GATEWAY_SENDERS and still run in both routes; there
  // are none today, so the migrated route is the Jace handoff alone.
  const senders: GatewaySender[] = jaceOwnsTelegram
    ? [(ws, t) => notifyTelegramViaJace(ws, params, t)]
    : GATEWAY_SENDERS;

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
