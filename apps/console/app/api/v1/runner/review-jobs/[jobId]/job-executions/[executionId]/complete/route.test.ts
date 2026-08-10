import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  appendChangeRecordEvent: vi.fn(),
  appendCurrentReviewJobEventsAtomically: vi.fn(),
  CurrentReviewJobNotCurrentError: class CurrentReviewJobNotCurrentError extends Error {},
  previewBootId: vi.fn(() => "boot-1"),
  getJaceSessionByEveSessionId: vi.fn(),
  getPreviewBoot: vi.fn(),
}));
vi.mock("../../../../../../../../../lib/review-job-proof-attestation", () => ({
  resolveCurrentReviewJobPlan: vi.fn(),
}));
vi.mock("../../../../../../../../../lib/artifacts/store", () => ({
  artifactKey: vi.fn(() => "review-evidence/job-card.json"),
  putArtifact: vi.fn(),
  signedGetUrl: vi.fn(),
  storageConfigured: vi.fn(),
}));

import {
  appendChangeRecordEvent,
  appendCurrentReviewJobEventsAtomically,
  getJaceSessionByEveSessionId,
  getPreviewBoot,
} from "@agentrail/db-postgres";
import {
  artifactKey,
  putArtifact,
  signedGetUrl,
  storageConfigured,
} from "../../../../../../../../../lib/artifacts/store";
import {
  resolveCurrentReviewJobPlan,
  type ExactReviewJobProof,
} from "../../../../../../../../../lib/review-job-proof-attestation";
import {
  buildReviewJobAttempt,
  reviewJobAttemptEventKey,
  reviewJobCardReservationEventKey,
  reviewJobResultEventKey,
} from "../../../../../../../../../lib/review-job-job-execution";
import {
  buildStoredJobVerificationRequest,
  reviewJobScalarHmac,
} from "../../../../../../../../../lib/review-job-verification-plan";
import { POST } from "./route";

const secret = "jace-shared-secret-abc123";
const headSha = "a".repeat(40);
const hmacKey = { keyId: "review-data-2026-08", key: Buffer.alloc(32, 7) };
const hmacKeysJson = JSON.stringify({
  [hmacKey.keyId]: hmacKey.key.toString("base64url"),
});
const original = {
  token: process.env.JACE_CONSOLE_TOKEN,
  evidence: process.env.REVIEW_EVIDENCE_ENABLED,
  hmacActive: process.env.REVIEW_DATA_HMAC_ACTIVE_KEY_ID,
  hmacKeys: process.env.REVIEW_DATA_HMAC_KEYS_JSON,
};

function storedRequest() {
  return buildStoredJobVerificationRequest({
    value: {
      trigger: {
        method: "POST",
        path: "/__agentrail/verification/jobs/reindex/trigger",
        expectedStatus: 202,
      },
      readback: {
        method: "GET",
        path: "/__agentrail/verification/jobs/reindex/result",
        expectedStatus: 200,
        expectedJson: [{ pointer: "/state", equals: "complete" }],
      },
    },
    binding: {
      workspaceId: "ws-1",
      recordId: "record-1",
      jobId: "job-1",
      headSha,
      contractId: "contract-1",
      contractVersion: 3,
      criterionId: "AC-JOB",
    },
    hmacKey,
  })!;
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
          criterionId: "AC-JOB",
          criterionTextSnapshot: "Job completes.",
          modality: "job",
          environmentKind: "isolated_preview",
          flow: "Trigger and read.",
          uiSteps: null,
          apiRequest: null,
          dataRequest: null,
          jobRequest: storedRequest(),
          status: "planned",
          notTestableReason: null,
        },
      ],
    },
  } as unknown as ExactReviewJobProof;
}

function event(eventKey: string, payloadRef: Record<string, unknown>) {
  return {
    id: eventKey,
    recordId: "record-1",
    eventKey,
    stage: "verification",
    actor: "jace:review-job-executor",
    payloadRef,
    at: new Date(),
    createdAt: new Date(),
  };
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
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

function bound() {
  const current = proof();
  const plan = current.verificationPlan.plans[0]!;
  const attempt = buildReviewJobAttempt({
    proof: current,
    plan,
    boot: boot(),
  })!;
  current.timeline.events = [
    event(reviewJobAttemptEventKey({ proof: current, plan }), attempt),
  ];
  return { current, plan, attempt };
}

function session(overrides = {}) {
  return {
    eveSessionId: "eve-1",
    workspaceId: "ws-1",
    channel: "review-job",
    conversationKey: "review-job:job-1",
    status: "active",
    ...overrides,
  };
}

function request(value: unknown, executionId: string, token = secret) {
  return new NextRequest(
    `http://localhost/api/v1/runner/review-jobs/job-1/job-executions/${executionId}/complete`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(value),
    },
  );
}

