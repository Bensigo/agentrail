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
 *  - BEST-EFFORT: every send is isolated and swallowed. A notify failure must
 *    NEVER change the route's response (AC3) — callers additionally wrap the
 *    whole thing in try/catch, but we also never throw from here.
 */
import { getConnector, getConnectorSecret } from "@agentrail/db-postgres";
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
 */
export async function notifyRunOutcome(
  workspaceId: string,
  params: NotifyParams
): Promise<void> {
  const text = buildOutcomeMessage(params);
  await Promise.all(
    GATEWAY_SENDERS.map(async (send) => {
      try {
        await send(workspaceId, text);
      } catch {
        // best-effort — a gateway blip must never affect the result response.
      }
    })
  );
}
