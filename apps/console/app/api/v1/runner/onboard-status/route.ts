import { NextRequest, NextResponse } from "next/server";
import { getLatestOnboardMemoryAt } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

/**
 * GET /api/v1/runner/onboard-status?repo=owner/name
 *
 * Lets the runner check a repo's onboarding recency — the workspace is derived
 * from the bearer token, the repo from the query — so it can skip a redundant
 * re-onboard when fresh onboarder notes already exist.
 *
 * 401 — bad/missing bearer. 400 — no `repo`. 502 — the store errored. 200 —
 * `{ onboardedAt: <iso>|null, count }` where onboardedAt is the newest
 * onboarder-written memory timestamp (null if never onboarded).
 */
export async function GET(request: NextRequest) {
  const auth = await requireBearer(request);
  if (auth instanceof NextResponse) {
    return auth;
  }
  const { workspaceId } = auth;

  const repo = request.nextUrl.searchParams.get("repo")?.trim();
  if (!repo) {
    return NextResponse.json({ error: "repo is required" }, { status: 400 });
  }

  let result;
  try {
    result = await getLatestOnboardMemoryAt(workspaceId, repo);
  } catch (err) {
    console.error("[runner/onboard-status] read failed:", err);
    return NextResponse.json({ error: "Upstream storage error" }, { status: 502 });
  }

  return NextResponse.json(
    {
      onboardedAt: result.onboardedAt ? result.onboardedAt.toISOString() : null,
      count: result.count,
    },
    { status: 200 }
  );
}
