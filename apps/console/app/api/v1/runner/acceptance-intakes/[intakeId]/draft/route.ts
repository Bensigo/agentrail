import { NextRequest, NextResponse } from "next/server";
import { parseAcceptanceContract } from "@agentrail/contracts";
import { createDraftAcceptanceRecord, linkAcceptanceIntakeToRecord, readAcceptanceIntake } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../../lib/jace-console-auth";

/** Jace may propose a parsed draft; this endpoint has no confirmation or execution action. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ intakeId: string }> }) {
  const unauthorized = requireJaceConsoleSecret(request);
  if (unauthorized) return unauthorized;
  const { intakeId } = await params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
  const repo = typeof body?.repo === "string" ? body.repo.trim() : "";
  const contract = parseAcceptanceContract(body?.contract);
  if (!workspaceId || !repo || !contract.ok) {
    return NextResponse.json(contract.ok ? { error: "workspaceId and repo are required" } : { errors: contract.errors }, { status: 400 });
  }
  const intake = await readAcceptanceIntake({ workspaceId, intakeId });
  if (!intake) return NextResponse.json({ error: "Acceptance Intake not found" }, { status: 404 });
  if (intake.intake.recordId) return NextResponse.json({ error: "Acceptance Intake is already linked to an Acceptance Record" }, { status: 409 });
  try {
    const draft = await createDraftAcceptanceRecord({
      workspaceId, repo, originChannel: intake.intake.originChannel,
      sourceReferences: intake.intake.sourceReferences,
      workKey: `acceptance-intake:${intake.intake.id}`,
      contract: contract.value,
      createdBy: "jace:acceptance-intake",
    });
    const linked = await linkAcceptanceIntakeToRecord({ workspaceId, intakeId, recordId: draft.record.id });
    if (!linked) return NextResponse.json({ error: "Acceptance Intake link changed; draft was not authorized" }, { status: 409 });
    return NextResponse.json({
      intake: { id: linked.id, status: linked.status, recordId: linked.recordId },
      record: { id: draft.record.id, repo: draft.record.repo },
      contract: { id: draft.contract.id, version: draft.contract.version, status: draft.contract.status },
    }, { status: 201 });
  } catch (error) {
    console.error("[runner/acceptance-intake-draft] failed:", error);
    return NextResponse.json({ error: "Failed to create Acceptance Contract draft" }, { status: 502 });
  }
}
