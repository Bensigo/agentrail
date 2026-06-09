import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import {
  getContextPacksForRun,
  getContextPackItems,
} from "@agentrail/db-clickhouse";

export async function GET(
  _request: NextRequest,
  {
    params,
  }: { params: Promise<{ workspaceId: string; runId: string }> }
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

  try {
    const packs = await getContextPacksForRun(workspaceId, runId);

    const packsWithItems = await Promise.all(
      packs.map(async (pack) => {
        const items = await getContextPackItems(
          workspaceId,
          runId,
          pack.context_pack_id
        );
        const included = items
          .filter((i) => i.included === 1)
          .map((i) => ({
            path: i.item_path,
            citation: i.citation,
            reason: i.reason,
            score: i.score,
          }));
        const excluded = items
          .filter((i) => i.included === 0)
          .map((i) => ({
            path: i.item_path,
            reason: i.reason,
          }));
        return {
          context_pack_id: pack.context_pack_id,
          token_budget: pack.token_budget,
          tokens_used: pack.tokens_used,
          anchors_extracted: pack.anchors_extracted,
          sources_considered: pack.sources_considered,
          occurred_at: pack.occurred_at.toISOString(),
          included,
          excluded,
        };
      })
    );

    return NextResponse.json({ context_packs: packsWithItems });
  } catch {
    // ClickHouse unavailable
    return NextResponse.json({ context_packs: [] });
  }
}
