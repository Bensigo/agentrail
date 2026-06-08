import { NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { getContextPacks } from "@agentrail/db-clickhouse";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ workspaceId: string; runId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId, runId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let events: Awaited<ReturnType<typeof getContextPacks>> = [];
  try {
    events = await getContextPacks(workspaceId, runId);
  } catch {
    // ClickHouse may not be available
  }

  const packsMap = new Map<string, {
    context_pack_id: string;
    token_budget: number;
    tokens_used: number;
    anchors_extracted: number;
    sources_considered: number;
    included: Array<{ path: string; citation: string; reason: string; score: number }>;
    excluded: Array<{ path: string; reason: string }>;
  }>();

  for (const evt of events) {
    if (!packsMap.has(evt.context_pack_id)) {
      packsMap.set(evt.context_pack_id, {
        context_pack_id: evt.context_pack_id,
        token_budget: evt.token_budget,
        tokens_used: evt.tokens_used,
        anchors_extracted: evt.anchors_extracted,
        sources_considered: evt.sources_considered,
        included: [],
        excluded: [],
      });
    }
    const pack = packsMap.get(evt.context_pack_id)!;
    if (evt.included) {
      pack.included.push({
        path: evt.item_path,
        citation: evt.citation,
        reason: evt.reason,
        score: evt.score,
      });
    } else {
      pack.excluded.push({
        path: evt.item_path,
        reason: evt.reason,
      });
    }
  }

  return NextResponse.json({ packs: Array.from(packsMap.values()) });
}
