import { NextRequest, NextResponse } from "next/server";
import { readAcceptanceIntakeReadback } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";

/** A bounded Jace-only resume projection; never returns the raw conversation. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ intakeId: string }> }) {
  const unauthorized = requireJaceConsoleSecret(request);
  if (unauthorized) return unauthorized;
  const { intakeId: rawIntakeId } = await params;
  const intakeId = rawIntakeId.trim();
  const workspaceId = request.nextUrl.searchParams.get("workspaceId")?.trim() ?? "";
  if (!workspaceId || !intakeId) return NextResponse.json({ error: "workspaceId and intakeId are required" }, { status: 400 });

  try {
    const readback = await readAcceptanceIntakeReadback({ workspaceId, intakeId });
    if (!readback) return NextResponse.json({ error: "Acceptance Intake not found" }, { status: 404 });
    return NextResponse.json({ readback });
  } catch (error) {
    console.error("[runner/acceptance-intake-read] failed:", error);
    return NextResponse.json({ error: "Failed to read Acceptance Intake" }, { status: 502 });
  }
}
