import { describe, expect, it } from "vitest";
import type { ExactReviewJobProof } from "./review-job-proof-attestation";
import {
  buildReviewJobVerificationPlan,
  buildStoredJobVerificationRequest,
  dataScalarKind,
  parseSubmittedJobVerificationRequest,
  reviewJobScalarHmac,
} from "./review-job-verification-plan";
import {
  buildReviewJobAttempt,
  buildReviewJobCard,
  buildReviewJobResult,
} from "./review-job-job-execution";

const headSha = "a".repeat(40);
const key = { keyId: "review-data-2026-08", key: Buffer.alloc(32, 7) };
const binding = {
  workspaceId: "ws-1",
  recordId: "record-1",
  jobId: "job-1",
  headSha,
  contractId: "contract-1",
  contractVersion: 3,
  criterionId: "AC-JOB",
};
const raw = {
  trigger: {
    method: "POST" as const,
    path: "/__agentrail/verification/jobs/reindex-1/trigger",
    expectedStatus: 202,
  },
  readback: {
    method: "GET" as const,
    path: "/__agentrail/verification/jobs/reindex-1/result",
    expectedStatus: 200,
    expectedJson: [{ pointer: "/state", equals: "complete" }],
  },
};
const request = () =>
  buildStoredJobVerificationRequest({ value: raw, binding, hmacKey: key })!;
function proof(): ExactReviewJobProof {
  return {
    job: {
      id: "job-1",
      workspaceId: "ws-1",
      repo: "acme/widgets",
      prNumber: 42,
      headSha,
    },
    timeline: { record: { id: "record-1" }, events: [] },
    contract: { id: "contract-1", version: 3 },
    verificationPlan: {
      plans: [
        {
          criterionId: "AC-JOB",
          criterionTextSnapshot: "The maintenance job completes.",
          modality: "job",
          environmentKind: "isolated_preview",
          flow: "Trigger and read result.",
          uiSteps: null,
          apiRequest: null,
          dataRequest: null,
          jobRequest: request(),
          status: "planned",
          notTestableReason: null,
        },
      ],
    },
  } as unknown as ExactReviewJobProof;
}
const boot = {
  id: "boot-1",
  workspaceId: "ws-1",
  repo: "acme/widgets",
  prNumber: 42,
  headSha,
  status: "ready",
  url: "https://preview.example.test/",
};
describe("review-job execution custody", () => {
  it("accepts only the same fixed job namespace and strict raw shape", () => {
    expect(parseSubmittedJobVerificationRequest(raw)).toEqual(raw);
    for (const value of [
      {
        ...raw,
        trigger: {
          ...raw.trigger,
          path: "/__agentrail/verification/jobs/reindex-1/result",
        },
      },
      {
        ...raw,
        readback: {
          ...raw.readback,
          path: "/__agentrail/verification/jobs/other/result",
        },
      },
      { ...raw, trigger: { ...raw.trigger, expectedStatus: 199 } },
      { ...raw, readback: { ...raw.readback, headers: {} } },
      {
        ...raw,
        trigger: {
          ...raw.trigger,
          path: "/__agentrail/verification/jobs/reindex-1%2fother/trigger",
        },
      },
    ])
      expect(parseSubmittedJobVerificationRequest(value)).toBeNull();
  });
  it("keeps scalar expectations HMAC-only and makes mismatch conservatively not_proven", () => {
    const stored = request();
    expect(JSON.stringify(stored)).not.toContain("complete");
    const current = proof(),
      plan = current.verificationPlan.plans[0]!;
    const attempt = buildReviewJobAttempt({ proof: current, plan, boot })!;
    const result = buildReviewJobResult({
      attempt,
      plan,
      observedTriggerStatus: 202,
      observedReadbackStatus: 200,
      observations: [
        {
          pointer: "/state",
          found: true,
          observedType: dataScalarKind("running"),
          observedHmacSha256: reviewJobScalarHmac({
            key: key.key,
            context: stored.readback.digestContext,
            pointer: "/state",
            value: "running",
          }),
        },
      ],
      artifactKey: "card.json",
      contentSha256: "b".repeat(64),
    })!;
    expect(result.state).toBe("not_proven");
    expect(JSON.stringify(result)).not.toContain("running");
    expect(JSON.stringify(buildReviewJobCard(result))).not.toContain(
      "complete",
    );
  });
  it("plans a non-user-visible job only and binds both endpoints into its HMAC context", () => {
    const built = buildReviewJobVerificationPlan({
      job: {
        id: "job-1",
        workspaceId: "ws-1",
        repo: "acme/widgets",
        prNumber: 42,
        headSha,
      },
      recordId: "record-1",
      contract: {
        id: "contract-1",
        version: 3,
        criteria: [
          {
            id: "AC-JOB",
            text: "The maintenance job completes.",
            userVisible: false,
          },
        ],
      },
      plannedBy: "worker",
      dataHmacKey: key,
      plans: [
        {
          criterionId: "AC-JOB",
          modality: "job",
          status: "planned",
          flow: "Trigger then read job result.",
          jobRequest: raw,
        },
      ],
    });
    expect(built.ok).toBe(true);
    if (built.ok)
      expect(JSON.stringify(built.value.plans[0]?.jobRequest)).not.toContain(
        "complete",
      );
    const userVisible = buildReviewJobVerificationPlan({
      job: {
        id: "job-1",
        workspaceId: "ws-1",
        repo: "acme/widgets",
        prNumber: 42,
        headSha,
      },
      recordId: "record-1",
      contract: {
        id: "contract-1",
        version: 3,
        criteria: [{ id: "AC-JOB", text: "Visible", userVisible: true }],
      },
      plannedBy: "worker",
      dataHmacKey: key,
      plans: [
        {
          criterionId: "AC-JOB",
          modality: "job",
          status: "planned",
          flow: "Trigger then read job result.",
          jobRequest: raw,
        },
      ],
    });
    expect(userVisible.ok).toBe(false);
  });
  it("permits no readback only after a trigger mismatch and requires no observations", () => {
    const current = proof(),
      plan = current.verificationPlan.plans[0]!,
      attempt = buildReviewJobAttempt({ proof: current, plan, boot })!;
    expect(
      buildReviewJobResult({
        attempt,
        plan,
        observedTriggerStatus: 500,
        observedReadbackStatus: null,
        observations: [],
        artifactKey: "card.json",
        contentSha256: "c".repeat(64),
      })?.state,
    ).toBe("not_proven");
    expect(
      buildReviewJobResult({
        attempt,
        plan,
        observedTriggerStatus: 202,
        observedReadbackStatus: null,
        observations: [],
        artifactKey: "card.json",
        contentSha256: "c".repeat(64),
      }),
    ).toBeNull();
  });
});
