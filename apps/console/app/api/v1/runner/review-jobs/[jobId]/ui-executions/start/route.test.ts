import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  appendChangeRecordEvent: vi.fn(), getJaceSessionByEveSessionId: vi.fn(), getPreviewBoot: vi.fn(),
}));
vi.mock("../../../../../../../../lib/review-job-proof-attestation", () => ({ resolveCurrentReviewJobPlan: vi.fn() }));

import { appendChangeRecordEvent, getJaceSessionByEveSessionId, getPreviewBoot } from "@agentrail/db-postgres";
import { type ExactReviewJobProof, resolveCurrentReviewJobPlan } from "../../../../../../../../lib/review-job-proof-attestation";
import { buildReviewJobUiAttempt, reviewJobUiAttemptEventKey } from "../../../../../../../../lib/review-job-ui-execution";
import { POST } from "./route";

const SECRET = "jace-shared-secret-abc123";
const HEAD_SHA = "a".repeat(40);
const ORIGINAL_TOKEN = process.env.JACE_CONSOLE_TOKEN;

function currentProof(
  events: Array<{ eventKey: string; payloadRef: Record<string, unknown> }> = []
): ExactReviewJobProof {
  return {
    job: { id: "job-1", workspaceId: "ws-1", repo: "acme/widgets", prNumber: 42, headSha: HEAD_SHA, state: "running" },
    timeline: { record: { id: "record-1" }, events },
    contract: { id: "contract-1", version: 3 },
    verificationPlan: { plans: [{
      criterionId: "AC-UI", criterionTextSnapshot: "The filter is visible.", modality: "ui",
      environmentKind: "isolated_preview", flow: "Open and inspect.", status: "planned", notTestableReason: null,
      uiSteps: [{ action: "open", path: "/filters" }, { action: "expect_text", text: "Saved" }, { action: "screenshot", label: "filter" }],
    }] },
  } as unknown as ExactReviewJobProof;
}
function session(overrides = {}) { return { eveSessionId: "eve-1", workspaceId: "ws-1", channel: "review-job", conversationKey: "review-job:job-1", status: "active", ...overrides }; }
function preview(overrides = {}) { return { id: "boot-1", workspaceId: "ws-1", repo: "acme/widgets", prNumber: 42, headSha: HEAD_SHA, status: "ready", url: "https://preview.example.test/filters", expiresAt: new Date(Date.now() + 60_000), ...overrides }; }
function request(body: unknown, auth = true) { return new NextRequest("http://localhost/api/v1/runner/review-jobs/job-1/ui-executions/start", { method: "POST", headers: { "content-type": "application/json", ...(auth ? { Authorization: `Bearer ${SECRET}` } : {}) }, body: JSON.stringify(body) }); }
function params(jobId = "job-1") { return { params: Promise.resolve({ jobId }) }; }
const body = { eveSessionId: "eve-1", criterionId: "AC-UI", previewBootId: "boot-1" };

beforeEach(() => {
  vi.clearAllMocks(); process.env.JACE_CONSOLE_TOKEN = SECRET;
  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(session() as never);
  vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(currentProof() as never);
  vi.mocked(getPreviewBoot).mockResolvedValue(preview() as never);
  vi.mocked(appendChangeRecordEvent).mockImplementation(async (input) => ({ event: { payloadRef: input.payloadRef }, inserted: true }) as never);
});
afterEach(() => { if (ORIGINAL_TOKEN === undefined) delete process.env.JACE_CONSOLE_TOKEN; else process.env.JACE_CONSOLE_TOKEN = ORIGINAL_TOKEN; });

describe("POST /api/v1/runner/review-jobs/[jobId]/ui-executions/start", () => {
  it("rejects a closed or caller-expanded body before any arbitrary review tuple is used", async () => {
    for (const supplied of [
      { ...body, repo: "attacker/other" }, { ...body, prNumber: 99 }, { ...body, headSha: "b".repeat(40) },
    ]) expect((await POST(request(supplied), params())).status).toBe(400);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    expect(resolveCurrentReviewJobPlan).not.toHaveBeenCalled();
  });

  it("binds an active session to the path job before resolving the job plan", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(session({ status: "closed" }) as never);
    expect((await POST(request(body), params())).status).toBe(409);
    expect(resolveCurrentReviewJobPlan).not.toHaveBeenCalled();
  });

  it("requires the current running plan's planned UI flow and exact ready future preview", async () => {
    for (const proof of [null, { ...currentProof(), job: { ...currentProof().job, workspaceId: "ws-other" } }, { ...currentProof(), verificationPlan: { plans: [{ ...currentProof().verificationPlan.plans[0], modality: "api" }] } }]) {
      vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValueOnce(proof as never);
      expect((await POST(request(body), params())).status).toBe(409);
    }
    for (const altered of [{ ...preview(), expiresAt: new Date(Date.now() - 1) }, { ...preview(), headSha: "b".repeat(40) }, { ...preview(), status: "building" }]) {
      vi.mocked(getPreviewBoot).mockResolvedValueOnce(altered as never);
      expect((await POST(request(body), params())).status).toBe(409);
    }
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
  });

  it("appends the server-built attempt before returning the exact uiSteps", async () => {
    const response = await POST(request(body), params());
    const payload = await response.json();
    const proof = currentProof(); const plan = proof.verificationPlan.plans[0]; const attempt = buildReviewJobUiAttempt({ proof, plan, boot: preview() })!;
    expect(response.status).toBe(201);
    expect(payload).toEqual({ ok: true, executionId: attempt.executionId, jobId: "job-1", criterionId: "AC-UI", expected: "The filter is visible.", previewBootId: "boot-1", previewUrl: "https://preview.example.test/filters", uiSteps: plan.uiSteps });
    expect(appendChangeRecordEvent).toHaveBeenCalledWith({ recordId: "record-1", eventKey: reviewJobUiAttemptEventKey({ proof, plan }), stage: "verification", actor: "jace:review-ui-executor", payloadRef: attempt });
  });

  it("holds existing or racing reservations instead of replaying browser actions", async () => {
    const proof = currentProof(); const plan = proof.verificationPlan.plans[0]; const attempt = buildReviewJobUiAttempt({ proof, plan, boot: preview() })!;
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValueOnce(currentProof([{ eventKey: reviewJobUiAttemptEventKey({ proof, plan }), payloadRef: attempt }]) as never);
    expect((await POST(request(body), params())).status).toBe(409);
    vi.mocked(appendChangeRecordEvent).mockResolvedValueOnce({ event: { payloadRef: attempt }, inserted: false } as never);
    expect((await POST(request(body), params())).status).toBe(409);
  });
});
