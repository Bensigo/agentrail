import { client } from "./client";

// ---------------------------------------------------------------------------
// Cost Meter — falsifiable cost read model (M033)
//
// Computes the two falsifiable metrics the Agent Operations Console is allowed
// to show under the console display rule (CONTEXT.md / ADR 0009): the
// cache read-to-creation ratio and Cost-per-Issue-to-Green. Both can come back
// negative/below target, unlike the removed one-sided "savings" number.
// ---------------------------------------------------------------------------

/** One cost_events row's cache-token columns. */
export interface CacheTokenRow {
  /** cache-READ tokens (priced at cached_read rate). */
  cache_tokens: number;
  /** cache-WRITE / cache-creation tokens (priced at cached_write rate). */
  cache_creation_tokens: number;
}

export interface CacheReadCreationRatio {
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /**
   * cacheReadTokens / cacheCreationTokens. `null` when no cache-creation
   * tokens exist (the ratio is undefined, not Infinity). A ratio below 1 means
   * cache writes have not yet paid for themselves in reads — a falsifiable
   * signal that caching is not helping.
   */
  ratio: number | null;
}

/**
 * Pure computation of the cache read-to-creation ratio over cost-event rows.
 */
export function computeCacheReadCreationRatio(
  rows: CacheTokenRow[]
): CacheReadCreationRatio {
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  for (const row of rows) {
    cacheReadTokens += Number(row.cache_tokens ?? 0);
    cacheCreationTokens += Number(row.cache_creation_tokens ?? 0);
  }
  return {
    cacheReadTokens,
    cacheCreationTokens,
    ratio: cacheCreationTokens > 0 ? cacheReadTokens / cacheCreationTokens : null,
  };
}

/** Total metered cost for one run. */
export interface RunCost {
  run_id: string;
  cost_usd: number;
}

/**
 * One issue's run grouping. Runs are grouped per issue (escalation re-enqueues
 * the same issue, so several runs may share one issueKey). `reachedGreen` is
 * true when the issue reached the Green terminal state (Objective Gate +
 * Independent Verification pass).
 */
export interface IssueGroup {
  issueKey: string;
  runIds: string[];
  reachedGreen: boolean;
}

export interface IssueCost {
  issueKey: string;
  /** Total spend across every run that took this issue to Green. */
  costUsd: number;
}

export interface CostPerIssueToGreen {
  /** Per-issue cost for issues that reached Green, ordered by cost desc. */
  issues: IssueCost[];
  greenIssueCount: number;
  /**
   * Mean Cost-per-Issue-to-Green across the green issues, or `null` when no
   * issue reached Green. This is the headline falsifiable cost metric: it rises
   * when issues take more (or more expensive) runs to reach the Objective Gate.
   */
  avgCostUsd: number | null;
}

/**
 * Pure computation of Cost-per-Issue-to-Green: total spend to take one issue to
 * a passing Objective Gate, summed over every run belonging to that issue, then
 * averaged across only the issues that actually reached Green. Issues that never
 * reached Green (escalated-to-human, blocked) are excluded — their cost is not a
 * cost-to-green.
 */
