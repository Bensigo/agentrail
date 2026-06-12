/**
 * POST /api/v1/ingest/context-packs
 *
 * Accepts a single context pack or an array of up to 100.
 * Authenticates via bearer API key (see lib/bearer-auth.ts).
 * workspace_id comes from the API key; repository_id is validated to belong
 * to that workspace (but is not stored — used for access control only).
 *
 * Returns: 202 { accepted: N }
 */
import { NextRequest, NextResponse } from "next/server";
import {
  insertContextPacks,
  insertContextEvents,
  deriveContextPackId,
  ContextPackInput,
  ContextEventInput,
} from "@agentrail/db-clickhouse";
import { getRepository } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

interface RawContextItem {
  path: string;
  reason?: string;
  score?: number;
  included?: boolean;
}

interface RawContextPack {
  repository_id: string;
  run_id: string;
  context_pack_id: string;
  token_budget: number;
  tokens_used: number;
  sources_considered: number;
  occurred_at: string;
  anchors_extracted?: number;
  /** Estimated tokens saved by bounded retrieval vs reading full files. */
  tokens_saved?: number;
  items?: RawContextItem[];
}

function isRawContextItem(v: unknown): v is RawContextItem {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.path === "string" &&
    (o.reason === undefined || typeof o.reason === "string") &&
    (o.score === undefined || typeof o.score === "number") &&
    (o.included === undefined || typeof o.included === "boolean")
  );
}

function isRawContextPack(v: unknown): v is RawContextPack {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.repository_id === "string" &&
    typeof o.run_id === "string" &&
    typeof o.context_pack_id === "string" &&
    typeof o.token_budget === "number" &&
    typeof o.tokens_used === "number" &&
    typeof o.sources_considered === "number" &&
    typeof o.occurred_at === "string" &&
    (o.anchors_extracted === undefined || typeof o.anchors_extracted === "number") &&
    (o.tokens_saved === undefined || typeof o.tokens_saved === "number") &&
    (o.items === undefined ||
      (Array.isArray(o.items) &&
        o.items.length <= 100 &&
        o.items.every(isRawContextItem)))
  );
}

export async function POST(req: NextRequest) {
  const auth = await requireBearer(req);
  if (auth instanceof NextResponse) return auth;
  const { workspaceId } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const raw: unknown[] = Array.isArray(body) ? body : [body];
  if (raw.length === 0 || raw.length > 100) {
    return NextResponse.json(
      { error: "Batch must contain 1–100 events" },
      { status: 400 }
    );
  }

  const valid: RawContextPack[] = [];
  for (const item of raw) {
    if (!isRawContextPack(item)) {
      return NextResponse.json(
        {
          error:
            "Each event must have repository_id (string), run_id (string), context_pack_id (string), token_budget (number), tokens_used (number), sources_considered (number), occurred_at (string); optional tokens_saved (number); optional items is an array of up to 100 {path, reason?, score?, included?} objects",
        },
        { status: 400 }
      );
    }
    valid.push(item);
  }

  for (const e of valid) {
    const repo = await getRepository(workspaceId, e.repository_id);
    if (!repo) {
      return NextResponse.json(
        { error: `Repository ${e.repository_id} not found in this workspace` },
        { status: 404 }
      );
    }
  }

  const inputs: ContextPackInput[] = valid.map((e) => ({
    workspace_id: workspaceId,
    run_id: e.run_id,
    token_budget: e.token_budget,
    tokens_used: e.tokens_used,
    tokens_saved: e.tokens_saved ?? 0,
    anchors_extracted: e.anchors_extracted ?? 0,
    sources_considered: e.sources_considered,
    occurred_at: e.occurred_at,
  }));

  // Items live in context_events keyed by the server-derived pack id (the
  // client-supplied context_pack_id is not stored — see insertContextPacks).
  const itemInputs: ContextEventInput[] = valid.flatMap((e) =>
    (e.items ?? []).map((item) => ({
      workspace_id: workspaceId,
      run_id: e.run_id,
      context_pack_id: deriveContextPackId(workspaceId, e.run_id, e.occurred_at),
      item_path: item.path,
      item_hash: "",
      included: item.included === false ? 0 : 1,
      citation: "",
      reason: item.reason ?? "",
      score: item.score ?? 0,
      occurred_at: e.occurred_at,
    }))
  );

  let accepted = 0;
  try {
    accepted = await insertContextPacks(inputs);
    if (itemInputs.length > 0) {
      await insertContextEvents(itemInputs);
    }
  } catch (err) {
    console.error("[ingest/context-packs] ClickHouse insert failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }

  return NextResponse.json({ accepted }, { status: 202 });
}
