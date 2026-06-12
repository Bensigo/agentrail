import { client } from "./client";
import type { ContextPackRecord, ContextEventRecord } from "./schema";

export interface ContextEventInput {
  workspace_id: string;
  run_id: string;
  context_pack_id: string;
  item_path: string;
  /** SHA1 or similar content hash; pass empty string when unavailable. */
  item_hash: string;
  /** 1 = included, 0 = excluded */
  included: number;
  citation: string;
  reason: string;
  score: number;
  occurred_at: string; // ISO 8601
}

export async function insertContextEvents(events: ContextEventInput[]): Promise<void> {
  if (events.length === 0) return;
  const rows = events.map((e) => ({
    workspace_id: e.workspace_id,
    run_id: e.run_id,
    context_pack_id: e.context_pack_id,
    item_path: e.item_path,
    item_hash: e.item_hash,
    included: e.included,
    citation: e.citation,
    reason: e.reason,
    score: e.score,
    occurred_at: new Date(e.occurred_at)
      .toISOString()
      .replace("T", " ")
      .replace("Z", ""),
  }));
  await client.insert({
    table: "context_events",
    values: rows,
    format: "JSONEachRow",
  });
}

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
        anchors_extracted,
        sources_considered,
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
    anchors_extracted: string | number;
    sources_considered: string | number;
    occurred_at: string;
  }>();
  return rows.map((r) => ({
    workspace_id: r.workspace_id,
    run_id: r.run_id,
    context_pack_id: r.context_pack_id,
    token_budget: Number(r.token_budget),
    tokens_used: Number(r.tokens_used),
    anchors_extracted: Number(r.anchors_extracted),
    sources_considered: Number(r.sources_considered),
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
        anchors_extracted,
        sources_considered,
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
    anchors_extracted: string | number;
    sources_considered: string | number;
    occurred_at: string;
  }>();
  return rows.map((r) => ({
    workspace_id: r.workspace_id,
    run_id: r.run_id,
    context_pack_id: r.context_pack_id,
    token_budget: Number(r.token_budget),
    tokens_used: Number(r.tokens_used),
    anchors_extracted: Number(r.anchors_extracted),
    sources_considered: Number(r.sources_considered),
    occurred_at: new Date(r.occurred_at),
  }));
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
