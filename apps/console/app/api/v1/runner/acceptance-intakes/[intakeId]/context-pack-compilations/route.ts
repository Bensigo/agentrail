import { NextRequest, NextResponse } from "next/server";
import { enqueueAcceptanceContextPackCompilation, getRepositoryByName, readAcceptanceContracts, readAcceptanceIntake, readChangeRecordTimeline } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../../lib/jace-console-auth";

/** Admit only the confirmed Intake contract to the bounded compiler worker. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ intakeId: string }> }) {
  const unauthorized = requireJaceConsoleSecret(request);
  if (unauthorized) return unauthorized;
  const { intakeId: rawIntakeId } = await params;
  const intakeId = rawIntakeId.trim();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
  if (!workspaceId || !intakeId) return NextResponse.json({ error: "workspaceId and intakeId are required" }, { status: 400 });
  try {
    const intake = await readAcceptanceIntake({ workspaceId, intakeId });
    if (!intake?.intake.recordId) return NextResponse.json({ error: "Acceptance Intake record not found" }, { status: 404 });
    const contracts = await readAcceptanceContracts({ workspaceId, recordId: intake.intake.recordId });
    const contract = contracts?.find((item) => item.status === "confirmed");
    if (!contract) return NextResponse.json({ error: "A confirmed Acceptance Contract is required before Context Pack compilation" }, { status: 409 });
    const record = await readChangeRecordTimeline({ workspaceId, recordId: intake.intake.recordId });
    if (!record) return NextResponse.json({ error: "Acceptance Record not found" }, { status: 404 });
    const repository = await getRepositoryByName(workspaceId, record.record.repo);
    if (!repository) return NextResponse.json({ error: "Acceptance Record repository not found" }, { status: 404 });
    const result = await enqueueAcceptanceContextPackCompilation({
      workspaceId, recordId: intake.intake.recordId, repositoryId: repository.id,
      contractId: contract.id, contractVersion: contract.version, phase: "execute",
      createdBy: "jace:acceptance-intake-context-pack",
    });
    return NextResponse.json({ compilation: { id: result.compilation.id, status: result.compilation.status, phase: result.compilation.phase, acceptanceContractId: result.compilation.acceptanceContractId, acceptanceContractVersion: result.compilation.acceptanceContractVersion }, inserted: result.inserted }, { status: result.inserted ? 201 : 200 });
  } catch (error) {
    console.error("[runner/acceptance-intake-context-pack] failed:", error);
    return NextResponse.json({ error: "Context Pack compilation could not be admitted" }, { status: 502 });
  }
}
