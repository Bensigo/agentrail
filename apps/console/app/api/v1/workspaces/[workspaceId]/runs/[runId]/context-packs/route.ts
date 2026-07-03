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
        // Read-grounded live diagnostics (issue #1037) ride the migration-free
        // context_events channel, tagged by reason so they can be split back out
        // here without a dedicated ClickHouse column:
        //   live_waste — a pack file the executor never read (precision waste).
        //   live_miss  — a file the executor fetched itself, not in the pack
        //                (recall miss). These must NOT pollute the ordinary
        //                included/excluded retrieval lists below.
        const isLive = (reason: string) =>
          reason === "live_waste" || reason === "live_miss";
        const included = items
          .filter((i) => i.included === 1 && !isLive(i.reason))
          .map((i) => ({
            path: i.item_path,
            citation: i.citation,
            reason: i.reason,
            score: i.score,
          }));
        const excluded = items
          .filter((i) => i.included === 0 && !isLive(i.reason))
          .map((i) => ({
            path: i.item_path,
            reason: i.reason,
          }));
        const waste = items
          .filter((i) => i.reason === "live_waste")
          .map((i) => ({ path: i.item_path }));
        const miss = items
          .filter((i) => i.reason === "live_miss")
          .map((i) => ({ path: i.item_path }));
        return {
          context_pack_id: pack.context_pack_id,
          token_budget: pack.token_budget,
          tokens_used: pack.tokens_used,
          tokens_saved: pack.tokens_saved,
          anchors_extracted: pack.anchors_extracted,
          sources_considered: pack.sources_considered,
          occurred_at: pack.occurred_at.toISOString(),
          included,
          excluded,
          // Per-run read-grounded waste/miss (AC4: persisted and drillable).
          waste,
          miss,
        };
      })
    );

    return NextResponse.json({ context_packs: packsWithItems });
  } catch {
    // A 200 with no packs would make a ClickHouse outage indistinguishable
    // from a run that genuinely recorded none; surface the failure instead.
    return NextResponse.json(
      { error: "Failed to load context packs" },
      { status: 500 }
    );
  }
}
