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
import { createHash } from "crypto";
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

interface RawItem {
  path: string;
  reason: string;
  score: number;
  included: boolean;
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
  items?: RawItem[];
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
    (o.anchors_extracted === undefined || typeof o.anchors_extracted === "number")
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
            "Each event must have repository_id (string), run_id (string), context_pack_id (string), token_budget (number), tokens_used (number), sources_considered (number), occurred_at (string)",
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
    anchors_extracted: e.anchors_extracted ?? 0,
    sources_considered: e.sources_considered,
    occurred_at: e.occurred_at,
  }));

  let accepted = 0;
  try {
    accepted = await insertContextPacks(inputs);
  } catch (err) {
    console.error("[ingest/context-packs] ClickHouse insert failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }

  // Write context_events rows when items are present (non-fatal).
  const eventRows: ContextEventInput[] = [];
  for (const e of valid) {
    if (!Array.isArray(e.items) || e.items.length === 0) continue;
    const packId = deriveContextPackId(workspaceId, e.run_id, e.occurred_at);
    for (const item of e.items) {
      if (!item || typeof item.path !== "string" || !item.path) continue;
      eventRows.push({
        workspace_id: workspaceId,
        run_id: e.run_id,
        context_pack_id: packId,
        item_path: item.path,
        item_hash: createHash("sha1").update(item.path).digest("hex"),
        included: item.included ? 1 : 0,
        citation: "",
        reason: typeof item.reason === "string" ? item.reason : "",
        score: typeof item.score === "number" ? item.score : 0,
        occurred_at: e.occurred_at,
      });
    }
  }
  if (eventRows.length > 0) {
    insertContextEvents(eventRows).catch((err) => {
      console.error("[ingest/context-packs] context_events insert failed:", err);
    });
  }

  return NextResponse.json({ accepted }, { status: 202 });
}
