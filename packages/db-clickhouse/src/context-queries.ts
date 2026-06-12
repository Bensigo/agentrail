import { client } from "./client";
import type { ContextPackRecord, ContextEventRecord } from "./schema";

export async function getContextPacksForRun(
  workspaceId: string,
  runId: string
): Promise<ContextPackRecord[]> {
  const result = await client.query({
    query: `
      SELECT
        workspace_id,
        run_id,
        context_pack_id,
        token_budget,
        tokens_used,
        tokens_saved,
        anchors_extracted,
        sources_considered,
        precision_at_budget,
        citation_coverage,
        stale_count,
        denied_count,
        source_hash_list,
        occurred_at
      FROM context_packs
      WHERE workspace_id = {workspaceId: String}
        AND run_id = {runId: String}
      ORDER BY occurred_at ASC
    `,
    query_params: { workspaceId, runId },
    format: "JSONEachRow",
  });
  const rows = await result.json<{
    workspace_id: string;
    run_id: string;
    context_pack_id: string;
    token_budget: string | number;
    tokens_used: string | number;
    tokens_saved: string | number;
    anchors_extracted: string | number;
    sources_considered: string | number;
    precision_at_budget: string | number;
    citation_coverage: string | number;
    stale_count: string | number;
    denied_count: string | number;
    source_hash_list: string[];
    occurred_at: string;
  }>();
  return rows.map((r) => ({
    workspace_id: r.workspace_id,
    run_id: r.run_id,
    context_pack_id: r.context_pack_id,
    token_budget: Number(r.token_budget),
    tokens_used: Number(r.tokens_used),
    tokens_saved: Number(r.tokens_saved),
    anchors_extracted: Number(r.anchors_extracted),
    sources_considered: Number(r.sources_considered),
    precision_at_budget: Number(r.precision_at_budget),
    citation_coverage: Number(r.citation_coverage),
    stale_count: Number(r.stale_count),
    denied_count: Number(r.denied_count),
    source_hash_list: r.source_hash_list ?? [],
    occurred_at: new Date(r.occurred_at),
  }));
}

/** Recent context packs across all runs in a workspace (newest first). */
export async function getWorkspaceContextPacks(
  workspaceId: string,
  limit = 100
): Promise<ContextPackRecord[]> {
  const result = await client.query({
    query: `
      SELECT
        workspace_id,
        run_id,
        context_pack_id,
        token_budget,
        tokens_used,
        tokens_saved,
        anchors_extracted,
        sources_considered,
        precision_at_budget,
        citation_coverage,
        stale_count,
        denied_count,
        source_hash_list,
        occurred_at
      FROM context_packs
      WHERE workspace_id = {workspaceId: String}
      ORDER BY occurred_at DESC
      LIMIT {limit: UInt32}
    `,
    query_params: { workspaceId, limit },
    format: "JSONEachRow",
  });
  const rows = await result.json<{
    workspace_id: string;
    run_id: string;
    context_pack_id: string;
    token_budget: string | number;
    tokens_used: string | number;
    tokens_saved: string | number;
    anchors_extracted: string | number;
    sources_considered: string | number;
    precision_at_budget: string | number;
    citation_coverage: string | number;
    stale_count: string | number;
    denied_count: string | number;
    source_hash_list: string[];
    occurred_at: string;
  }>();
  return rows.map((r) => ({
    workspace_id: r.workspace_id,
    run_id: r.run_id,
    context_pack_id: r.context_pack_id,
    token_budget: Number(r.token_budget),
    tokens_used: Number(r.tokens_used),
    tokens_saved: Number(r.tokens_saved),
    anchors_extracted: Number(r.anchors_extracted),
    sources_considered: Number(r.sources_considered),
    precision_at_budget: Number(r.precision_at_budget),
    citation_coverage: Number(r.citation_coverage),
    stale_count: Number(r.stale_count),
    denied_count: Number(r.denied_count),
    source_hash_list: r.source_hash_list ?? [],
    occurred_at: new Date(r.occurred_at),
  }));
}

export interface ListWorkspaceContextPacksOptions {
  limit?: number;
  cursor?: string;
}

/**
 * Cursor-paginated workspace context packs, newest first. The cursor is a
 * composite "<occurred_at_iso>|<context_pack_id>" so ties on occurred_at page
 * deterministically (mirrors listWorkspaceFailures). Fetches limit+1 to detect
 * whether more pages exist.
 */
