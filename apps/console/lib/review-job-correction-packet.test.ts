import { describe, expect, it } from "vitest";
import { previewBootId } from "@agentrail/db-postgres";
import type { CriterionResult, ExactReviewJobProof } from "./review-job-proof-attestation";
import {
  buildReviewJobApiAttempt,
  buildReviewJobApiCardReservation,
  buildReviewJobApiResult,
  reviewJobApiAttemptEventKey,
  reviewJobApiCardReservationEventKey,
  reviewJobApiResultEventKey,
} from "./review-job-api-execution";
import {
  buildReviewJobCorrectionPacket,
  buildReviewJobCorrectionPackets,
  findMatchingReviewJobCorrectionPacket,
  hasExactReviewJobCorrectionPackets,
  parseReviewJobCorrectionPacket,
  reviewJobCorrectionPacketEventKey,
} from "./review-job-correction-packet";
import {
  buildReviewJobDataAttempt,
  buildReviewJobDataCardReservation,
  buildReviewJobDataResult,
  reviewJobDataAttemptEventKey,
  reviewJobDataCardReservationEventKey,
  reviewJobDataResultEventKey,
} from "./review-job-data-execution";
import {
  buildReviewJobAttempt,
  buildReviewJobCardReservation,
  buildReviewJobResult,
  reviewJobAttemptEventKey,
  reviewJobCardReservationEventKey,
  reviewJobResultEventKey,
} from "./review-job-job-execution";
import {
  buildStoredDataVerificationRequest,
  buildStoredJobVerificationRequest,
  type StoredCriterionVerificationPlan,
} from "./review-job-verification-plan";
import {
  buildReviewJobUiAttempt,
  buildReviewJobUiResult,
  buildReviewJobUiScreenshotReservation,
  reviewJobUiAttemptEventKey,
  reviewJobUiResultEventKey,
  reviewJobUiScreenshotReservationEventKey,
} from "./review-job-ui-execution";

const HEAD = "a".repeat(40);
const hmacKey = { keyId: "review-data-test", key: Buffer.alloc(32, 7) };
const base = {
  job: { id: "job-1", workspaceId: "ws-1", repo: "acme/widgets", prNumber: 42, headSha: HEAD },
  timeline: { record: { id: "record-1" }, events: [] as unknown[] },
  contract: { id: "contract-1", version: 3 },
};
const boot = {
  id: previewBootId({
    workspaceId: base.job.workspaceId,
    repo: base.job.repo,
    prNumber: base.job.prNumber,
    headSha: base.job.headSha,
    cycleId: base.job.id,
  }),
  workspaceId: "ws-1", repo: "acme/widgets", prNumber: 42,
  headSha: HEAD, status: "ready", url: "https://preview.example.test/",
};

function event(eventKey: string, payloadRef: Record<string, unknown>) {
  return {
    id: eventKey, recordId: "record-1", eventKey, stage: "verification",
    actor: "jace:review-executor", payloadRef, at: new Date(), createdAt: new Date(),
  };
}

function proof(plan: StoredCriterionVerificationPlan, events: unknown[] = []): ExactReviewJobProof {
  return { ...base, timeline: { ...base.timeline, events }, verificationPlan: { plans: [plan] } } as unknown as ExactReviewJobProof;
}

function result(plan: StoredCriterionVerificationPlan, state: CriterionResult["state"], observed: string, evidenceRefs: string[]): CriterionResult {
  return { criterionId: plan.criterionId, state, expected: plan.criterionTextSnapshot, observed, evidenceRefs };
}

