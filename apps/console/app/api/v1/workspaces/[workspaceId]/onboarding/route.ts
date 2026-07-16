import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { loadOnboardingData } from "../../../../../../lib/onboarding-data";

/**
 * Onboarding wizard read model (#1233, spec §5). Any workspace member can
 * view it. This is the single endpoint the `/setup` wizard fetches on load
 * and polls thereafter — it doubles as the "runner connected" status source
 * (AC3: the runner step flips to connected without a manual refresh), so no
 * separate status endpoint exists.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const data = await loadOnboardingData(workspaceId);
    return NextResponse.json(data);
  } catch (err) {
    console.error("[onboarding] failed to load onboarding data:", err);
    return NextResponse.json(
      { error: "Failed to load onboarding status" },
      { status: 500 }
    );
  }
}
