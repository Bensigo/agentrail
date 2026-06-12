import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { getRunCosts } from "@agentrail/db-clickhouse";

export async function GET(
  _request: NextRequest,
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

  try {
    const rows = await getRunCosts(workspaceId, runId);
    const totals = rows.reduce(
      (acc, r) => ({
        total_cost_usd: acc.total_cost_usd + r.cost_usd,
        input_tokens: acc.input_tokens + r.input_tokens,
        output_tokens: acc.output_tokens + r.output_tokens,
        cache_tokens: acc.cache_tokens + r.cache_tokens,
        tokens: acc.tokens + r.tokens,
      }),
      { total_cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_tokens: 0, tokens: 0 }
    );
    return NextResponse.json({ rows, totals });
  } catch {
    return NextResponse.json({ rows: [], totals: { total_cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_tokens: 0, tokens: 0 } });
  }
}
