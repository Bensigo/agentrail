import { timeRangeToFrom, type TimeRange } from "./cost-filters";

export type AgentName = "claude" | "codex" | "cursor";

/** Shape returned by /costs/meter agentBreakdown field (cost-only — no savings). */
export interface AgentBreakdownEntry {
  agent: AgentName;
  totalCostUsd: number;
  eventCount: number;
}

/** Derived view row — ready for rendering */
export interface AgentBreakdownRow {
  agent: AgentName;
  cost: string;
  eventCount: number;
  muted: boolean;
}

const AGENT_ORDER: AgentName[] = ["claude", "codex", "cursor"];
const KNOWN_AGENTS = new Set<string>(AGENT_ORDER);

const ZERO_ENTRY = (agent: AgentName): AgentBreakdownEntry => ({
  agent,
  totalCostUsd: 0,
  eventCount: 0,
});

/**
 * Always returns exactly three rows in order: claude, codex, cursor.
 * Absent agents are filled with zero rows; unknown agents are dropped.
 */
export function normalizeAgentBreakdown(
  raw: AgentBreakdownEntry[]
): AgentBreakdownEntry[] {
  const byAgent = new Map<AgentName, AgentBreakdownEntry>(
    raw
      .filter((e) => KNOWN_AGENTS.has(e.agent))
      .map((e) => [e.agent, e])
  );
  return AGENT_ORDER.map((agent) => byAgent.get(agent) ?? ZERO_ENTRY(agent));
}

/** $X.XXXX formatting for cost values */
export function formatAgentCost(usd: number): string {
  if (usd === 0) return "$0.0000";
  if (usd < 0.0001) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

/**
 * Derives renderable AgentBreakdownRow values from a normalized entry.
 * Rows where eventCount === 0 get muted=true and — for cost.
 */
export function deriveAgentRow(entry: AgentBreakdownEntry): AgentBreakdownRow {
  const muted = entry.eventCount === 0;
  return {
    agent: entry.agent,
    cost: muted ? "—" : formatAgentCost(entry.totalCostUsd),
    eventCount: entry.eventCount,
    muted,
  };
}

/** Builds the /costs/meter URL with optional time_from / time_to params */
export function buildMeterUrl({
  workspaceId,
  origin,
  timeRange,
  now = new Date(),
}: {
  workspaceId: string;
  origin: string;
  timeRange: TimeRange;
  now?: Date;
}): string {
  const url = new URL(`/api/v1/workspaces/${workspaceId}/costs/meter`, origin);
  const from = timeRangeToFrom(timeRange, now);
  if (from) {
    url.searchParams.set("time_from", from.toISOString());
    url.searchParams.set("time_to", now.toISOString());
  }
  return url.toString();
}
