import { describe, expect, it } from "vitest";
import { buildCorrectionPacket, validateEvidenceReview } from "./evidence-review-validation";

const head = "a".repeat(40);
const contract = {
  originalUserWording: "Show a saved state", goal: "Visible confirmation",
  acceptanceCriteria: [{ id: "saved", text: "A saved state is visible", required: true, userVisible: true }],
  nonGoals: [], risks: [], environmentExpectations: [], stopConditions: [], affectedCodebaseUnits: [], openQuestions: [],
};
const evidence = [{ path: "app/save.tsx", startLine: 12, endLine: 14, detail: "save state branch", headSha: head }];
const result = { criterionId: "saved", status: "proven" as const, observedBehavior: "Saved", expectedBehavior: "Saved", evidenceRefs: evidence, reason: "verified" };

describe("evidence review validation", () => {
  it("does not treat a generic smoke test as proof of a user-visible criterion", () => {
    expect(validateEvidenceReview({ contract, headSha: head, criteria: [result], findings: [] })).toMatchObject({ ok: false });
  });

  it("requires a criterion-specific flow, artifact, environment, and exact head", () => {
    const review = validateEvidenceReview({ contract, headSha: head, criteria: [{ ...result, runtimeEvidence: [{ criterionId: "saved", headSha: head, environmentId: "preview-1", flow: "create then save", expected: "Saved", observed: "Saved", artifactRef: "review-evidence/x.png" }] }], findings: [] });
    expect(review).toEqual({ ok: true, overallStatus: "proven" });
  });

  it("rejects style-only findings and accepts only evidence-bound corrections", () => {
    const invalid = validateEvidenceReview({ contract, headSha: head, criteria: [{ ...result, status: "not_proven" }], findings: [{ basis: "repository_convention" as const, evidenceRefs: evidence, ruleOrBoundary: "style", concreteImpact: "looks inconsistent", requiredCorrection: "rename it", reverification: "reload" }] });
    expect(invalid).toMatchObject({ ok: false });
    const finding = { basis: "acceptance_contract" as const, criterionId: "saved", evidenceRefs: evidence, ruleOrBoundary: "Acceptance criterion saved", concreteImpact: "Users cannot tell the save succeeded", requiredCorrection: "Render the confirmed saved state after a successful response", reverification: "Save a draft in this PR-head preview and capture the saved state" };
    const valid = validateEvidenceReview({ contract, headSha: head, criteria: [{ ...result, status: "failed" }], findings: [finding] });
    expect(valid).toMatchObject({ ok: true, overallStatus: "failed" });
    expect(buildCorrectionPacket({ headSha: head, criterion: { ...result, status: "failed", runtimeEvidence: [{ criterionId: "saved", headSha: head, environmentId: "preview-1", flow: "save", expected: "Saved", observed: "Missing", artifactRef: "artifact" }] }, finding })).toMatchObject({ criterionId: "saved", headSha: head, environmentIds: ["preview-1"], reverification: expect.stringContaining("Save a draft") });
  });

  it("makes missing required criteria and wrong-head evidence non-passable", () => {
    expect(validateEvidenceReview({ contract, headSha: head, criteria: [], findings: [] })).toMatchObject({ ok: false });
    expect(validateEvidenceReview({ contract, headSha: head, criteria: [{ ...result, status: "not_proven", evidenceRefs: [{ ...evidence[0], headSha: "b".repeat(40) }] }], findings: [] })).toMatchObject({ ok: false });
  });
});
