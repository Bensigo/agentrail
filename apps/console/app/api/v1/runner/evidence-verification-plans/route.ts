import { NextRequest, NextResponse } from "next/server";
import { parseAcceptanceContract } from "@agentrail/contracts";
import { parseUiVerificationSteps, readAcceptanceContracts, recordEvidenceVerificationPlans, type UiVerificationStep } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";

const modalities = new Set(["ui", "api", "job", "data"]);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const object = (value: unknown): value is Record<string, unknown> => value != null && typeof value === "object" && !Array.isArray(value);
const apiRequest = (value: unknown): { method: "GET"; path: string; expectedStatus: number } | null => {
  if (!object(value) || value.method !== "GET" || !text(value.path) || !value.path.startsWith("/") || value.path.startsWith("//") || value.path.includes("\\\\") || !Number.isInteger(value.expectedStatus) || value.expectedStatus < 100 || value.expectedStatus > 599) return null;
  return { method: "GET", path: value.path, expectedStatus: value.expectedStatus as number };
};

/** Plans safe criterion proof; this endpoint cannot report a proof or a pass. */
export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const required = ["workspaceId", "recordId", "prRevisionId", "contractId", "plannedBy"];
  if (!object(body) || required.some((key) => !text(body[key])) || !Number.isInteger(body.contractVersion) || !Array.isArray(body.plans) || body.plans.length === 0) {
    return NextResponse.json({ error: "invalid verification plan payload" }, { status: 400 });
  }
  const contracts = await readAcceptanceContracts({ workspaceId: body.workspaceId, recordId: body.recordId });
  const contractRow = contracts?.find((row) => row.id === body.contractId && row.version === body.contractVersion && row.status === "confirmed");
  if (!contractRow) return NextResponse.json({ error: "confirmed Acceptance Contract not found" }, { status: 409 });
  const parsed = parseAcceptanceContract(contractRow.contract);
  if (!parsed.ok) return NextResponse.json({ error: "stored Acceptance Contract is invalid" }, { status: 500 });
  const byId = new Map(parsed.value.acceptanceCriteria.map((criterion) => [criterion.id, criterion]));
  const plans: Array<{ criterionId: string; criterionTextSnapshot: string; modality: string; environmentId?: string; flow?: string; uiSteps?: UiVerificationStep[]; apiRequest?: { method: "GET"; path: string; expectedStatus: number }; expectedBehavior: string; status: "planned" | "not_testable"; notTestableReason?: string }> = [];
  const seen = new Set<string>();
  for (const raw of body.plans) {
    if (!object(raw) || !text(raw.criterionId) || !modalities.has(raw.modality as string) || (raw.status !== "planned" && raw.status !== "not_testable")) {
      return NextResponse.json({ error: "each plan needs a known criterion, ui/api/job/data modality, and planned/not_testable status" }, { status: 400 });
    }
    const criterion = byId.get(raw.criterionId);
    if (!criterion || seen.has(criterion.id)) return NextResponse.json({ error: "verification plans must have unique confirmed criterion ids" }, { status: 400 });
    seen.add(criterion.id);
    if (criterion.userVisible && raw.status === "planned" && raw.modality !== "ui") return NextResponse.json({ error: `user-visible criterion ${criterion.id} requires ui proof or explicit not_testable` }, { status: 400 });
    if (raw.status === "planned" && (raw.modality === "job" || raw.modality === "data")) return NextResponse.json({ error: `planned criterion ${criterion.id} with modality ${raw.modality} has no supported safe executor and must be recorded as not_testable with a concrete reason` }, { status: 400 });
    if (raw.status === "planned" && (!text(raw.environmentId) || !text(raw.flow))) return NextResponse.json({ error: `planned criterion ${criterion.id} needs environmentId and criterion-specific flow` }, { status: 400 });
    const uiSteps = raw.modality === "ui" && raw.status === "planned" ? parseUiVerificationSteps(raw.uiSteps) : undefined;
    if (raw.modality === "ui" && raw.status === "planned" && (!uiSteps || !uiSteps.ok)) return NextResponse.json({ error: `planned UI criterion ${criterion.id} needs safe uiSteps: ${uiSteps?.error ?? "missing action list"}` }, { status: 400 });
    const requestDescriptor = raw.modality === "api" && raw.status === "planned" ? apiRequest(raw.apiRequest) : undefined;
    if (raw.modality === "api" && raw.status === "planned" && !requestDescriptor) return NextResponse.json({ error: `planned API criterion ${criterion.id} needs a safe GET path and expected status` }, { status: 400 });
    if (raw.status === "not_testable" && !text(raw.notTestableReason)) return NextResponse.json({ error: `not_testable criterion ${criterion.id} needs a reason` }, { status: 400 });
    plans.push({ criterionId: criterion.id, criterionTextSnapshot: criterion.text, modality: raw.modality as string, environmentId: text(raw.environmentId) ? raw.environmentId : undefined, flow: text(raw.flow) ? raw.flow : undefined, ...(uiSteps?.ok ? { uiSteps: uiSteps.value } : {}), ...(requestDescriptor ? { apiRequest: requestDescriptor } : {}), expectedBehavior: criterion.text, status: raw.status, notTestableReason: text(raw.notTestableReason) ? raw.notTestableReason : undefined });
  }
  if (seen.size !== byId.size) return NextResponse.json({ error: "every confirmed Acceptance Contract criterion needs a verification plan" }, { status: 400 });
  try {
    const result = await recordEvidenceVerificationPlans({ workspaceId: body.workspaceId, recordId: body.recordId, prRevisionId: body.prRevisionId, contractId: body.contractId, contractVersion: body.contractVersion, plannedBy: body.plannedBy, plans });
    return NextResponse.json({ plans: result.plans.map((plan) => ({ id: plan.id, criterionId: plan.criterionId, modality: plan.modality, environmentId: plan.environmentId, flow: plan.flow, uiSteps: plan.uiSteps, status: plan.status })), inserted: result.inserted }, { status: result.inserted ? 201 : 200 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to persist verification plan" }, { status: 409 });
  }
}
