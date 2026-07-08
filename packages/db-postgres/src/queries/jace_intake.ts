import { sql } from "drizzle-orm";
import { db } from "../db.js";

/**
 * Server-side Jace inbound intake — the kill-switch half of the coordinator.
 *
 * "Jace" is the coordinator product (built on Eve) that owns inbound
 * conversations (ideation → issues). Its per-workspace control surface is a
 * `connectors` row with `provider = 'jace'`. That row's `enabled` flag is the
 * KILL SWITCH: flipping it to `false` HALTS inbound Jace conversations for the
 * workspace.
 *
 * Crucially, this is decoupled from the AgentRail factory. The factory
 * (github issue intake → issue queue → runner) reads a SEPARATE `github`
 * provider row (see `github_intake.ts`: `findWorkspaceByRepo`). Because Jace and
 * the factory are distinct provider rows on the same table, disabling the `jace`
 * connector cannot affect factory intake — a halted coordinator still lets
 * already-queued issues run to completion (AC4).
 *
 * This mirrors `github_intake.ts` so the two intake surfaces read as siblings:
 * a pure, unit-tested decision function plus a small enabled-connector lookup.
 */

// --- the kill-switch gate (pure — NEVER touches the db) -----------------------

/**
 * A connector row-ish object as seen by the kill-switch decision. Deliberately
 * narrow: only the two fields the gate reasons about, so callers can pass a full
 * `Connector` row or a hand-built shape in a test.
 */
export type JaceConnectorRowish =
  | { provider: string; enabled: boolean }
  | null
  | undefined;

export type JaceInboundDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Decide whether an inbound Jace conversation may proceed for a workspace.
 *
 * This is the single unit-tested decision point for the kill switch and is
 * PURE — it must never import or touch `db`. Inbound is allowed iff a `jace`
 * connector row exists AND it is enabled. The disabled path is the kill switch:
 * an operator flips `enabled=false` in the console and inbound Jace halts, while
 * the factory (a separate `github` row) is untouched.
 */
export function jaceInboundAllowed(
  connector: JaceConnectorRowish
): JaceInboundDecision {
  if (!connector) {
    return { allowed: false, reason: "no jace connector for workspace" };
  }
  if (connector.provider !== "jace") {
    return {
      allowed: false,
      reason: `connector provider is '${connector.provider}', not 'jace'`,
    };
  }
  if (!connector.enabled) {
    // Kill switch: the operator disabled the jace connector.
    return { allowed: false, reason: "jace connector is disabled" };
  }
  return { allowed: true };
}

// --- outbound channel-ownership gate (pure — NEVER touches the db) ------------

/**
 * A connector row-ish object as seen by the outbound channel-ownership decision.
 * Narrow like {@link JaceConnectorRowish}, plus the migration opt-in on config so
 * a test can hand-build the shape.
 */
export type JaceNotifyConnectorRowish =
  | {
      provider: string;
      enabled: boolean;
      config?: { telegramNotify?: boolean } | null;
    }
  | null
  | undefined;

/**
 * Decide whether OUTBOUND Telegram run-outcome notifications for a workspace are
 * delivered THROUGH Jace instead of the legacy console sender (#1047).
 *
 * PURE — the single unit-tested routing decision, mirroring
 * {@link jaceInboundAllowed}. It must never import or touch `db`. Jace owns the
 * Telegram outbound channel iff a `jace` connector row exists, is ENABLED (the
 * kill switch — flipping it off reverts outbound to the safe legacy path, not
 * dark), AND its `config.telegramNotify` opt-in is explicitly true.
 *
 * Why the opt-in is separate from `enabled`: the migration must never go dark or
 * double-fire. Coupling outbound routing to `enabled` alone would mean enabling
 * inbound Jace silently reroutes notifications to a Jace-side delivery that may
 * not be deployed yet. The explicit, default-OFF flag makes cutover a deliberate,
 * per-workspace step: verify the new path delivers exactly once, THEN retire the
 * legacy sender. Returns `false` for a null / wrong-provider / disabled / opt-out
 * connector, so the caller keeps the legacy path unchanged by default.
 */
export function jaceOwnsTelegramNotify(
  connector: JaceNotifyConnectorRowish
): boolean {
  if (!connector) return false;
  if (connector.provider !== "jace") return false;
  if (!connector.enabled) return false;
  return connector.config?.telegramNotify === true;
}

// --- enabled-connector lookup -------------------------------------------------

/**
 * Resolve whether the given workspace has an ENABLED `jace` inbound connector,
 * returning its `workspace_id` when inbound is allowed and null when there is no
 * `jace` row or it is disabled. The `enabled = true` predicate enforces the kill
 * switch at the DB layer, mirroring how `findWorkspaceByRepo` in
 * `github_intake.ts` filters `provider = 'github' AND enabled = true`.
 *
 * This keys strictly by workspace: resolving an external channel/chat id to a
 * workspace is deliberately DEFERRED to the inbound-route wiring and is not part
 * of this skeleton. The factory is a separate `github` provider row, so
 * disabling the `jace` connector cannot affect factory intake.
 */
export async function findEnabledJaceWorkspace(
  workspaceId: string
): Promise<string | null> {
  const rows = (await db.execute(sql`
    SELECT workspace_id
    FROM connectors
    WHERE workspace_id = ${workspaceId}
      AND provider = 'jace'
      AND enabled = true
    LIMIT 1
  `)) as unknown as Array<{ workspace_id: string }>;
  const row = Array.from(rows)[0];
  return row ? row.workspace_id : null;
}
