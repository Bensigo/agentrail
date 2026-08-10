import { describe, expect, it } from "vitest";
import type { ExactReviewJobProof } from "./review-job-proof-attestation";
import {
  activeReviewDataHmacKey,
  buildStoredDataVerificationRequest,
  buildReviewJobVerificationPlan,
  dataScalarKind,
  parseReviewDataHmacKeyIds,
  reviewDataHmacKeyById,
  reviewDataScalarHmac,
} from "./review-job-verification-plan";
import {
  buildReviewJobDataAttempt,
  buildReviewJobDataCard,
  buildReviewJobDataCardReservation,
  buildReviewJobDataResult,
  parseDataRequestDescriptor,
  parseReviewJobDataResult,
  resolveReviewJobDataResult,
  reviewJobDataAttemptEventKey,
  reviewJobDataCardReservationEventKey,
  reviewJobDataResultEventKey,
} from "./review-job-data-execution";

const headSha = "a".repeat(40);
const hmacKey = { keyId: "review-data-2026-08", key: Buffer.alloc(32, 7) };
const digestBinding = {
  workspaceId: "ws-1",
  recordId: "record-1",
  jobId: "job-1",
  headSha,
  contractId: "contract-1",
  contractVersion: 3,
  criterionId: "AC-DATA",
};
function storedRequest(
  expectedJson: Array<{
    pointer: string;
    equals: string | number | boolean | null;
  }> = [
    { pointer: "/service/name", equals: "widget" },
    { pointer: "/items/0/enabled", equals: true },
  ],
) {
  return buildStoredDataVerificationRequest({
    value: {
      method: "GET",
      path: "/health",
      expectedStatus: 200,
      expectedJson,
    },
    binding: digestBinding,
    hmacKey,
  })!;
}
function observed(pointer: string, value: string | number | boolean | null) {
  const request = storedRequest();
  return {
    pointer,
    found: true as const,
    observedType: dataScalarKind(value),
    observedHmacSha256: reviewDataScalarHmac({
      key: hmacKey.key,
      context: request.digestContext,
      pointer,
      value,
    }),
  };
}
function proof(events: unknown[] = []): ExactReviewJobProof {
  return {
    job: {
      id: "job-1",
      workspaceId: "ws-1",
      repo: "acme/widgets",
      prNumber: 42,
      headSha,
    },
    timeline: { record: { id: "record-1" }, events },
    contract: { id: "contract-1", version: 3 },
    verificationPlan: {
      plans: [
        {
          criterionId: "AC-DATA",
          criterionTextSnapshot: "The health payload names the service.",
          modality: "data",
          environmentKind: "isolated_preview",
          flow: "Read health data.",
          uiSteps: null,
          apiRequest: null,
          dataRequest: storedRequest(),
          status: "planned",
          notTestableReason: null,
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
    headSha,
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
    actor: "jace:review-data-executor",
    payloadRef,
    at: new Date(),
    createdAt: new Date(),
  };
}

describe("review-job data execution custody", () => {
  it("parses a bounded rotation-aware purpose-scoped HMAC keyring", () => {
    const oldKey = Buffer.alloc(32, 8).toString("base64url");
    const env = {
      REVIEW_DATA_HMAC_ACTIVE_KEY_ID: hmacKey.keyId,
      REVIEW_DATA_HMAC_KEYS_JSON: JSON.stringify({
        [hmacKey.keyId]: hmacKey.key.toString("base64url"),
        old: oldKey,
      }),
    };
    expect(activeReviewDataHmacKey(env)?.keyId).toBe(hmacKey.keyId);
    expect(reviewDataHmacKeyById(env, "old")?.key.toString("base64url")).toBe(
      oldKey,
    );
    expect(parseReviewDataHmacKeyIds(["active", "old"])).toEqual([
      "active",
      "old",
    ]);
    expect(parseReviewDataHmacKeyIds(["old", "active"])).toBeNull();
    expect(parseReviewDataHmacKeyIds(["old", "old"])).toBeNull();
    for (const invalid of [
      { ...env, REVIEW_DATA_HMAC_ACTIVE_KEY_ID: "missing" },
      { ...env, REVIEW_DATA_HMAC_KEYS_JSON: "[]" },
      { ...env, REVIEW_DATA_HMAC_KEYS_JSON: "null" },
      { ...env, REVIEW_DATA_HMAC_KEYS_JSON: "{}" },
      {
        ...env,
        REVIEW_DATA_HMAC_KEYS_JSON: JSON.stringify(
          Object.fromEntries(
            Array.from({ length: 17 }, (_, index) => [
              `key-${index}`,
              hmacKey.key.toString("base64url"),
            ]),
          ),
        ),
      },
      {
        ...env,
        REVIEW_DATA_HMAC_KEYS_JSON: JSON.stringify({
          [hmacKey.keyId]: `${hmacKey.key.toString("base64url")}=`,
        }),
      },
      {
        ...env,
        REVIEW_DATA_HMAC_KEYS_JSON: JSON.stringify({
          "bad key": hmacKey.key.toString("base64url"),
        }),
      },
    ])
      expect(activeReviewDataHmacKey(invalid)).toBeNull();
  });
  it("accepts only strict safe GET data descriptors and rejects secret-shaped expectations and sensitive pointers", () => {
    const stored = storedRequest();
    expect(stored.digestContext).toBe(
      "13924a722577e917ba41734bc4f441372851ddd096789fad5ba2ad982f6c87e1",
    );
    expect(stored.expectedJson[0]?.equalsHmacSha256).toBe(
      "4c3918974a7abe22f7ac4072485897dd223356982978d587642b75bf1ff36f5a",
    );
    expect(parseDataRequestDescriptor(stored)).toEqual(stored);
    expect(
      parseDataRequestDescriptor({
        method: "GET",
        path: "/health",
        expectedStatus: 200,
        expectedJson: [{ pointer: "/ok", equals: true }],
      }),
    ).toBeNull();
    for (const value of [
      { method: "GET", path: "/health", expectedStatus: 200, expectedJson: [] },
      {
        method: "POST",
        path: "/health",
        expectedStatus: 200,
        expectedJson: [{ pointer: "/ok", equals: true }],
      },
      {
        method: "GET",
        path: "/health?x=1",
        expectedStatus: 200,
        expectedJson: [{ pointer: "/ok", equals: true }],
      },
      {
        method: "GET",
        path: "/health",
        expectedStatus: 200,
        expectedJson: [{ pointer: "/a~2b", equals: true }],
      },
      {
        method: "GET",
        path: "/health",
        expectedStatus: 200,
        expectedJson: [{ pointer: "/token", equals: true }],
      },
      {
        method: "GET",
        path: "/health",
        expectedStatus: 200,
        expectedJson: [{ pointer: "/profile/accessToken", equals: true }],
      },
      {
        method: "GET",
        path: "/health",
        expectedStatus: 200,
        expectedJson: [{ pointer: "/otp", equals: 123456 }],
      },
      {
        method: "GET",
        path: "/health",
        expectedStatus: 200,
        expectedJson: [{ pointer: "/profile/email", equals: "safe" }],
      },
      {
        method: "GET",
        path: "/health",
        expectedStatus: 200,
        expectedJson: [{ pointer: "/count", equals: 100_000_000 }],
      },
      {
        method: "GET",
        path: "/health",
        expectedStatus: 200,
        expectedJson: [{ pointer: "/name", equals: "person@example.test" }],
      },
      {
        method: "GET",
        path: "/health",
        expectedStatus: 200,
        expectedJson: [{ pointer: "/name", equals: "123-45-6789" }],
      },
      {
        method: "GET",
        path: "/health",
        expectedStatus: 200,
        expectedJson: [{ pointer: "/name", equals: "+1 (212) 555-0100" }],
      },
      {
        method: "GET",
        path: "/health",
        expectedStatus: 200,
        expectedJson: [{ pointer: "/name", equals: "4111 1111 1111 1111" }],
      },
      {
        method: "GET",
        path: "/health",
        expectedStatus: 200,
        expectedJson: [{ pointer: "/billing/cardNumber", equals: true }],
      },
      {
        method: "GET",
        path: "/health",
        expectedStatus: 200,
        expectedJson: [{ pointer: "/ok", equals: { nested: true } }],
      },
      {
        method: "GET",
        path: "/health",
        expectedStatus: 200,
        expectedJson: [
          { pointer: "/ok", equals: "sk-abcdefghijklmnopqrstuvwxyz123456" },
        ],
      },
    ])
      expect(
        buildStoredDataVerificationRequest({
          value,
          binding: digestBinding,
          hmacKey,
        }),
      ).toBeNull();
  });
  it("transforms submitted equality values before persistence", () => {
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
          { id: "AC-DATA", text: "Payload is right.", userVisible: false },
        ],
      },
      plannedBy: "worker-1",
      dataHmacKey: hmacKey,
      plans: [
        {
          criterionId: "AC-DATA",
          modality: "data",
          status: "planned",
          flow: "Read payload.",
          dataRequest: {
            method: "GET",
            path: "/health",
            expectedStatus: 200,
            expectedJson: [{ pointer: "/service/name", equals: "widget" }],
          },
        },
      ],
    });
    expect(built.ok).toBe(true);
    expect(JSON.stringify(built)).not.toContain('"widget"');
    if (built.ok)
      expect(built.value.plans[0]?.dataRequest).toEqual(
        storedRequest([{ pointer: "/service/name", equals: "widget" }]),
      );
  });
  it("derives marker-only receipts and never accepts or persists raw observations", () => {
    const current = proof();
    const plan = current.verificationPlan.plans[0]!;
    const attempt = buildReviewJobDataAttempt({
      proof: current,
      plan,
      boot: boot(),
    })!;
    const result = buildReviewJobDataResult({
      attempt,
      plan,
      observedStatus: 200,
      observations: [
        observed("/service/name", "widget"),
        observed("/items/0/enabled", true),
      ],
      artifactKey: "card.json",
      contentSha256: "b".repeat(64),
    })!;
    expect(result.state).toBe("proven");
    expect(result.observed).toBe(
      "The safe data GET /health returned HTTP 200; all 2 planned JSON scalar assertions matched.",
    );
    expect("observations" in result).toBe(false);
    expect(result.assertions[0]).toMatchObject({
      observed: "[MATCH]",
      observedHmacSha256: storedRequest().expectedJson[0]!.equalsHmacSha256,
      passed: true,
    });
    expect(JSON.stringify(result)).not.toContain('"widget"');
    expect(JSON.stringify(buildReviewJobDataCard(result))).not.toContain(
      '"widget"',
    );
    expect(
      (
        buildReviewJobDataCard(result).assertions as Array<
          Record<string, unknown>
        >
      )[0],
    ).toMatchObject({
      expected: {
        type: "string",
        hmacSha256: storedRequest().expectedJson[0]!.equalsHmacSha256,
      },
      observed: "[MATCH]",
      observedHmacSha256: storedRequest().expectedJson[0]!.equalsHmacSha256,
      passed: true,
    });
    expect(
      buildReviewJobDataResult({
        attempt,
        plan,
        observedStatus: 200,
        observations: [
          { pointer: "/service/name", found: true, value: "widget" },
          { pointer: "/items/0/enabled", found: false },
        ],
        artifactKey: "card.json",
        contentSha256: "b".repeat(64),
      }),
    ).toBeNull();
    const mismatch = buildReviewJobDataResult({
      attempt,
      plan,
      observedStatus: 200,
      observations: [
        observed("/service/name", "person@example.test"),
        observed("/items/0/enabled", false),
      ],
      artifactKey: "card.json",
      contentSha256: "b".repeat(64),
    })!;
    expect(JSON.stringify(mismatch)).not.toContain("person@example.test");
    expect(JSON.stringify(buildReviewJobDataCard(mismatch))).not.toContain(
      "person@example.test",
    );
    expect(mismatch.assertions[0]).toMatchObject({
      observed: "[REDACTED_MISMATCH]",
      observedHmacSha256: null,
      passed: false,
    });

    current.timeline.events = [
      event(reviewJobDataAttemptEventKey({ proof: current, plan }), attempt),
    ];
    const leakedMismatch = {
      ...mismatch,
      assertions: [
        {
          ...mismatch.assertions[0],
          observed: "person@example.test",
          observedHmacSha256: observed("/service/name", "person@example.test")
            .observedHmacSha256,
        },
        mismatch.assertions[1]!,
      ],
    };
    expect(
      parseReviewJobDataResult({
        payload: leakedMismatch,
        proof: current,
        plan,
      }),
    ).toBeNull();
  });
  it("keeps status mismatch decisive with empty caller observations and validates paired immutable custody", () => {
    const current = proof();
    const plan = current.verificationPlan.plans[0]!;
    const attempt = buildReviewJobDataAttempt({
      proof: current,
      plan,
      boot: boot(),
    })!;
    const result = buildReviewJobDataResult({
      attempt,
      plan,
      observedStatus: 503,
      observations: [],
      artifactKey: "card.json",
      contentSha256: "c".repeat(64),
    })!;
    expect(result).toMatchObject({
      state: "failed",
      observed:
        "The safe data GET /health returned HTTP 503; the planned status was 200.",
    });
    current.timeline.events = [
      event(reviewJobDataAttemptEventKey({ proof: current, plan }), attempt),
      event(
        reviewJobDataCardReservationEventKey({ proof: current, plan }),
        buildReviewJobDataCardReservation(result),
      ),
      event(reviewJobDataResultEventKey({ proof: current, plan }), result),
    ];
    expect(
      parseReviewJobDataResult({ payload: result, proof: current, plan }),
    ).toEqual(result);
    expect(resolveReviewJobDataResult({ proof: current, plan })).toMatchObject({
      status: "valid",
    });
  });
});
