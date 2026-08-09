import { NextRequest, NextResponse } from "next/server";
import {
  createDraftAcceptanceRecordFromIntake,
  getJaceSessionByEveSessionId,
  validateAcceptanceContract,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../../lib/jace-console-auth";

function plainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function knownDraftErrorCode(error: unknown): "not_found" | "conflict" | null {
  if (!plainObject(error)) return null;
  return error.code === "not_found" || error.code === "conflict" ? error.code : null;
}

/**
 * Creates the first immutable draft Acceptance Record from a canonical
 * Intake. Human confirmation remains the approval-backed Contract seam; this
 * route cannot hand off work, create a PR, or authorize implementation.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ intakeId: string }> }
) {
  const unauthorized = requireJaceConsoleSecret(request);
  if (unauthorized) return unauthorized;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const eveSessionId = typeof body?.eveSessionId === "string" ? body.eveSessionId.trim() : "";
  const repo = typeof body?.repo === "string" ? body.repo.trim() : "";
  const contract = plainObject(body?.contract) ? body.contract : null;
  if (!eveSessionId || !repo || !contract) {
    return NextResponse.json(
      { error: "eveSessionId, repo, and a Contract object are required" },
      { status: 400 }
    );
  }
  const validation = validateAcceptanceContract(contract);
  if (!validation.ok) {
    return NextResponse.json(
      { error: "Acceptance Contract is incomplete", fields: validation.errors },
      { status: 400 }
    );
  }

  const { intakeId } = await params;
  const session = await getJaceSessionByEveSessionId(eveSessionId);
  if (!session?.workspaceId) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  try {
    const draft = await createDraftAcceptanceRecordFromIntake({
      workspaceId: session.workspaceId,
      intakeId,
      repo,
      contract,
      createdBy: "jace:acceptance-intake",
    });
    return NextResponse.json(
      {
        intake: { id: draft.intake.id, status: draft.intake.status },
        record: { id: draft.record.id, repo: draft.record.repo },
        contract: {
          id: draft.contract.id,
          version: draft.contract.version,
          status: draft.contract.status,
        },
      },
      { status: draft.created ? 201 : 200 }
    );
  } catch (error) {
    const code = knownDraftErrorCode(error);
    if (code === "not_found") {
      return NextResponse.json({ error: "Acceptance Intake not found" }, { status: 404 });
    }
    if (code === "conflict") {
      return NextResponse.json(
        { error: "Acceptance Intake is already bound to a different draft" },
        { status: 409 }
      );
    }
    console.error("[runner/acceptance-intakes/draft] failed:", error);
    return NextResponse.json(
      { error: "Failed to draft Acceptance Record" },
      { status: 502 }
    );
  }
}
