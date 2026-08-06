import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({ readClaimedAcceptanceEvidenceReviewRequest: vi.fn(), recordEvidenceReview: vi.fn(), findAcceptanceBuilderHandoffForPrRevision: vi.fn(), queueEvidenceReviewCorrectionDelivery: vi.fn() }));
import { findAcceptanceBuilderHandoffForPrRevision, queueEvidenceReviewCorrectionDelivery, readClaimedAcceptanceEvidenceReviewRequest, recordEvidenceReview } from "@agentrail/db-postgres";
import { POST } from "./route";

const secret = "jace-secret";
const head = "a".repeat(40);
const contract = {
  id: "contract-1", version: 1, status: "confirmed",
  contract: { originalUserWording: "Show saved", goal: "Visible saved state", acceptanceCriteria: [{ id: "saved", text: "A saved state is visible", required: true, userVisible: true }] },
};
const body = {
  workspaceId: "ws-1", recordId: "record-1", prRevisionId: "revision-1", reviewRequestId: "request-1", workerId: "worker-1", headSha: head,
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
  vi.mocked(readClaimedAcceptanceEvidenceReviewRequest).mockResolvedValue({ request: { workspaceId: "ws-1", recordId: "record-1", prRevisionId: "revision-1", headSha: head }, contract } as never);
  vi.mocked(recordEvidenceReview).mockResolvedValue({ id: "review-1", inserted: true, corrections: [{ id: "correction-1" }] } as never);
  vi.mocked(findAcceptanceBuilderHandoffForPrRevision).mockResolvedValue({ id: "handoff-1", builder: "codex", taskContextKey: "task-1" } as never);
  vi.mocked(queueEvidenceReviewCorrectionDelivery).mockResolvedValue({ id: "delivery-1" } as never);
});

describe("independent evidence review completion", () => {
  it("persists exact-head criterion evidence and generates a correction packet", async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(recordEvidenceReview).toHaveBeenCalledWith(expect.objectContaining({ headSha: head, reviewRequestId: "request-1", workerId: "worker-1", overallStatus: "failed", corrections: [expect.objectContaining({ criterionId: "saved" })] }));
    expect((await response.json()).correctionPackets[0]).toMatchObject({ headSha: head, criterionId: "saved" });
    expect(queueEvidenceReviewCorrectionDelivery).toHaveBeenCalledWith(expect.objectContaining({ correctionId: "correction-1", channel: "mcp_task_context", target: { builder: "codex", taskContextKey: "task-1" } }));
  });
  it("queues a durable Jace task inbox packet when no builder task context is recorded", async () => {
    vi.mocked(findAcceptanceBuilderHandoffForPrRevision).mockResolvedValue(null as never);

    const response = await POST(request());

    expect(response.status).toBe(201);
    expect(queueEvidenceReviewCorrectionDelivery).toHaveBeenCalledWith(expect.objectContaining({
      correctionId: "correction-1",
      deliveryKey: "jace-inbox:record-1:correction-1",
      channel: "jace_task_inbox",
      target: { recordId: "record-1" },
    }));
    await expect(response.json()).resolves.toMatchObject({
      deliveryTargetResolved: false,
      fallbackInboxQueued: true,
      correctionDeliveries: [{ channel: "jace_task_inbox", outcome: "queued" }],
    });
  });
  it("rejects a generic visible-criterion pass without an exercise artifact", async () => {
    const response = await POST(request({ ...body, criteria: [{ ...body.criteria[0], status: "proven", runtimeEvidence: [] }], findings: [] }));
    expect(response.status).toBe(400);
    expect(recordEvidenceReview).not.toHaveBeenCalled();
  });
  it("rejects a forged model runtime artifact when the claimed execution was not proven", async () => {
    vi.mocked(readClaimedAcceptanceEvidenceReviewRequest).mockResolvedValue({
      request: { workspaceId: "ws-1", recordId: "record-1", prRevisionId: "revision-1", headSha: head },
      contract,
      runtimeEvidence: [{ criterionId: "saved", executionStatus: "not_proven", environmentId: "preview-1", flow: "save", expectedBehavior: "Saved message", observedBehavior: "Request failed", artifacts: [{ artifactKey: "review-evidence/real.json" }] }],
    } as never);
    const response = await POST(request({
      ...body,
      criteria: [{ ...body.criteria[0], status: "proven", observedBehavior: "Saved message", runtimeEvidence: [{ criterionId: "saved", headSha: head, environmentId: "forged", flow: "forged", expected: "Saved", observed: "Saved", artifactRef: "forged.png" }] }],
      findings: [],
    }));
    expect(response.status).toBe(400);
    expect(recordEvidenceReview).not.toHaveBeenCalled();
  });
  it("uses only matching server-resolved proven execution evidence", async () => {
    vi.mocked(readClaimedAcceptanceEvidenceReviewRequest).mockResolvedValue({
      request: { workspaceId: "ws-1", recordId: "record-1", prRevisionId: "revision-1", headSha: head },
      contract,
      runtimeEvidence: [{ criterionId: "saved", executionStatus: "proven", environmentId: "preview-1", flow: "save then observe", expectedBehavior: "Saved message", observedBehavior: "Saved message appears", artifacts: [{ artifactKey: "review-evidence/real.png" }] }],
    } as never);
    const response = await POST(request({
      ...body,
      criteria: [{ ...body.criteria[0], status: "proven", observedBehavior: "Saved message appears", runtimeEvidence: [{ criterionId: "saved", headSha: head, environmentId: "forged", flow: "forged", expected: "Saved", observed: "Saved", artifactRef: "forged.png" }] }],
      findings: [],
    }));
    expect(response.status).toBe(201);
    expect(recordEvidenceReview).toHaveBeenCalledWith(expect.objectContaining({
      criteria: [expect.objectContaining({ runtimeEvidence: [{ criterionId: "saved", headSha: head, environmentId: "preview-1", flow: "save then observe", expected: "Saved message", observed: "Saved message appears", artifactRef: "review-evidence/real.png" }] })],
    }));
  });
  it("refuses completion unless the worker still owns the exact claimed request", async () => {
    vi.mocked(readClaimedAcceptanceEvidenceReviewRequest).mockResolvedValue(null as never);
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(recordEvidenceReview).not.toHaveBeenCalled();
  });
  it("fails closed without the independent worker secret", async () => {
    const response = await POST(request(body, false));
    expect(response.status).toBe(401);
    expect(recordEvidenceReview).not.toHaveBeenCalled();
  });
});