export function computeCostPerIssueToGreen(
  runCosts: RunCost[],
  issues: IssueGroup[]
): CostPerIssueToGreen {
  const costByRun = new Map<string, number>();
  for (const rc of runCosts) {
    costByRun.set(rc.run_id, (costByRun.get(rc.run_id) ?? 0) + Number(rc.cost_usd ?? 0));
  }

  const greenIssues: IssueCost[] = issues
    .filter((issue) => issue.reachedGreen)
    .map((issue) => ({
      issueKey: issue.issueKey,
      costUsd: issue.runIds.reduce(
        (sum, runId) => sum + (costByRun.get(runId) ?? 0),
        0
      ),
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const greenIssueCount = greenIssues.length;
  const avgCostUsd =
    greenIssueCount > 0
      ? greenIssues.reduce((sum, i) => sum + i.costUsd, 0) / greenIssueCount
      : null;

  return { issues: greenIssues, greenIssueCount, avgCostUsd };
}

// ---------------------------------------------------------------------------
// ClickHouse fetchers
// ---------------------------------------------------------------------------

type QueryJsonResult = { json<T>(): Promise<T[]>; };
type QueryClient = {
  query(args: {
    query: string;
    query_params?: Record<string, unknown>;
    format: "JSONEachRow";
  }): Promise<QueryJsonResult>;
};

function formatClickHouseDateTime(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

export interface CostMeterTimeOptions {
  timeFrom?: Date;
  timeTo?: Date;
}

/**
 * Workspace-level cache read-to-creation ratio from cost_events (AC2).
 * Aggregates cache_tokens (read) vs cache_creation_tokens (write) so the ratio
 * can be surfaced on the console.
 */
export async function getCacheReadCreationRatio(
  workspaceId: string,
  opts: CostMeterTimeOptions = {},
  ch: QueryClient = client
): Promise<CacheReadCreationRatio> {
  const conditions: string[] = ["workspace_id = {workspaceId: String}"];
  const queryParams: Record<string, unknown> = { workspaceId };

  if (opts.timeFrom) {
    conditions.push("occurred_at >= {timeFrom: DateTime64(3)}");
    queryParams.timeFrom = formatClickHouseDateTime(opts.timeFrom);
  }
  if (opts.timeTo) {
    conditions.push("occurred_at <= {timeTo: DateTime64(3)}");
    queryParams.timeTo = formatClickHouseDateTime(opts.timeTo);
  }

  const result = await ch.query({
    query: `
      SELECT
        sum(cache_tokens)          AS cache_tokens,
        sum(cache_creation_tokens) AS cache_creation_tokens
      FROM cost_events
      WHERE ${conditions.join(" AND ")}
    `,
    query_params: queryParams,
    format: "JSONEachRow",
  });

  const rows = await result.json<Record<string, unknown>>();
  const row = rows[0];
  return computeCacheReadCreationRatio([
    {
      cache_tokens: Number(row?.cache_tokens ?? 0),
      cache_creation_tokens: Number(row?.cache_creation_tokens ?? 0),
    },
  ]);
}

/**
 * Per-run total cost for a set of run IDs (used to build Cost-per-Issue-to-Green
 * after the caller maps runs → issues from Postgres runs).
 */
export async function getRunCostTotals(
  workspaceId: string,
  runIds: string[],
  ch: QueryClient = client
): Promise<RunCost[]> {
  if (runIds.length === 0) return [];

  const result = await ch.query({
    query: `
      SELECT
        run_id,
        sum(cost_usd) AS cost_usd
      FROM cost_events
      WHERE workspace_id = {workspaceId: String}
        AND run_id IN ({runIds: Array(String)})
      GROUP BY run_id
    `,
    query_params: { workspaceId, runIds },
    format: "JSONEachRow",
  });

  const rows = await result.json<Record<string, unknown>>();
  return rows.map((r) => ({
    run_id: String(r.run_id ?? ""),
    cost_usd: Number(r.cost_usd ?? 0),
  }));
}

export interface AgentCostBreakdownRow {
  agent: string;
  totalCostUsd: number;
  eventCount: number;
}

/**
 * Per-agent cost breakdown from cost_events, bucketed by model prefix. Cost-only
 * (no one-sided savings column) so every number is falsifiable.
 */
export async function getAgentCostBreakdown(
  workspaceId: string,
  opts: CostMeterTimeOptions = {},
  ch: QueryClient = client
): Promise<AgentCostBreakdownRow[]> {
  const conditions: string[] = ["workspace_id = {workspaceId: String}"];
  const queryParams: Record<string, unknown> = { workspaceId };

  if (opts.timeFrom) {
    conditions.push("occurred_at >= {timeFrom: DateTime64(3)}");
    queryParams.timeFrom = formatClickHouseDateTime(opts.timeFrom);
  }
  if (opts.timeTo) {
    conditions.push("occurred_at <= {timeTo: DateTime64(3)}");
    queryParams.timeTo = formatClickHouseDateTime(opts.timeTo);
  }

  const result = await ch.query({
    query: `
      SELECT
        multiIf(
          model LIKE 'claude-%', 'claude',
          model LIKE 'gpt-%' OR model LIKE 'codex-%' OR match(model, '^o[0-9]-'), 'codex',
          model LIKE 'cursor-%', 'cursor',
          'unknown'
        ) AS agent,
        sum(cost_usd) AS total_cost_usd,
        count() AS event_count
      FROM cost_events
      WHERE ${conditions.join(" AND ")}
      GROUP BY agent
    `,
    query_params: queryParams,
    format: "JSONEachRow",
  });

  const rows = await result.json<Record<string, unknown>>();
  return rows.map((r) => ({
    agent: String(r.agent ?? ""),
    totalCostUsd: Number(r.total_cost_usd ?? 0),
    eventCount: Number(r.event_count ?? 0),
  }));
}