export async function listWorkspaceContextPacks(
  workspaceId: string,
  opts: ListWorkspaceContextPacksOptions = {}
): Promise<{ packs: ContextPackRecord[]; nextCursor: string | null }> {
  const { limit = 50, cursor } = opts;

  const conditions: string[] = ["workspace_id = {workspaceId: String}"];
  const queryParams: Record<string, unknown> = { workspaceId };

  if (cursor) {
    const separatorIndex = cursor.indexOf("|");
    if (separatorIndex !== -1) {
      const cursorTs = cursor.slice(0, separatorIndex).replace("T", " ").replace("Z", "");
      const cursorId = cursor.slice(separatorIndex + 1);
      conditions.push(
        "(occurred_at, context_pack_id) < ({cursorTs: DateTime64(3)}, {cursorId: String})"
      );
      queryParams.cursorTs = cursorTs;
      queryParams.cursorId = cursorId;
    } else {
      conditions.push("occurred_at < {cursor: DateTime64(3)}");
      queryParams.cursor = cursor;
    }
  }

  const fetchLimit = limit + 1;
  const result = await client.query({
    query: `
      SELECT
        workspace_id,
        run_id,
        context_pack_id,
        token_budget,
        tokens_used,
        tokens_saved,
        anchors_extracted,
        sources_considered,
        precision_at_budget,
        citation_coverage,
        stale_count,
        denied_count,
        source_hash_list,
        occurred_at
      FROM context_packs
      WHERE ${conditions.join(" AND ")}
      ORDER BY occurred_at DESC, context_pack_id DESC
      LIMIT ${fetchLimit}
    `,
    query_params: queryParams,
    format: "JSONEachRow",
  });
  const rows = await result.json<{
    workspace_id: string;
    run_id: string;
    context_pack_id: string;
    token_budget: string | number;
    tokens_used: string | number;
    tokens_saved: string | number;
    anchors_extracted: string | number;
    sources_considered: string | number;
    precision_at_budget: string | number;
    citation_coverage: string | number;
    stale_count: string | number;
    denied_count: string | number;
    source_hash_list: string[];
    occurred_at: string;
  }>();

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const packs: ContextPackRecord[] = page.map((r) => ({
    workspace_id: r.workspace_id,
    run_id: r.run_id,
    context_pack_id: r.context_pack_id,
    token_budget: Number(r.token_budget),
    tokens_used: Number(r.tokens_used),
    tokens_saved: Number(r.tokens_saved),
    anchors_extracted: Number(r.anchors_extracted),
    sources_considered: Number(r.sources_considered),
    precision_at_budget: Number(r.precision_at_budget),
    citation_coverage: Number(r.citation_coverage),
    stale_count: Number(r.stale_count),
    denied_count: Number(r.denied_count),
    source_hash_list: r.source_hash_list ?? [],
    occurred_at: new Date(r.occurred_at),
  }));
  const last = packs[packs.length - 1];
  const nextCursor = hasMore && last
    ? `${last.occurred_at.toISOString()}|${last.context_pack_id}`
    : null;

  return { packs, nextCursor };
}

export async function getContextPackItems(
  workspaceId: string,
  runId: string,
  contextPackId: string
): Promise<ContextEventRecord[]> {
  const result = await client.query({
    query: `
      SELECT
        workspace_id,
        run_id,
        context_pack_id,
        item_path,
        item_hash,
        included,
        citation,
        reason,
        score,
        occurred_at
      FROM context_events
      WHERE workspace_id = {workspaceId: String}
        AND run_id = {runId: String}
        AND context_pack_id = {contextPackId: String}
      ORDER BY score DESC
    `,
    query_params: { workspaceId, runId, contextPackId },
    format: "JSONEachRow",
  });
  const rows = await result.json<{
    workspace_id: string;
    run_id: string;
    context_pack_id: string;
    item_path: string;
    item_hash: string;
    included: string | number;
    citation: string;
    reason: string;
    score: string | number;
    occurred_at: string;
  }>();
  return rows.map((r) => ({
    workspace_id: r.workspace_id,
    run_id: r.run_id,
    context_pack_id: r.context_pack_id,
    item_path: r.item_path,
    item_hash: r.item_hash,
    included: Number(r.included),
    citation: r.citation,
    reason: r.reason,
    score: Number(r.score),
    occurred_at: new Date(r.occurred_at),
  }));
}

/**
 * Tokens saved per run, mirroring the run-detail "Tokens saved" card:
 * context-retrieval savings (sum of context_packs.tokens_saved) plus tokens
 * served from cache (sum of cost_events.cache_tokens). Returned as a map keyed
 * by run_id for cheap enrichment of the runs list. Runs absent from both tables
 * simply don't appear (caller defaults to 0). One query per table, scoped to
 * the given run ids.
 */
export async function getTokensSavedByRun(
  workspaceId: string,
  runIds: string[]
): Promise<Map<string, number>> {
  const saved = new Map<string, number>();
  if (runIds.length === 0) return saved;

  const params: Record<string, unknown> = { workspaceId, runIds };

  const packResult = await client.query({
    query: `
      SELECT run_id, sum(tokens_saved) AS tokens_saved
      FROM context_packs
      WHERE workspace_id = {workspaceId: String}
        AND run_id IN {runIds: Array(String)}
      GROUP BY run_id
    `,
    query_params: params,
    format: "JSONEachRow",
  });
  for (const r of await packResult.json<{ run_id: string; tokens_saved: string | number }>()) {
    saved.set(r.run_id, Number(r.tokens_saved));
  }

  const cacheResult = await client.query({
    query: `
      SELECT run_id, sum(cache_tokens) AS cache_tokens
      FROM cost_events
      WHERE workspace_id = {workspaceId: String}
        AND run_id IN {runIds: Array(String)}
      GROUP BY run_id
    `,
    query_params: params,
    format: "JSONEachRow",
  });
  for (const r of await cacheResult.json<{ run_id: string; cache_tokens: string | number }>()) {
    saved.set(r.run_id, (saved.get(r.run_id) ?? 0) + Number(r.cache_tokens));
  }

  return saved;
}
