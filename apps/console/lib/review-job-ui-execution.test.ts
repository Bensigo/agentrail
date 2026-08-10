import { describe, expect, it } from "vitest";
import { previewBootId } from "@agentrail/db-postgres";
import type { ExactReviewJobProof } from "./review-job-proof-attestation";
import {
  buildReviewJobUiAttempt,
  buildReviewJobUiResult,
  buildReviewJobUiScreenshotReservation,
  findReviewJobUiAttemptByExecutionId,
  parseReviewJobUiAttempt,
  parseReviewJobUiResult,
  reviewJobUiAttemptEventKey,
  reviewJobUiResultEventKey,
  reviewJobUiScreenshotReservationEventKey,
} from "./review-job-ui-execution";

const HEAD_SHA = "a".repeat(40);
const BOOT_ID = previewBootId({ workspaceId: "ws-1", repo: "acme/widgets", prNumber: 42, headSha: HEAD_SHA, cycleId: "job-1" });
function proof(): ExactReviewJobProof {
  const plan = {
    criterionId: "AC-UI",
    criterionTextSnapshot: "The saved filter remains visible.",
    modality: "ui",
    environmentKind: "isolated_preview",
    flow: "Save, reload, and check the filter.",
    status: "planned",
    notTestableReason: null,
    uiSteps: [
      { action: "open", path: "/filters" },
      { action: "expect_text", text: "Saved filter" },
      { action: "screenshot", label: "saved-filter" },
    ],
  };
  return {
    job: { id: "job-1", workspaceId: "ws-1", repo: "acme/widgets", prNumber: 42, headSha: HEAD_SHA },
    timeline: { record: { id: "record-1" }, events: [] },
    contract: { id: "contract-1", version: 3 },
    verificationPlan: { plans: [plan] },
  } as unknown as ExactReviewJobProof;
}

function boot() {
  return {
    id: BOOT_ID, workspaceId: "ws-1", repo: "acme/widgets", prNumber: 42,
    headSha: HEAD_SHA, status: "ready", url: "https://preview.example.test/filters",
  };
}

function timelineEvent(
  eventKey: string,
  payloadRef: Record<string, unknown>
): ExactReviewJobProof["timeline"]["events"][number] {
  return {
    id: `event-${eventKey}`,
    recordId: "record-1",
    eventKey,
    stage: "verification",
    actor: "jace:review-ui-executor",
    payloadRef,
    at: new Date(),
    createdAt: new Date(),
  };
}

describe("review-job UI execution custody helpers", () => {
  it("only reserves the current planned UI criterion with non-empty uiSteps on the exact ready preview tuple", () => {
    const current = proof();
    const plan = current.verificationPlan.plans[0];

    expect(buildReviewJobUiAttempt({ proof: current, plan, boot: boot() })).toMatchObject({
      kind: "review_job_ui_execution_attempt", jobId: "job-1", criterionId: "AC-UI",
      previewBootId: BOOT_ID, previewUrl: "https://preview.example.test/filters", uiSteps: plan.uiSteps,
    });

    for (const change of [
      { status: "planned", modality: "api", uiSteps: plan.uiSteps },
      { status: "not_testable", modality: "ui", uiSteps: plan.uiSteps },
      { status: "planned", modality: "ui", uiSteps: [] },
    ]) {
      const altered = { ...plan, ...change };
      expect(buildReviewJobUiAttempt({ proof: current, plan: altered as typeof plan, boot: boot() })).toBeNull();
    }
    for (const alteredBoot of [
      { ...boot(), status: "building" },
      { ...boot(), headSha: "b".repeat(40) },
      { ...boot(), id: previewBootId({ workspaceId: "ws-1", repo: "acme/widgets", prNumber: 42, headSha: HEAD_SHA, cycleId: "job-old-cycle" }) },
      { ...boot(), url: null },
    ]) {
      expect(buildReviewJobUiAttempt({ proof: current, plan, boot: alteredBoot })).toBeNull();
    }
  });

  it("rejects altered exact-plan attempt receipts and derives immutable result coordinates", () => {
    const current = proof();
    const plan = current.verificationPlan.plans[0];
    const attempt = buildReviewJobUiAttempt({ proof: current, plan, boot: boot() })!;
    const result = buildReviewJobUiResult({
      attempt, plan, assertionPassed: false, artifactKey: "review-evidence/exact.png",
      contentType: "image/png", contentSha256: "c".repeat(64), observedUrl: "https://preview.example.test/after",
    })!;

    expect(parseReviewJobUiAttempt({ payload: attempt, proof: current, plan })).toEqual(attempt);
    expect(parseReviewJobUiAttempt({ payload: { ...attempt, repo: "attacker/repo" }, proof: current, plan })).toBeNull();
    expect(result).toMatchObject({ kind: "review_job_ui_execution_result", state: "failed", expected: plan.criterionTextSnapshot, evidenceRef: `review-ui-execution:${attempt.executionId}` });
    current.timeline.events = [
      timelineEvent(reviewJobUiAttemptEventKey({ proof: current, plan }), attempt),
      timelineEvent(reviewJobUiScreenshotReservationEventKey({ proof: current, plan }), buildReviewJobUiScreenshotReservation(result)),
    ];
    expect(parseReviewJobUiResult({ payload: result, proof: current, plan })).toEqual(result);
    expect(parseReviewJobUiResult({ payload: { ...result, state: "proven" }, proof: current, plan })).toBeNull();
  });

  it("finds an execution only from the current event key and plan coordinates", () => {
    const current = proof();
    const plan = current.verificationPlan.plans[0];
    const attempt = buildReviewJobUiAttempt({ proof: current, plan, boot: boot() })!;
    current.timeline.events = [timelineEvent(reviewJobUiAttemptEventKey({ proof: current, plan }), attempt)];
    expect(findReviewJobUiAttemptByExecutionId({ proof: current, executionId: attempt.executionId })).toEqual({ plan, attempt });
    expect(findReviewJobUiAttemptByExecutionId({ proof: current, executionId: "ui-other" })).toBeNull();
    expect(reviewJobUiResultEventKey({ proof: current, plan })).not.toBe(reviewJobUiAttemptEventKey({ proof: current, plan }));
  });
});