const params = (executionId: string, jobId = "job-1") => ({
  params: Promise.resolve({ jobId, executionId }),
});

function matchingObservation(value = "complete") {
  const descriptor = storedRequest();
  return {
    pointer: "/state",
    found: true,
    observedType: "string",
    observedHmacSha256: reviewJobScalarHmac({
      key: hmacKey.key,
      context: descriptor.readback.digestContext,
      pointer: "/state",
      value,
    }),
  };
}

const completedBody = {
  eveSessionId: "eve-1",
  observedTriggerStatus: 202,
  observedReadbackStatus: 200,
  observations: [matchingObservation()],
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JACE_CONSOLE_TOKEN = secret;
  process.env.REVIEW_EVIDENCE_ENABLED = "1";
  process.env.REVIEW_DATA_HMAC_ACTIVE_KEY_ID = hmacKey.keyId;
  process.env.REVIEW_DATA_HMAC_KEYS_JSON = hmacKeysJson;
  vi.mocked(storageConfigured).mockReturnValue(true);
  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(session() as never);
  const item = bound();
  vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(
    item.current as never,
  );
  vi.mocked(getPreviewBoot).mockResolvedValue(boot() as never);
  vi.mocked(appendChangeRecordEvent).mockImplementation(
    async (input) =>
      ({ event: { payloadRef: input.payloadRef }, inserted: true }) as never,
  );
  vi.mocked(appendCurrentReviewJobEventsAtomically).mockImplementation(
    async (input) =>
      ({ events: [{ event: { payloadRef: input.events[0]!.payloadRef }, inserted: true }] }) as never,
  );
  vi.mocked(putArtifact).mockResolvedValue(undefined);
  vi.mocked(signedGetUrl).mockResolvedValue(
    "https://evidence.example.test/signed" as never,
  );
});

afterEach(() => {
  if (original.token === undefined) delete process.env.JACE_CONSOLE_TOKEN;
  else process.env.JACE_CONSOLE_TOKEN = original.token;
  if (original.evidence === undefined)
    delete process.env.REVIEW_EVIDENCE_ENABLED;
  else process.env.REVIEW_EVIDENCE_ENABLED = original.evidence;
  if (original.hmacActive === undefined)
    delete process.env.REVIEW_DATA_HMAC_ACTIVE_KEY_ID;
  else process.env.REVIEW_DATA_HMAC_ACTIVE_KEY_ID = original.hmacActive;
  if (original.hmacKeys === undefined)
    delete process.env.REVIEW_DATA_HMAC_KEYS_JSON;
  else process.env.REVIEW_DATA_HMAC_KEYS_JSON = original.hmacKeys;
});

