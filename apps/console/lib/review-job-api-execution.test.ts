import { describe, expect, it } from "vitest";
import type { ExactReviewJobProof } from "./review-job-proof-attestation";
import {
  buildReviewJobApiAttempt,
  buildReviewJobApiCardReservation,
  buildReviewJobApiResult,
  findReviewJobApiAttempt,
  parseApiRequestDescriptor,
  parseReviewJobApiAttempt,
  parseReviewJobApiCardReservation,
  parseReviewJobApiResult,
  resolveReviewJobApiResult,
  reviewJobApiAttemptEventKey,
  reviewJobApiCardReservationEventKey,
  reviewJobApiResultEventKey,
} from "./review-job-api-execution";

const HEAD = "a".repeat(40);
function proof(events: unknown[] = []): ExactReviewJobProof {
  return {
    job: {
      id: "job-1",
      workspaceId: "ws-1",
      repo: "acme/widgets",
      prNumber: 42,
      headSha: HEAD,
    },
    timeline: { record: { id: "record-1" }, events },
    contract: { id: "contract-1", version: 3 },
    verificationPlan: {
      plans: [
        {
          criterionId: "AC-API",
          criterionTextSnapshot: "Health returns OK.",
          modality: "api",
          environmentKind: "isolated_preview",
          flow: "Read health.",
          status: "planned",
          notTestableReason: null,
          uiSteps: null,
          apiRequest: { method: "GET", path: "/health", expectedStatus: 200 },
        },
      ],
    },
  } as unknown as ExactReviewJobProof;
}
function boot(overrides = {}) {
  return {
    id: "boot-1",
    workspaceId: "ws-1",
    repo: "acme/widgets",
    prNumber: 42,
    headSha: HEAD,
    status: "ready",
    url: "https://preview.example.test/",
    ...overrides,
  };
}
function event(eventKey: string, payloadRef: Record<string, unknown>) {
  return {
    id: eventKey,
    recordId: "record-1",
    eventKey,
    stage: "verification",
    actor: "jace:review-api-executor",
    payloadRef,
    at: new Date(),
    createdAt: new Date(),
  };
}

describe("review-job API execution custody helpers", () => {
  it("accepts only a bounded persisted GET descriptor", () => {
    expect(
      parseApiRequestDescriptor({
        method: "GET",
        path: "/health",
        expectedStatus: 200,
      }),
    ).toEqual({ method: "GET", path: "/health", expectedStatus: 200 });
    for (const descriptor of [
      { method: "POST", path: "/health", expectedStatus: 200 },
      { method: "GET", path: "https://evil.test", expectedStatus: 200 },
      { method: "GET", path: "//evil.test", expectedStatus: 200 },
      { method: "GET", path: "/./health", expectedStatus: 200 },
      { method: "GET", path: "/a/../health", expectedStatus: 200 },
      { method: "GET", path: "/health?debug=1", expectedStatus: 200 },
      { method: "GET", path: "/health#fragment", expectedStatus: 200 },
      { method: "GET", path: "/%2e%2e/admin", expectedStatus: 200 },
      { method: "GET", path: "/health", expectedStatus: 99 },
      { method: "GET", path: "/health", expectedStatus: 200, headers: {} },
    ])
      expect(parseApiRequestDescriptor(descriptor)).toBeNull();
  });

  it("anchors an attempt to current job, plan digest, and ready exact-head boot", () => {
    const current = proof();
    const plan = current.verificationPlan.plans[0];
    const attempt = buildReviewJobApiAttempt({
      proof: current,
      plan,
      boot: boot(),
    })!;
    expect(attempt).toMatchObject({
      kind: "review_job_api_execution_attempt",
      executionId: expect.stringMatching(/^api-/u),
      criterionId: "AC-API",
      apiRequest: { method: "GET", path: "/health", expectedStatus: 200 },
    });
    expect(
      buildReviewJobApiAttempt({
        proof: current,
        plan,
        boot: boot({ headSha: "b".repeat(40) }),
      }),
    ).toBeNull();
    expect(
      parseReviewJobApiAttempt({
        payload: { ...attempt, repo: "attacker/repo" },
        proof: current,
        plan,
      }),
    ).toBeNull();
  });

  it("keeps a status mismatch as failed decisive evidence, and rejects malformed or unpaired custody", () => {
    const current = proof();
    const plan = current.verificationPlan.plans[0];
    const attempt = buildReviewJobApiAttempt({
      proof: current,
      plan,
      boot: boot(),
    })!;
    const result = buildReviewJobApiResult({
      attempt,
      plan,
      observedStatus: 503,
      artifactKey: "review-evidence/card.json",
      contentSha256: "c".repeat(64),
    })!;
    expect(result).toMatchObject({
      state: "failed",
      observedStatus: 503,
      observed: expect.stringContaining("HTTP 503"),
    });
    current.timeline.events = [
      event(reviewJobApiAttemptEventKey({ proof: current, plan }), attempt),
    ];
    expect(
      parseReviewJobApiAttempt({ payload: attempt, proof: current, plan }),
    ).toEqual(attempt);
    expect(findReviewJobApiAttempt({ proof: current, plan })).toEqual(attempt);
    expect(
      parseReviewJobApiResult({ payload: result, proof: current, plan }),
    ).toEqual(result);
    expect(
      parseReviewJobApiCardReservation({
        payload: buildReviewJobApiCardReservation(result),
        proof: current,
        plan,
      }),
    ).toEqual(buildReviewJobApiCardReservation(result));
    current.timeline.events.push(
      event(
        reviewJobApiCardReservationEventKey({ proof: current, plan }),
        buildReviewJobApiCardReservation(result),
      ),
      event(reviewJobApiResultEventKey({ proof: current, plan }), result),
    );
    expect(resolveReviewJobApiResult({ proof: current, plan })).toMatchObject({
      status: "valid",
      result,
    });
    current.timeline.events = current.timeline.events.slice(0, 2);
    expect(resolveReviewJobApiResult({ proof: current, plan })).toEqual({
      status: "pending",
      result: null,
    });
    current.timeline.events.push(
      event(reviewJobApiResultEventKey({ proof: current, plan }), {
        ...result,
        observed: "forged",
      }),
    );
    expect(resolveReviewJobApiResult({ proof: current, plan })).toEqual({
      status: "invalid",
      result: null,
    });
  });
});
