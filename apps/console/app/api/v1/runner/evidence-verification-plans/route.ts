import { NextRequest, NextResponse } from "next/server";
import { parseAcceptanceContract } from "@agentrail/contracts";
import { parseDataVerificationRequest, parseUiVerificationSteps, readAcceptanceContracts, recordEvidenceVerificationPlans, type DataVerificationAssertion, type UiVerificationStep } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";

const modalities = new Set(["ui", "api", "job", "data"]);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const object = (value: unknown): value is Record<string, unknown> => value != null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isInteger(value);
const isModality = (value: unknown): value is "ui" | "api" | "job" | "data" => typeof value === "string" && modalities.has(value);
const isPlanStatus = (value: unknown): value is "planned" | "not_testable" => value === "planned" || value === "not_testable";
const apiRequest = (value: unknown): { method: "GET"; path: string; expectedStatus: number } | null => {
  if (!object(value) || value.method !== "GET") return null;
  const path = value.path;
  const expectedStatus = value.expectedStatus;
  if (!text(path) || !path.startsWith("/") || path.startsWith("//") || path.includes("\\\\") || !integer(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) return null;
  return { method: "GET", path, expectedStatus };
};

/** Plans safe criterion proof; this endpoint cannot report a proof or a pass. */
export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;
  const parsed = await request.json().catch(() => null);
  if (!object(parsed)) {
    return NextResponse.json({ error: "invalid verification plan payload" }, { status: 400 });
  }
  const body = parsed;
  const workspaceId = body.workspaceId;
  const recordId = body.recordId;
  const prRevisionId = body.prRevisionId;
  const contractId = body.contractId;
  const plannedBy = body.plannedBy;
  const contractVersion = body.contractVersion;
  const plansInput = body.plans;
  if (!text(workspaceId) || !text(recordId) || !text(prRevisionId) || !text(contractId) || !text(plannedBy) || !integer(contractVersion) || !Array.isArray(plansInput) || plansInput.length === 0) {
    return NextResponse.json({ error: "invalid verification plan payload" }, { status: 400 });
  }
  const contracts = await readAcceptanceContracts({ workspaceId, recordId });
  const contractRow = contracts?.find((row) => row.id === contractId && row.version === contractVersion && row.status === "confirmed");
  if (!contractRow) return NextResponse.json({ error: "confirmed Acceptance Contract not found" }, { status: 409 });
  const contractParse = parseAcceptanceContract(contractRow.contract);
  if (!contractParse.ok) return NextResponse.json({ error: "stored Acceptance Contract is invalid" }, { status: 500 });
  const byId = new Map(contractParse.value.acceptanceCriteria.map((criterion) => [criterion.id, criterion]));
  type PersistedPlan = {
    criterionId: string;
    criterionTextSnapshot: string;
    modality: "ui" | "api" | "job" | "data";
    environmentId?: string;
    flow?: string;
    uiSteps?: UiVerificationStep[];
    apiRequest?: { method: "GET"; path: string; expectedStatus: number };
    dataRequest?: { method: "GET"; path: string; expectedStatus: number; expectedJson: DataVerificationAssertion[] };
    expectedBehavior: string;
    status: "planned" | "not_testable";
    notTestableReason?: string;
  };
  const plans: PersistedPlan[] = [];
  const seen = new Set<string>();
  for (const raw of plansInput) {
    if (!object(raw) || !text(raw.criterionId) || !isModality(raw.modality) || !isPlanStatus(raw.status)) {
      return NextResponse.json({ error: "each plan needs a known criterion, ui/api/job/data modality, and planned/not_testable status" }, { status: 400 });
    }
    const criterionId = raw.criterionId;
    const modality = raw.modality;
    const status = raw.status;
    const environmentId = raw.environmentId;
    const flow = raw.flow;
    const notTestableReason = raw.notTestableReason;
    const criterion = byId.get(criterionId);
    if (!criterion || seen.has(criterion.id)) return NextResponse.json({ error: "verification plans must have unique confirmed criterion ids" }, { status: 400 });
    seen.add(criterion.id);
    if (criterion.userVisible && status === "planned" && modality !== "ui") return NextResponse.json({ error: `user-visible criterion ${criterion.id} requires ui proof or explicit not_testable` }, { status: 400 });
    if (status === "planned" && modality === "job") return NextResponse.json({ error: `planned criterion ${criterion.id} with modality job has no supported safe executor and must be recorded as not_testable with a concrete reason` }, { status: 400 });
    if (status === "planned" && (!text(environmentId) || !text(flow))) return NextResponse.json({ error: `planned criterion ${criterion.id} needs environmentId and criterion-specific flow` }, { status: 400 });
    const uiSteps = modality === "ui" && status === "planned" ? parseUiVerificationSteps(raw.uiSteps) : undefined;
    if (modality === "ui" && status === "planned" && (!uiSteps || !uiSteps.ok)) return NextResponse.json({ error: `planned UI criterion ${criterion.id} needs safe uiSteps: ${uiSteps?.error ?? "missing action list"}` }, { status: 400 });
    const requestDescriptor = modality === "api" && status === "planned" ? apiRequest(raw.apiRequest) : undefined;
    if (modality === "api" && status === "planned" && !requestDescriptor) return NextResponse.json({ error: `planned API criterion ${criterion.id} needs a safe GET path and expected status` }, { status: 400 });
    const dataDescriptor = modality === "data" && status === "planned" ? parseDataVerificationRequest(raw.dataRequest) : undefined;
    if (modality === "data" && status === "planned" && (!dataDescriptor || !dataDescriptor.ok)) return NextResponse.json({ error: `planned data criterion ${criterion.id} needs a safe GET readback descriptor: ${dataDescriptor?.error ?? "missing dataRequest"}` }, { status: 400 });
    if (status === "not_testable" && !text(notTestableReason)) return NextResponse.json({ error: `not_testable criterion ${criterion.id} needs a reason` }, { status: 400 });
    plans.push({ criterionId: criterion.id, criterionTextSnapshot: criterion.text, modality, environmentId: text(environmentId) ? environmentId : undefined, flow: text(flow) ? flow : undefined, ...(uiSteps?.ok ? { uiSteps: uiSteps.value } : {}), ...(requestDescriptor ? { apiRequest: requestDescriptor } : {}), ...(dataDescriptor?.ok ? { dataRequest: dataDescriptor.value } : {}), expectedBehavior: criterion.text, status, notTestableReason: text(notTestableReason) ? notTestableReason : undefined });
  }
  if (seen.size !== byId.size) return NextResponse.json({ error: "every confirmed Acceptance Contract criterion needs a verification plan" }, { status: 400 });
  try {
    const result = await recordEvidenceVerificationPlans({ workspaceId, recordId, prRevisionId, contractId, contractVersion, plannedBy, plans });
    return NextResponse.json({ plans: result.plans.map((plan) => ({ id: plan.id, criterionId: plan.criterionId, modality: plan.modality, environmentId: plan.environmentId, flow: plan.flow, uiSteps: plan.uiSteps, apiRequest: plan.apiRequest, dataRequest: plan.dataRequest, status: plan.status })), inserted: result.inserted }, { status: result.inserted ? 201 : 200 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to persist verification plan" }, { status: 409 });
  }
}