describe("review-job correction packet custody", () => {
  it("derives a failed UI packet from its exact receipt and redacts persisted fill values", () => {
    const plan: StoredCriterionVerificationPlan = {
      criterionId: "AC-UI", criterionTextSnapshot: "The saved filter remains visible.", modality: "ui",
      environmentKind: "isolated_preview", flow: "Save and reload the filter.", status: "planned",
      notTestableReason: null, apiRequest: null, dataRequest: null,
      uiSteps: [
        { action: "open", path: "/filters" },
        { action: "fill", selector: "#name", value: "private filter value" },
        { action: "expect_text", text: "Saved filter" },
        { action: "screenshot", label: "saved-filter" },
      ],
    };
    const current = proof(plan);
    const attempt = buildReviewJobUiAttempt({ proof: current, plan, boot })!;
    const receipt = buildReviewJobUiResult({
      attempt, plan, assertionPassed: false, artifactKey: "evidence/ui.png", contentType: "image/png",
      contentSha256: "b".repeat(64), observedUrl: "https://preview.example.test/filters",
    })!;
    current.timeline.events = [
      event(reviewJobUiAttemptEventKey({ proof: current, plan }), attempt),
      event(reviewJobUiResultEventKey({ proof: current, plan }), receipt),
      event(reviewJobUiScreenshotReservationEventKey({ proof: current, plan }), buildReviewJobUiScreenshotReservation(receipt)),
    ];
    const packet = buildReviewJobCorrectionPacket({
      proof: current, criterionResult: result(plan, "failed", receipt.observed, [receipt.evidenceRef]),
    })!;
    expect(packet.evidence).toEqual({
      evidenceRef: receipt.evidenceRef, artifactKey: receipt.artifactKey,
      executionId: receipt.executionId, previewBootId: receipt.previewBootId,
    });
    expect(packet.affectedContext.reproduction).toEqual({
      modality: "ui", steps: expect.arrayContaining([{ action: "fill", selector: "#name", value: "[REDACTED_FILL]" }]),
    });
    expect(JSON.stringify(packet)).not.toContain("private filter value");
    expect(JSON.stringify(packet)).not.toContain("preview.example.test");
  });

  it("derives safe API, data, and job packets without raw HMAC scalar values", () => {
    const apiPlan: StoredCriterionVerificationPlan = {
      criterionId: "AC-API", criterionTextSnapshot: "Health returns OK.", modality: "api",
      environmentKind: "isolated_preview", flow: "Read health.", status: "planned", notTestableReason: null,
      uiSteps: null, dataRequest: null, apiRequest: { method: "GET", path: "/health", expectedStatus: 200 },
    };
    const apiProof = proof(apiPlan);
    const apiAttempt = buildReviewJobApiAttempt({ proof: apiProof, plan: apiPlan, boot })!;
    const apiReceipt = buildReviewJobApiResult({ attempt: apiAttempt, plan: apiPlan, observedStatus: 503, artifactKey: "evidence/api.json", contentSha256: "c".repeat(64) })!;
    apiProof.timeline.events = [
      event(reviewJobApiAttemptEventKey({ proof: apiProof, plan: apiPlan }), apiAttempt),
      event(reviewJobApiResultEventKey({ proof: apiProof, plan: apiPlan }), apiReceipt),
      event(reviewJobApiCardReservationEventKey({ proof: apiProof, plan: apiPlan }), buildReviewJobApiCardReservation(apiReceipt)),
    ];
    expect(buildReviewJobCorrectionPacket({ proof: apiProof, criterionResult: result(apiPlan, "failed", apiReceipt.observed, [apiReceipt.evidenceRef]) })?.affectedContext.reproduction).toEqual({ modality: "api", request: apiPlan.apiRequest });

    const dataRequest = buildStoredDataVerificationRequest({
      value: { method: "GET", path: "/health", expectedStatus: 200, expectedJson: [{ pointer: "/name", equals: "raw-private-scalar" }] },
      hmacKey, binding: { workspaceId: "ws-1", recordId: "record-1", jobId: "job-1", headSha: HEAD, contractId: "contract-1", contractVersion: 3, criterionId: "AC-DATA" },
    })!;
    const dataPlan: StoredCriterionVerificationPlan = {
      criterionId: "AC-DATA", criterionTextSnapshot: "Health contains the service name.", modality: "data",
      environmentKind: "isolated_preview", flow: "Read health data.", status: "planned", notTestableReason: null,
      uiSteps: null, apiRequest: null, dataRequest,
    };
    const dataProof = proof(dataPlan);
    const dataAttempt = buildReviewJobDataAttempt({ proof: dataProof, plan: dataPlan, boot })!;
    const dataReceipt = buildReviewJobDataResult({ attempt: dataAttempt, plan: dataPlan, observedStatus: 500, observations: [], artifactKey: "evidence/data.json", contentSha256: "d".repeat(64) })!;
    dataProof.timeline.events = [
      event(reviewJobDataAttemptEventKey({ proof: dataProof, plan: dataPlan }), dataAttempt),
      event(reviewJobDataResultEventKey({ proof: dataProof, plan: dataPlan }), dataReceipt),
      event(reviewJobDataCardReservationEventKey({ proof: dataProof, plan: dataPlan }), buildReviewJobDataCardReservation(dataReceipt)),
    ];
    const dataPacket = buildReviewJobCorrectionPacket({ proof: dataProof, criterionResult: result(dataPlan, "failed", dataReceipt.observed, [dataReceipt.evidenceRef]) })!;
    expect(JSON.stringify(dataPacket)).not.toContain("raw-private-scalar");
    expect(dataPacket.affectedContext.reproduction).toMatchObject({ modality: "data", request: { expectedJson: [{ pointer: "/name", equalsType: "string", equalsHmacSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }] } });

    const jobRequest = buildStoredJobVerificationRequest({
      value: { trigger: { method: "POST", path: "/__agentrail/verification/jobs/reindex/trigger", expectedStatus: 202 }, readback: { method: "GET", path: "/__agentrail/verification/jobs/reindex/result", expectedStatus: 200, expectedJson: [{ pointer: "/state", equals: "private-complete" }] } },
      hmacKey, binding: { workspaceId: "ws-1", recordId: "record-1", jobId: "job-1", headSha: HEAD, contractId: "contract-1", contractVersion: 3, criterionId: "AC-JOB" },
    })!;
    const jobPlan: StoredCriterionVerificationPlan = {
      criterionId: "AC-JOB", criterionTextSnapshot: "The reindex job completes.", modality: "job",
      environmentKind: "isolated_preview", flow: "Trigger and read job.", status: "planned", notTestableReason: null,
      uiSteps: null, apiRequest: null, dataRequest: null, jobRequest,
    };
    const jobProof = proof(jobPlan);
    const jobAttempt = buildReviewJobAttempt({ proof: jobProof, plan: jobPlan, boot })!;
    const jobReceipt = buildReviewJobResult({ attempt: jobAttempt, plan: jobPlan, observedTriggerStatus: 500, observedReadbackStatus: null, observations: [], artifactKey: "evidence/job.json", contentSha256: "e".repeat(64) })!;
    jobProof.timeline.events = [
      event(reviewJobAttemptEventKey({ proof: jobProof, plan: jobPlan }), jobAttempt),
      event(reviewJobResultEventKey({ proof: jobProof, plan: jobPlan }), jobReceipt),
      event(reviewJobCardReservationEventKey({ proof: jobProof, plan: jobPlan }), buildReviewJobCardReservation(jobReceipt)),
    ];
    const jobPacket = buildReviewJobCorrectionPacket({ proof: jobProof, criterionResult: result(jobPlan, "not_proven", jobReceipt.observed, [jobReceipt.evidenceRef]) })!;
    expect(JSON.stringify(jobPacket)).not.toContain("private-complete");
    expect(jobPacket.affectedContext.reproduction).toMatchObject({ modality: "job", request: { readback: { expectedJson: [{ pointer: "/state", equalsType: "string" }] } } });
  });

  it("permits only the R7 preview fallback for an absent/pending not_proven receipt and filters ineligible states", () => {
    const plan: StoredCriterionVerificationPlan = {
      criterionId: "AC-R7", criterionTextSnapshot: "The screen is visible.", modality: "ui",
      environmentKind: "isolated_preview", flow: "Open and inspect.", status: "planned", notTestableReason: null,
      uiSteps: [{ action: "open", path: "/" }, { action: "expect_text", text: "Visible" }, { action: "screenshot", label: "visible" }],
      apiRequest: null, dataRequest: null,
    };
    const current = proof(plan);
    const fallback = result(plan, "not_proven", "The preview became ready without a receipt.", ["preview-boot:boot-r7"]);
    const packet = buildReviewJobCorrectionPacket({ proof: current, criterionResult: fallback })!;
    expect(packet.evidence).toEqual({ evidenceRef: "preview-boot:boot-r7", previewBootId: "boot-r7" });
    expect(packet.requiredCorrection).toMatch(/record its exact-head evidence custody/i);
    expect(buildReviewJobCorrectionPacket({ proof: current, criterionResult: { ...fallback, state: "proven" } })).toBeNull();
    expect(buildReviewJobCorrectionPacket({ proof: current, criterionResult: { ...fallback, state: "not_testable", evidenceRefs: [] } })).toBeNull();
    expect(buildReviewJobCorrectionPackets({ proof: current, criterionResults: [{ ...fallback, state: "proven" }] })).toEqual([]);
    expect(hasExactReviewJobCorrectionPackets({ proof: current, criterionResults: [{ ...fallback, state: "proven" }] })).toBe(true);
    current.timeline.events = [event("review:correction:job-1:foreign", {})];
    expect(hasExactReviewJobCorrectionPackets({ proof: current, criterionResults: [{ ...fallback, state: "proven" }] })).toBe(false);
    current.timeline.events = [event(reviewJobUiResultEventKey({ proof: current, plan }), {})];
    expect(buildReviewJobCorrectionPacket({ proof: current, criterionResult: fallback })).toBeNull();
  });

  it("fails closed for secret-shaped, control, and oversized duplicated packet text", () => {
    const plan: StoredCriterionVerificationPlan = {
      criterionId: "AC-SAFE", criterionTextSnapshot: "The screen is visible.", modality: "ui",
      environmentKind: "isolated_preview", flow: "Open and inspect.", status: "planned", notTestableReason: null,
      uiSteps: [{ action: "open", path: "/" }, { action: "expect_text", text: "Visible" }, { action: "screenshot", label: "visible" }], apiRequest: null, dataRequest: null,
    };
    const current = proof(plan);
    const baseline = result(plan, "not_proven", "No exact receipt exists.", ["preview-boot:boot-r7"]);
    expect(buildReviewJobCorrectionPacket({ proof: current, criterionResult: { ...baseline, observed: "password=supersecret-value" } })).toBeNull();
    expect(buildReviewJobCorrectionPacket({ proof: current, criterionResult: { ...baseline, observed: "bad\u0000text" } })).toBeNull();
    const secretPlan = { ...plan, criterionTextSnapshot: "api_key=private-key-material" };
    expect(buildReviewJobCorrectionPacket({ proof: proof(secretPlan), criterionResult: { ...baseline, expected: secretPlan.criterionTextSnapshot } })).toBeNull();
    expect(buildReviewJobCorrectionPacket({ proof: proof({ ...plan, flow: "token=private-token-material" }), criterionResult: baseline })).toBeNull();
    const oversizedPlan: StoredCriterionVerificationPlan = {
      ...plan,
      uiSteps: [
        { action: "open", path: `/${"x".repeat(1_999)}` },
        ...Array.from({ length: 9 }, () => ({ action: "click" as const, selector: `#${"x".repeat(1_999)}` })),
        { action: "expect_text", text: "x".repeat(2_000) }, { action: "screenshot", label: "x".repeat(2_000) },
      ],
    };
    expect(buildReviewJobCorrectionPacket({ proof: proof(oversizedPlan), criterionResult: result(oversizedPlan, "not_proven", baseline.observed, baseline.evidenceRefs) })).toBeNull();
  });

  it("requires an exact immutable full event set and rejects conflicts, duplicates, and extras", () => {
    const plan: StoredCriterionVerificationPlan = {
      criterionId: "AC-R7", criterionTextSnapshot: "The screen is visible.", modality: "ui", environmentKind: "isolated_preview",
      flow: "Open and inspect.", status: "planned", notTestableReason: null,
      uiSteps: [{ action: "open", path: "/" }, { action: "expect_text", text: "Visible" }, { action: "screenshot", label: "visible" }], apiRequest: null, dataRequest: null,
    };
    const current = proof(plan);
    const attested = result(plan, "not_proven", "The preview became ready without a receipt.", ["preview-boot:boot-r7"]);
    const packet = buildReviewJobCorrectionPacket({ proof: current, criterionResult: attested })!;
    const eventKey = reviewJobCorrectionPacketEventKey({ jobId: "job-1", criterionId: "AC-R7" })!;
    expect(hasExactReviewJobCorrectionPackets({ proof: current, criterionResults: [attested] })).toBe(false);
    current.timeline.events = [event(eventKey, packet)];
    expect(parseReviewJobCorrectionPacket({ payload: packet, proof: current, criterionResult: attested })).toEqual(packet);
    expect(findMatchingReviewJobCorrectionPacket({ proof: current, criterionResult: attested })).toEqual(packet);
    expect(hasExactReviewJobCorrectionPackets({ proof: current, criterionResults: [attested] })).toBe(true);
    current.timeline.events = [event(eventKey, { ...packet, observed: "tampered" })];
    expect(findMatchingReviewJobCorrectionPacket({ proof: current, criterionResult: attested })).toBeNull();
    expect(hasExactReviewJobCorrectionPackets({ proof: current, criterionResults: [attested] })).toBe(false);
    current.timeline.events = [event(eventKey, packet), event(eventKey, packet)];
    expect(hasExactReviewJobCorrectionPackets({ proof: current, criterionResults: [attested] })).toBe(false);
    current.timeline.events = [event(eventKey, packet), event("review:correction:job-1:foreign", packet)];
    expect(hasExactReviewJobCorrectionPackets({ proof: current, criterionResults: [attested] })).toBe(false);
  });
});
