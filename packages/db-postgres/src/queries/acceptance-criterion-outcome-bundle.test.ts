import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_CRITERION_OUTCOME_MAX_EVENT_BYTES,
  acceptanceCriterionArtifactId,
  acceptanceCriterionOutcomeBundleId,
  acceptanceCriterionOutcomeBundleSha256,
  acceptanceCriterionOutcomeSetSha256,
  readCurrentAcceptanceCriterionOutcomeBundle,
  recordPostedAcceptanceCriterionOutcomeBundle,
  resolveAcceptanceCriterionArtifact,
  type AcceptanceCriterionOutcomeBundlePayload,
} from "./change_records.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const RECORD_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";

describe("Acceptance criterion outcome custody boundary", () => {
  it("rejects caller-supplied head, route, body, or object-key authority", async () => {
    await expect(readCurrentAcceptanceCriterionOutcomeBundle({
      workspaceId: WORKSPACE_ID,
      recordId: RECORD_ID,
      headSha: "a".repeat(40),
    } as never)).rejects.toThrow(/requires only workspace and Record/u);

    await expect(recordPostedAcceptanceCriterionOutcomeBundle({
      workspaceId: WORKSPACE_ID,
      recordId: RECORD_ID,
      reviewJobId: JOB_ID,
      postedReviewUrl: "https://github.com/acme/widgets/pull/1#pullrequestreview-1",
      inlineCommentsPosted: 0,
      commentsFolded: false,
      criterionResults: [],
    } as never)).rejects.toThrow(/one exact server-issued receipt/u);

    await expect(resolveAcceptanceCriterionArtifact({
      workspaceId: WORKSPACE_ID,
      recordId: RECORD_ID,
      artifactId: randomUUID(),
      artifactKey: "review-evidence/private/key.png",
    } as never)).rejects.toThrow(/only workspace, Record, and artifact id/u);
  });

  it("derives stable bundle, outcome-set, and opaque artifact identities", () => {
    const outcomes = [{
      criterionId: "AC-1",
      criterionText: "A saved filter persists",
      state: "proven" as const,
      expected: "A saved filter persists",
      observed: "The exact execution proved the criterion.",
      evidence: {
        kind: "execution_receipt" as const,
        modality: "ui" as const,
        executionId: "ui-123",
        receiptEventId: randomUUID(),
        evidenceRef: "review-ui-execution:ui-123",
        artifact: null,
      },
    }];
    const id = acceptanceCriterionOutcomeBundleId({ recordId: RECORD_ID, headCycleId: JOB_ID });
    const payload: AcceptanceCriterionOutcomeBundlePayload = {
      kind: "acceptance_criterion_outcome_bundle",
      version: 1,
      id,
      binding: {
        workspaceId: WORKSPACE_ID,
        recordId: RECORD_ID,
        repo: "acme/widgets",
        prNumber: 1,
        headSha: "a".repeat(40),
        headCycleId: JOB_ID,
        reviewJobId: JOB_ID,
        acceptanceContract: { id: randomUUID(), version: 1, sha256: "b".repeat(64) },
        verificationPlanEventId: randomUUID(),
        postedAttemptEventId: randomUUID(),
        postedAttestationEventId: randomUUID(),
        outcomeDigest: "c".repeat(64),
        postPayloadDigest: "d".repeat(64),
        reviewVerdict: "proven",
      },
      outcomes,
      outcomeSetSha256: acceptanceCriterionOutcomeSetSha256(outcomes),
    };
    expect(acceptanceCriterionOutcomeBundleId({ recordId: RECORD_ID, headCycleId: JOB_ID })).toBe(id);
    expect(acceptanceCriterionOutcomeBundleSha256(payload)).toMatch(/^[a-f0-9]{64}$/u);
    expect(acceptanceCriterionArtifactId({
      bundleId: id,
      criterionId: "AC-1",
      receiptEventId: outcomes[0]!.evidence.receiptEventId,
      contentSha256: "e".repeat(64),
    })).toBe(acceptanceCriterionArtifactId({
      bundleId: id,
      criterionId: "AC-1",
      receiptEventId: outcomes[0]!.evidence.receiptEventId,
      contentSha256: "e".repeat(64),
    }));
  });

  it("keeps the aggregate event-byte cap above the maximum accepted 100-criterion shape", () => {
    const planEventCap = 256_000;
    const criteria = 100;
    const commonAttemptOrResultEnvelope = 10_000;
    const correctionPacketCap = 24 * 1024;
    const bundleAndFixedEventAllowance = 2 * 1024 * 1024;
    const conservativeAcceptedMaximum = planEventCap
      + 3 * (planEventCap + criteria * commonAttemptOrResultEnvelope)
      + criteria * correctionPacketCap
      + bundleAndFixedEventAllowance;
    expect(conservativeAcceptedMaximum).toBeLessThan(ACCEPTANCE_CRITERION_OUTCOME_MAX_EVENT_BYTES);
  });
});
