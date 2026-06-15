import { timeRangeToFrom, type TimeRange } from "./cost-filters";

export type AgentName = "claude" | "codex" | "cursor";

/** Shape returned by /costs/savings agentBreakdown field */
export interface AgentBreakdownEntry {
  agent: AgentName;
  totalCostUsd: number;
  dollarsSaved: number;
  eventCount: number;
}

/** Derived view row — ready for rendering */
export interface AgentBreakdownRow {
  agent: AgentName;
  cost: string;
  savings: string;
  eventCount: number;
  muted: boolean;
}

const AGENT_ORDER: AgentName[] = ["claude", "codex", "cursor"];

const ZERO_ENTRY = (agent: AgentName): AgentBreakdownEntry => ({
  agent,
  totalCostUsd: 0,
  dollarsSaved: 0,
  eventCount: 0,
});

/**
 * Always returns exactly three rows in order: claude, codex, cursor.
 * Absent agents are filled with zero rows.
 */
export function normalizeAgentBreakdown(
  raw: AgentBreakdownEntry[]
): AgentBreakdownEntry[] {
  const byAgent = new Map<AgentName, AgentBreakdownEntry>(
    raw.map((e) => [e.agent, e])
  );
  return AGENT_ORDER.map((agent) => byAgent.get(agent) ?? ZERO_ENTRY(agent));
}

/** $X.XXXX formatting for cost values */
export function formatAgentCost(usd: number): string {
  if (usd === 0) return "$0.0000";
  if (usd < 0.0001) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

/** ~$X.XX formatting for savings (always with estimate marker) */
export function formatAgentSavings(usd: number): string {
  if (usd === 0) return "~$0.00";
  return `~$${usd.toFixed(2)}`;
}

/**
 * Derives renderable AgentBreakdownRow values from a normalized entry.
 * Rows where eventCount === 0 get muted=true and — for cost/savings.
 */
export function deriveAgentRow(entry: AgentBreakdownEntry): AgentBreakdownRow {
  const muted = entry.eventCount === 0;
  return {
    agent: entry.agent,
    cost: muted ? "—" : formatAgentCost(entry.totalCostUsd),
    savings: muted ? "—" : formatAgentSavings(entry.dollarsSaved),
    eventCount: entry.eventCount,
    muted,
  };
}

/** Builds the /costs/savings URL with optional time_from param */
export function buildSavingsUrl({
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
  const url = new URL(
    `/api/v1/workspaces/${workspaceId}/costs/savings`,
    origin
  );
  const from = timeRangeToFrom(timeRange, now);
  if (from) {
    url.searchParams.set("time_from", from.toISOString());
    url.searchParams.set("time_to", now.toISOString());
  }
  return url.toString();
}