describe("job execution complete", () => {
  it("fails closed on bearer and disabled storage before session or ledger reads", async () => {
    const item = bound();
    expect(
      (
        await POST(
          request(completedBody, item.attempt.executionId, "wrong"),
          params(item.attempt.executionId),
        )
      ).status,
    ).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();

    vi.mocked(storageConfigured).mockReturnValue(false);
    expect(
      (
        await POST(
          request(completedBody, item.attempt.executionId),
          params(item.attempt.executionId),
        )
      ).status,
    ).toBe(503);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
  });

  it("accepts only the exact completion body and both valid status transitions", async () => {
    const item = bound();
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(
      item.current as never,
    );
    for (const invalid of [
      { ...completedBody, path: "/admin" },
      { ...completedBody, observations: [] },
      {
        ...completedBody,
        observedTriggerStatus: 500,
        observedReadbackStatus: 200,
        observations: [],
      },
      {
        ...completedBody,
        observedReadbackStatus: null,
        observations: [],
      },
      {
        ...completedBody,
        observations: [{ ...matchingObservation(), value: "raw" }],
      },
    ]) {
      expect(
        (
          await POST(
            request(invalid, item.attempt.executionId),
            params(item.attempt.executionId),
          )
        ).status,
      ).toBe(400);
    }

    const triggerMismatch = {
      eveSessionId: "eve-1",
      observedTriggerStatus: 500,
      observedReadbackStatus: null,
      observations: [],
    };
    expect(
      (
        await POST(
          request(triggerMismatch, item.attempt.executionId),
          params(item.attempt.executionId),
        )
      ).status,
    ).toBe(201);
  });

  it("requires an active job-bound session, workspace, current plan, and reserved execution", async () => {
    const item = bound();
    for (const invalid of [
      undefined,
      session({ status: "closed" }),
      session({ channel: "other" }),
      session({ conversationKey: "review-job:other" }),
    ]) {
      vi.clearAllMocks();
      vi.mocked(storageConfigured).mockReturnValue(true);
      vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(
        invalid as never,
      );
      expect(
        (
          await POST(
            request(completedBody, item.attempt.executionId),
            params(item.attempt.executionId),
          )
        ).status,
      ).toBe(409);
      expect(resolveCurrentReviewJobPlan).not.toHaveBeenCalled();
    }

    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(
      session({ workspaceId: "ws-other" }) as never,
    );
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(
      item.current as never,
    );
    expect(
      (
        await POST(
          request(completedBody, item.attempt.executionId),
          params(item.attempt.executionId),
        )
      ).status,
    ).toBe(409);

    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(
      session() as never,
    );
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(null);
    expect(
      (
        await POST(
          request(completedBody, item.attempt.executionId),
          params(item.attempt.executionId),
        )
      ).status,
    ).toBe(409);

    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(proof() as never);
    expect(
      (
        await POST(
          request(completedBody, "job-not-reserved"),
          params("job-not-reserved"),
        )
      ).status,
    ).toBe(409);
    expect(getPreviewBoot).not.toHaveBeenCalled();

    expect(
      (
        await POST(
          request(completedBody, item.attempt.executionId),
          params(item.attempt.executionId, "other-job"),
        )
      ).status,
    ).toBe(409);
  });

  it("rejects a malformed stored attempt and unavailable retained HMAC key before preview", async () => {
    const item = bound();
    const attemptEvent = item.current.timeline.events[0]!;
    attemptEvent.payloadRef = {
      ...attemptEvent.payloadRef,
      headSha: "b".repeat(40),
    };
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(
      item.current as never,
    );
    expect(
      (
        await POST(
          request(completedBody, item.attempt.executionId),
          params(item.attempt.executionId),
        )
      ).status,
    ).toBe(409);
    expect(getPreviewBoot).not.toHaveBeenCalled();

    const valid = bound();
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(
      valid.current as never,
    );
    delete process.env.REVIEW_DATA_HMAC_KEYS_JSON;
    expect(
      (
        await POST(
          request(completedBody, valid.attempt.executionId),
          params(valid.attempt.executionId),
        )
      ).status,
    ).toBe(409);
    expect(getPreviewBoot).not.toHaveBeenCalled();
    expect(putArtifact).not.toHaveBeenCalled();
  });

  it("rejects expired, non-ready, and every cross-tuple preview before custody", async () => {
    const item = bound();
    for (const invalidBoot of [
      undefined,
      boot({ expiresAt: new Date(Date.now() - 1) }),
      boot({ status: "stopped" }),
      boot({ workspaceId: "ws-other" }),
      boot({ repo: "other/repo" }),
      boot({ prNumber: 43 }),
      boot({ headSha: "b".repeat(40) }),
      boot({ url: "https://other.example.test/" }),
    ]) {
      vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(
        item.current as never,
      );
      vi.mocked(getPreviewBoot).mockResolvedValue(invalidBoot as never);
      expect(
        (
          await POST(
            request(completedBody, item.attempt.executionId),
            params(item.attempt.executionId),
          )
        ).status,
      ).toBe(409);
    }
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
    expect(putArtifact).not.toHaveBeenCalled();
  });

  it("stores a marker-only proven card after reserving custody", async () => {
    const item = bound();
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(
      item.current as never,
    );
    const response = await POST(
      request(completedBody, item.attempt.executionId),
      params(item.attempt.executionId),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      ok: true,
      state: "proven",
      expected: "Job completes.",
      observed:
        "The safe job trigger and readback returned planned HTTP statuses; all 1 planned JSON scalar assertions matched.",
      observedTriggerStatus: 202,
      observedReadbackStatus: 200,
      assertionCount: 1,
      evidenceRef: `review-job-execution:${item.attempt.executionId}`,
      evidenceKey: "review-evidence/job-card.json",
      evidenceUrl: "https://evidence.example.test/signed",
    });
    expect(putArtifact).toHaveBeenCalledWith(
      "review-evidence/job-card.json",
      expect.any(Buffer),
      "application/json",
    );
    const uploaded = (
      vi.mocked(putArtifact).mock.calls[0]![1] as Buffer
    ).toString();
    expect(uploaded).not.toContain('"complete"');
    expect(uploaded).not.toContain("observations");
    expect(JSON.parse(uploaded)).toMatchObject({
      trigger: {
        method: "POST",
        path: "/__agentrail/verification/jobs/reindex/trigger",
        expectedStatus: 202,
        observedStatus: 202,
      },
      readback: {
        method: "GET",
        path: "/__agentrail/verification/jobs/reindex/result",
        expectedStatus: 200,
        observedStatus: 200,
        digestAlgorithm: "hmac-sha256-v1",
        digestKeyId: hmacKey.keyId,
      },
      assertions: [
        {
          expected: {
            type: "string",
            hmacSha256:
              storedRequest().readback.expectedJson[0]!.equalsHmacSha256,
          },
          observed: "[MATCH]",
          observedHmacSha256:
            storedRequest().readback.expectedJson[0]!.equalsHmacSha256,
          passed: true,
        },
      ],
    });
    expect(
      vi.mocked(appendCurrentReviewJobEventsAtomically).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(putArtifact).mock.invocationCallOrder[0]!);
  });

  it("persists readback and assertion mismatches as not_proven with closed observations", async () => {
    const readback = bound();
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(
      readback.current as never,
    );
    const readbackResponse = await POST(
      request(
        {
          ...completedBody,
          observedReadbackStatus: 503,
          observations: [],
        },
        readback.attempt.executionId,
      ),
      params(readback.attempt.executionId),
    );
    expect(readbackResponse.status).toBe(201);
    expect((await readbackResponse.json()).state).toBe("not_proven");

    vi.clearAllMocks();
    vi.mocked(storageConfigured).mockReturnValue(true);
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(
      session() as never,
    );
    const mismatch = bound();
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(
      mismatch.current as never,
    );
    vi.mocked(getPreviewBoot).mockResolvedValue(boot() as never);
    vi.mocked(appendChangeRecordEvent).mockImplementation(
      async (input) =>
        ({ event: { payloadRef: input.payloadRef }, inserted: true }) as never,
    );
    vi.mocked(putArtifact).mockResolvedValue(undefined);
    vi.mocked(signedGetUrl).mockResolvedValue(
      "https://evidence.example.test/signed" as never,
    );
    const mismatchResponse = await POST(
      request(
        { ...completedBody, observations: [matchingObservation("running")] },
        mismatch.attempt.executionId,
      ),
      params(mismatch.attempt.executionId),
    );
    expect(mismatchResponse.status).toBe(201);
    expect((await mismatchResponse.json()).state).toBe("not_proven");
    expect(
      (vi.mocked(putArtifact).mock.calls[0]![1] as Buffer).toString(),
    ).not.toContain("running");
  });

  it("holds competing or invalid reservations before artifact upload", async () => {
    const item = bound();
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(
      item.current as never,
    );
    vi.mocked(appendCurrentReviewJobEventsAtomically).mockResolvedValueOnce({
      events: [{ event: {
        payloadRef: {
          kind: "review_job_card_upload_reservation",
          result: { artifactKey: "other.json" },
        },
      }, inserted: false }],
    } as never);
    expect(
      (
        await POST(
          request(completedBody, item.attempt.executionId),
          params(item.attempt.executionId),
        )
      ).status,
    ).toBe(409);
    expect(putArtifact).not.toHaveBeenCalled();
    expect(artifactKey).toHaveBeenCalled();

    const invalid = bound();
    invalid.current.timeline.events.push(
      event(
        reviewJobCardReservationEventKey({
          proof: invalid.current,
          plan: invalid.plan,
        }),
        { kind: "review_job_card_upload_reservation", result: {} },
      ),
    );
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(
      invalid.current as never,
    );
    expect(
      (
        await POST(
          request(completedBody, invalid.attempt.executionId),
          params(invalid.attempt.executionId),
        )
      ).status,
    ).toBe(409);
    expect(putArtifact).not.toHaveBeenCalled();
  });

  it("replays only the exact immutable result and rejects conflict or invalid custody", async () => {
    const item = bound();
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(
      item.current as never,
    );
    expect(
      (
        await POST(
          request(completedBody, item.attempt.executionId),
          params(item.attempt.executionId),
        )
      ).status,
    ).toBe(201);
    const reservation = vi.mocked(appendCurrentReviewJobEventsAtomically).mock.calls[0]![0].events[0]!.payloadRef as Record<string, unknown>;
    const result = vi.mocked(appendChangeRecordEvent).mock.calls[0]![0].payloadRef as Record<string, unknown>;
    item.current.timeline.events.push(
      event(
        reviewJobCardReservationEventKey({
          proof: item.current,
          plan: item.plan,
        }),
        reservation,
      ),
      event(
        reviewJobResultEventKey({ proof: item.current, plan: item.plan }),
        result,
      ),
    );
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(
      item.current as never,
    );
    vi.mocked(putArtifact).mockClear();
    expect(
      (
        await POST(
          request(completedBody, item.attempt.executionId),
          params(item.attempt.executionId),
        )
      ).status,
    ).toBe(200);
    expect(putArtifact).not.toHaveBeenCalled();

    expect(
      (
        await POST(
          request(
            {
              ...completedBody,
              observedReadbackStatus: 503,
              observations: [],
            },
            item.attempt.executionId,
          ),
          params(item.attempt.executionId),
        )
      ).status,
    ).toBe(409);
    expect(putArtifact).not.toHaveBeenCalled();

    item.current.timeline.events[item.current.timeline.events.length - 1] =
      event(reviewJobResultEventKey({ proof: item.current, plan: item.plan }), {
        ...result,
        state: "not_proven",
      });
    expect(
      (
        await POST(
          request(completedBody, item.attempt.executionId),
          params(item.attempt.executionId),
        )
      ).status,
    ).toBe(409);
  });

  it("resumes an exact pending reservation without changing custody", async () => {
    const item = bound();
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(
      item.current as never,
    );
    vi.mocked(putArtifact).mockRejectedValueOnce(new Error("store down"));
    expect(
      (
        await POST(
          request(completedBody, item.attempt.executionId),
          params(item.attempt.executionId),
        )
      ).status,
    ).toBe(500);
    const reservation = vi.mocked(appendCurrentReviewJobEventsAtomically).mock.calls[0]![0]
      .events[0]!.payloadRef as Record<string, unknown>;
    item.current.timeline.events.push(
      event(
        reviewJobCardReservationEventKey({
          proof: item.current,
          plan: item.plan,
        }),
        reservation,
      ),
    );
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(
      item.current as never,
    );
    vi.mocked(putArtifact).mockResolvedValue(undefined);
    expect(
      (
        await POST(
          request(completedBody, item.attempt.executionId),
          params(item.attempt.executionId),
        )
      ).status,
    ).toBe(201);
  });

  it("reports reservation, storage, result-ledger, and signing failures without success", async () => {
    const reservationFailure = bound();
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(
      reservationFailure.current as never,
    );
    vi.mocked(appendCurrentReviewJobEventsAtomically).mockRejectedValueOnce(
      new Error("reservation append down"),
    );
    expect(
      (
        await POST(
          request(completedBody, reservationFailure.attempt.executionId),
          params(reservationFailure.attempt.executionId),
        )
      ).status,
    ).toBe(503);
    expect(putArtifact).not.toHaveBeenCalled();

    const storageFailure = bound();
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(
      storageFailure.current as never,
    );
    vi.mocked(appendChangeRecordEvent).mockImplementation(
      async (input) =>
        ({ event: { payloadRef: input.payloadRef }, inserted: true }) as never,
    );
    vi.mocked(putArtifact).mockRejectedValueOnce(new Error("store down"));
    expect(
      (
        await POST(
          request(completedBody, storageFailure.attempt.executionId),
          params(storageFailure.attempt.executionId),
        )
      ).status,
    ).toBe(500);

    const resultFailure = bound();
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(
      resultFailure.current as never,
    );
    vi.mocked(putArtifact).mockResolvedValue(undefined);
    vi.mocked(appendChangeRecordEvent).mockRejectedValueOnce(
      new Error("result append down"),
    );
    expect(
      (
        await POST(
          request(completedBody, resultFailure.attempt.executionId),
          params(resultFailure.attempt.executionId),
        )
      ).status,
    ).toBe(503);
    expect(putArtifact).toHaveBeenCalled();

    const signFailure = bound();
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(
      signFailure.current as never,
    );
    vi.mocked(appendChangeRecordEvent).mockImplementation(
      async (input) =>
        ({ event: { payloadRef: input.payloadRef }, inserted: true }) as never,
    );
    vi.mocked(signedGetUrl).mockRejectedValueOnce(new Error("sign down"));
    expect(
      (
        await POST(
          request(completedBody, signFailure.attempt.executionId),
          params(signFailure.attempt.executionId),
        )
      ).status,
    ).toBe(500);
  });
});
