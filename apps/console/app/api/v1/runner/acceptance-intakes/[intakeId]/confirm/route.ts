import { NextRequest, NextResponse } from "next/server";
import { confirmAcceptanceContract, readAcceptanceContracts, readAcceptanceIntake } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../../lib/jace-console-auth";

/** Confirm only from a distinct, post-draft inbound source-channel message. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ intakeId: string }> }) {
  const unauthorized = requireJaceConsoleSecret(request);
  if (unauthorized) return unauthorized;
  const { intakeId: rawIntakeId } = await params;
  const intakeId = rawIntakeId.trim();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
  const confirmationSourceKey = typeof body?.confirmationSourceKey === "string" ? body.confirmationSourceKey.trim() : "";
  const version = body?.version;
  if (!workspaceId || !intakeId || !confirmationSourceKey || !Number.isInteger(version) || (version as number) < 1) {
    return NextResponse.json({ error: "workspaceId, confirmationSourceKey, and a positive contract version are required" }, { status: 400 });
  }
  try {
    const intake = await readAcceptanceIntake({ workspaceId, intakeId });
    if (!intake?.intake.recordId) return NextResponse.json({ error: "Acceptance Intake draft not found" }, { status: 404 });
    const contracts = await readAcceptanceContracts({ workspaceId, recordId: intake.intake.recordId });
    const draft = contracts?.find((contract) => contract.version === version && contract.status === "draft");
    const sourceMessage = intake.messages.find((message) => message.direction === "inbound" && message.sourceKey === confirmationSourceKey);
    if (!draft || !sourceMessage || sourceMessage.createdAt <= draft.createdAt) {
      return NextResponse.json({ error: "Confirmation must come from a new inbound channel message after this draft" }, { status: 409 });
    }
    const contract = await confirmAcceptanceContract({
      workspaceId,
      recordId: intake.intake.recordId,
      version: version as number,
      confirmedBy: `human:channel:${intake.intake.originChannel}:${confirmationSourceKey}`,
    });
    return NextResponse.json({ contract: { id: contract.id, version: contract.version, status: contract.status } });
  } catch (error) {
    console.error("[runner/acceptance-intake-confirm] failed:", error);
    return NextResponse.json({ error: "Acceptance Contract confirmation was refused" }, { status: 409 });
  }
}
