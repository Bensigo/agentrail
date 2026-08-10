import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("@agentrail/db-postgres", () => ({
  appendCurrentReviewJobEventsAtomically: vi.fn(),
  CurrentReviewJobNotCurrentError: class CurrentReviewJobNotCurrentError extends Error {},
  previewBootId: vi.fn(() => "boot-1"),
  getJaceSessionByEveSessionId: vi.fn(),
  getPreviewBoot: vi.fn(),
}));
vi.mock("../../../../../../../../lib/review-job-proof-attestation", () => ({
  resolveCurrentReviewJobPlan: vi.fn(),
}));
import {
  appendCurrentReviewJobEventsAtomically,
  getJaceSessionByEveSessionId,
  getPreviewBoot,
} from "@agentrail/db-postgres";
import {
  resolveCurrentReviewJobPlan,
  type ExactReviewJobProof,
} from "../../../../../../../../lib/review-job-proof-attestation";
import { buildStoredDataVerificationRequest } from "../../../../../../../../lib/review-job-verification-plan";
import { POST } from "./route";
const token = "jace-shared-secret-abc123";
const prior = process.env.JACE_CONSOLE_TOKEN;
const priorHmac = {
  active: process.env.REVIEW_DATA_HMAC_ACTIVE_KEY_ID,
  keys: process.env.REVIEW_DATA_HMAC_KEYS_JSON,
};
const headSha = "a".repeat(40);
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
const request = (body: unknown, auth = token) =>
  new NextRequest(
    "http://localhost/api/v1/runner/review-jobs/job-1/data-executions/start",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
const params = { params: Promise.resolve({ jobId: "job-1" }) };
const body = {
  eveSessionId: "eve-1",
  criterionId: "AC-DATA",
  previewBootId: "boot-1",
  digestKeyIds: [hmacKey.keyId],
};
beforeEach(() => {
  vi.clearAllMocks();
  process.env.JACE_CONSOLE_TOKEN = token;
  process.env.REVIEW_DATA_HMAC_ACTIVE_KEY_ID = hmacKey.keyId;
  process.env.REVIEW_DATA_HMAC_KEYS_JSON = hmacKeysJson;
  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
    eveSessionId: "eve-1",
    workspaceId: "ws-1",
    channel: "review-job",
    conversationKey: "review-job:job-1",
    status: "active",
  } as never);
  vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(proof() as never);
  vi.mocked(getPreviewBoot).mockResolvedValue({
    id: "boot-1",
    workspaceId: "ws-1",
    repo: "acme/widgets",
    prNumber: 42,
    headSha,
    status: "ready",
    url: "https://preview.example.test/",
    expiresAt: new Date(Date.now() + 60000),
  } as never);
  vi.mocked(appendCurrentReviewJobEventsAtomically).mockImplementation(
    async (input) =>
      ({ events: [{ event: { payloadRef: input.events[0]!.payloadRef }, inserted: true }] }) as never,
  );
});
afterEach(() => {
  if (prior === undefined) delete process.env.JACE_CONSOLE_TOKEN;
  else process.env.JACE_CONSOLE_TOKEN = prior;
  if (priorHmac.active === undefined)
    delete process.env.REVIEW_DATA_HMAC_ACTIVE_KEY_ID;
  else process.env.REVIEW_DATA_HMAC_ACTIVE_KEY_ID = priorHmac.active;
  if (priorHmac.keys === undefined)
    delete process.env.REVIEW_DATA_HMAC_KEYS_JSON;
  else process.env.REVIEW_DATA_HMAC_KEYS_JSON = priorHmac.keys;
});
describe("data execution start", () => {
  it("rejects auth and caller targets before lookup", async () => {
    expect((await POST(request(body, "wrong"), params)).status).toBe(401);
    expect(
      (await POST(request({ ...body, path: "/admin" }), params)).status,
    ).toBe(400);
    expect(
      (
        await POST(
          request({ ...body, digestKeyIds: ["z-key", "a-key"] }),
          params,
        )
      ).status,
    ).toBe(400);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });
  it("holds missing worker/server HMAC keys before reading the preview", async () => {
    expect(
      (await POST(request({ ...body, digestKeyIds: ["other-key"] }), params))
        .status,
    ).toBe(409);
    expect(getPreviewBoot).not.toHaveBeenCalled();

    delete process.env.REVIEW_DATA_HMAC_KEYS_JSON;
    expect((await POST(request(body), params)).status).toBe(409);
    expect(getPreviewBoot).not.toHaveBeenCalled();
    expect(appendCurrentReviewJobEventsAtomically).not.toHaveBeenCalled();
  });
  it("reserves only exact planned data for active session and ready matching boot", async () => {
    const response = await POST(request(body), params);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      dataRequest: {
        method: "GET",
        path: "/health",
        expectedJson: [
          expect.objectContaining({
            pointer: "/ok",
            equalsType: "boolean",
            equalsHmacSha256: storedRequest().expectedJson[0]!.equalsHmacSha256,
          }),
        ],
        digestAlgorithm: "hmac-sha256-v1",
        digestKeyId: hmacKey.keyId,
        digestContext: storedRequest().digestContext,
      },
    });
    expect(appendCurrentReviewJobEventsAtomically).toHaveBeenCalled();
    vi.mocked(getPreviewBoot).mockResolvedValueOnce({
      id: "boot-1",
      workspaceId: "ws-1",
      repo: "acme/widgets",
      prNumber: 42,
      headSha: "b".repeat(40),
      status: "ready",
      url: "https://preview.example.test/",
      expiresAt: new Date(Date.now() + 60000),
    } as never);
    expect((await POST(request(body), params)).status).toBe(409);
  });
});
