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
  artifactKey: vi.fn(() => "review-evidence/data-card.json"),
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
  putArtifact,
  signedGetUrl,
  storageConfigured,
} from "../../../../../../../../../lib/artifacts/store";
import {
  resolveCurrentReviewJobPlan,
  type ExactReviewJobProof,
} from "../../../../../../../../../lib/review-job-proof-attestation";
import {
  buildReviewJobDataAttempt,
  reviewJobDataAttemptEventKey,
} from "../../../../../../../../../lib/review-job-data-execution";
import {
  buildStoredDataVerificationRequest,
  reviewDataScalarHmac,
} from "../../../../../../../../../lib/review-job-verification-plan";
import { POST } from "./route";
const token = "jace-shared-secret-abc123";
const headSha = "a".repeat(40);
const original = {
  token: process.env.JACE_CONSOLE_TOKEN,
  evidence: process.env.REVIEW_EVIDENCE_ENABLED,
  hmacActive: process.env.REVIEW_DATA_HMAC_ACTIVE_KEY_ID,
  hmacKeys: process.env.REVIEW_DATA_HMAC_KEYS_JSON,
};
const hmacKey = { keyId: "review-data-2026-08", key: Buffer.alloc(32, 7) };
const hmacKeysJson = JSON.stringify({
  [hmacKey.keyId]: hmacKey.key.toString("base64url"),
});
function storedRequest() {
  return buildStoredDataVerificationRequest({
    value: {
      method: "GET",
      path: "/health",
      expectedStatus: 200,
      expectedJson: [{ pointer: "/ok", equals: true }],
    },
    binding: {
      workspaceId: "ws-1",
      recordId: "record-1",
      jobId: "job-1",
      headSha,
      contractId: "contract-1",
      contractVersion: 3,
      criterionId: "AC-DATA",
    },
    hmacKey,
  })!;
}
function observedTrue() {
  const stored = storedRequest();
  return reviewDataScalarHmac({
    key: hmacKey.key,
    context: stored.digestContext,
    pointer: "/ok",
    value: true,
  });
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
          criterionTextSnapshot: "Payload is right.",
          modality: "data",
          environmentKind: "isolated_preview",
          flow: "Read payload.",
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
function boot() {
  return {
    id: "boot-1",
    workspaceId: "ws-1",
    repo: "acme/widgets",
    prNumber: 42,
    headSha,
    status: "ready",
    url: "https://preview.example.test/",
    expiresAt: new Date(Date.now() + 60000),
  };
}
function bound() {
  const current = proof();
  const plan = current.verificationPlan.plans[0]!;
  const attempt = buildReviewJobDataAttempt({
    proof: current,
    plan,
    boot: boot(),
  })!;
  current.timeline.events = [
    {
      id: "event-1",
      recordId: "record-1",
      eventKey: reviewJobDataAttemptEventKey({ proof: current, plan }),
      stage: "verification",
      actor: "jace:review-data-executor",
      payloadRef: attempt,
      at: new Date(),
      createdAt: new Date(),
    },
  ];
  return { current, attempt };
}
const request = (body: unknown, executionId: string, auth = token) =>
  new NextRequest(
    `http://localhost/api/v1/runner/review-jobs/job-1/data-executions/${executionId}/complete`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
const params = (executionId: string) => ({
  params: Promise.resolve({ jobId: "job-1", executionId }),
});
beforeEach(() => {
  vi.clearAllMocks();
  process.env.JACE_CONSOLE_TOKEN = token;
  process.env.REVIEW_EVIDENCE_ENABLED = "1";
  process.env.REVIEW_DATA_HMAC_ACTIVE_KEY_ID = hmacKey.keyId;
  process.env.REVIEW_DATA_HMAC_KEYS_JSON = hmacKeysJson;
  vi.mocked(storageConfigured).mockReturnValue(true);
  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
    eveSessionId: "eve-1",
    workspaceId: "ws-1",
    channel: "review-job",
    conversationKey: "review-job:job-1",
    status: "active",
  } as never);
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
    "https://signed.test/card" as never,
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
describe("data execution complete", () => {
  it("holds an unavailable stored HMAC key before preview or result work", async () => {
    const item = bound();
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(
      item.current as never,
    );
    delete process.env.REVIEW_DATA_HMAC_KEYS_JSON;
    const response = await POST(
      request(
        {
          eveSessionId: "eve-1",
          observedStatus: 200,
          observations: [
            {
              pointer: "/ok",
              found: true,
              observedType: "boolean",
              observedHmacSha256: observedTrue(),
            },
          ],
        },
        item.attempt.executionId,
      ),
      params(item.attempt.executionId),
    );
    expect(response.status).toBe(409);
    expect(getPreviewBoot).not.toHaveBeenCalled();
    expect(putArtifact).not.toHaveBeenCalled();
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
  });
  it("requires closed observations and stores only redacted declared assertion card", async () => {
    const item = bound();
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(
      item.current as never,
    );
    expect(
      (
        await POST(
          request(
            {
              eveSessionId: "eve-1",
              observedStatus: 200,
              observations: [
                {
                  pointer: "/ok",
                  found: true,
                  observedType: "boolean",
                  observedHmacSha256: observedTrue(),
                },
              ],
              raw: {},
            },
            item.attempt.executionId,
          ),
          params(item.attempt.executionId),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await POST(
          request(
            {
              eveSessionId: "eve-1",
              observedStatus: 200,
              observations: [{ pointer: "/ok", found: true, value: true }],
            },
            item.attempt.executionId,
          ),
          params(item.attempt.executionId),
        )
      ).status,
    ).toBe(400);
    const response = await POST(
      request(
        {
          eveSessionId: "eve-1",
          observedStatus: 200,
          observations: [
            {
              pointer: "/ok",
              found: true,
              observedType: "boolean",
              observedHmacSha256: observedTrue(),
            },
          ],
        },
        item.attempt.executionId,
      ),
      params(item.attempt.executionId),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      state: "proven",
      observed:
        "The safe data GET /health returned HTTP 200; all 1 planned JSON scalar assertions matched.",
    });
    const uploaded = (
      vi.mocked(putArtifact).mock.calls[0]![1] as Buffer
    ).toString();
    expect(uploaded).not.toContain("raw");
    expect(JSON.parse(uploaded)).toMatchObject({
      request: {
        digestAlgorithm: "hmac-sha256-v1",
        digestKeyId: hmacKey.keyId,
        digestContext: storedRequest().digestContext,
      },
      assertions: [
        {
          expected: {
            type: "boolean",
            hmacSha256: storedRequest().expectedJson[0]!.equalsHmacSha256,
          },
          observed: "[MATCH]",
          observedHmacSha256: observedTrue(),
          passed: true,
        },
      ],
    });
  });
  it("accepts decisive status mismatch only with empty observations and rejects missing/extra assertion data", async () => {
    const item = bound();
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(
      item.current as never,
    );
    expect(
      (
        await POST(
          request(
            { eveSessionId: "eve-1", observedStatus: 503, observations: [] },
            item.attempt.executionId,
          ),
          params(item.attempt.executionId),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await POST(
          request(
            { eveSessionId: "eve-1", observedStatus: 200, observations: [] },
            item.attempt.executionId,
          ),
          params(item.attempt.executionId),
        )
      ).status,
    ).toBe(400);
  });
});
