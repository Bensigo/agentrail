import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({ readAcceptanceContracts: vi.fn(), recordEvidenceReview: vi.fn() }));
import { readAcceptanceContracts, recordEvidenceReview } from "@agentrail/db-postgres";
import { POST } from "./route";

const secret = "jace-secret";
const head = "a".repeat(40);
const contract = {
  id: "contract-1", version: 1, status: "confirmed",
  contract: { originalUserWording: "Show saved", goal: "Visible saved state", acceptanceCriteria: [{ id: "saved", text: "A saved state is visible", required: true, userVisible: true }] },
};
const body = {
  workspaceId: "ws-1", recordId: "record-1", prRevisionId: "revision-1", headSha: head,
  contractId: "contract-1", contractVersion: 1, verifierName: "independent", verifierVersion: "1", promptVersion: "1", environmentRung: "preview",
  diffIdentity: { baseSha: "b".repeat(40), headSha: head, diffHash: "hash" }, independentVerifier: { identity: "other-model" }, reviewabilityResult: {}, staticFindings: [], testResults: [],
  criteria: [{ criterionId: "saved", status: "failed", observedBehavior: "No message", expectedBehavior: "Saved message", evidenceRefs: [{ path: "app/save.tsx", startLine: 1, endLine: 2, detail: "no render", headSha: head }], runtimeEvidence: [{ criterionId: "saved", headSha: head, environmentId: "preview-1", flow: "save draft", expected: "Saved", observed: "No message", artifactRef: "artifact.png" }], reason: "observed" }],
  findings: [{ basis: "acceptance_contract", criterionId: "saved", evidenceRefs: [{ path: "app/save.tsx", startLine: 1, endLine: 2, detail: "no render", headSha: head }], ruleOrBoundary: "Acceptance criterion saved", concreteImpact: "No confirmation", requiredCorrection: "Render confirmation", reverification: "Save in preview and capture state" }],
};
function request(payload: unknown = body, authorization = true) {
  return new NextRequest("http://localhost/api/v1/runner/evidence-reviews/complete", { method: "POST", headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(payload) });
}
beforeEach(() => {
  vi.clearAllMocks(); process.env.JACE_CONSOLE_TOKEN = secret;
  vi.mocked(readAcceptanceContracts).mockResolvedValue([contract] as never);
  vi.mocked(recordEvidenceReview).mockResolvedValue({ id: "review-1", inserted: true } as never);
});

describe("independent evidence review completion", () => {
  it("persists exact-head criterion evidence and generates a correction packet", async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(recordEvidenceReview).toHaveBeenCalledWith(expect.objectContaining({ headSha: head, overallStatus: "failed", corrections: [expect.objectContaining({ criterionId: "saved" })] }));
    expect((await response.json()).correctionPackets[0]).toMatchObject({ headSha: head, criterionId: "saved" });
  });
  it("rejects a generic visible-criterion pass without an exercise artifact", async () => {
    const response = await POST(request({ ...body, criteria: [{ ...body.criteria[0], status: "proven", runtimeEvidence: [] }], findings: [] }));
    expect(response.status).toBe(400);
    expect(recordEvidenceReview).not.toHaveBeenCalled();
  });
  it("fails closed without the independent worker secret", async () => {
    const response = await POST(request(body, false));
    expect(response.status).toBe(401);
    expect(recordEvidenceReview).not.toHaveBeenCalled();
  });
});
