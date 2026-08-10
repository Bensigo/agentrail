import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  appendChangeRecordEvent: vi.fn(),
  getJaceSessionByEveSessionId: vi.fn(),
  getPreviewBoot: vi.fn(),
}));
vi.mock("../../../../../../../../lib/review-job-proof-attestation", () => ({
  resolveCurrentReviewJobPlan: vi.fn(),
}));
vi.mock("../../../../../../../../lib/artifacts/store", () => ({
  storageConfigured: vi.fn(),
}));

import {
  appendChangeRecordEvent,
  getJaceSessionByEveSessionId,
  getPreviewBoot,
} from "@agentrail/db-postgres";
import { storageConfigured } from "../../../../../../../../lib/artifacts/store";
import {
  resolveCurrentReviewJobPlan,
  type ExactReviewJobProof,
} from "../../../../../../../../lib/review-job-proof-attestation";
import {
  buildReviewJobAttempt,
  reviewJobAttemptEventKey,
} from "../../../../../../../../lib/review-job-job-execution";
import { buildStoredJobVerificationRequest } from "../../../../../../../../lib/review-job-verification-plan";
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

function request(value: unknown, token = secret) {
  return new NextRequest(
    "http://localhost/api/v1/runner/review-jobs/job-1/job-executions/start",
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

const params = { params: Promise.resolve({ jobId: "job-1" }) };
const body = {
  eveSessionId: "eve-1",
  criterionId: "AC-JOB",
  previewBootId: "boot-1",
  digestKeyIds: [hmacKey.keyId],
};

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

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JACE_CONSOLE_TOKEN = secret;
  process.env.REVIEW_EVIDENCE_ENABLED = "1";
  process.env.REVIEW_DATA_HMAC_ACTIVE_KEY_ID = hmacKey.keyId;
  process.env.REVIEW_DATA_HMAC_KEYS_JSON = hmacKeysJson;
  vi.mocked(storageConfigured).mockReturnValue(true);
  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(session() as never);
  vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(proof() as never);
  vi.mocked(getPreviewBoot).mockResolvedValue(boot() as never);
  vi.mocked(appendChangeRecordEvent).mockImplementation(
    async (input) =>
      ({ event: { payloadRef: input.payloadRef }, inserted: true }) as never,
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

describe("job execution start", () => {
  it("fails closed on bearer, disabled custody, and caller-supplied tuple fields", async () => {
    expect((await POST(request(body, "wrong"), params)).status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();

    vi.mocked(storageConfigured).mockReturnValue(false);
    expect((await POST(request(body), params)).status).toBe(503);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();

    vi.mocked(storageConfigured).mockReturnValue(true);
    for (const supplied of [
      { ...body, repo: "attacker/repo" },
      { ...body, trigger: { path: "/admin" } },
      { ...body, headers: { authorization: "x" } },
      { ...body, expectedStatus: 204 },
    ]) {
      expect((await POST(request(supplied), params)).status).toBe(400);
    }
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("requires an active exact-job conversation and resolved workspace", async () => {
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
      expect((await POST(request(body), params)).status).toBe(409);
      expect(resolveCurrentReviewJobPlan).not.toHaveBeenCalled();
    }

    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(
      session({ workspaceId: "ws-other" }) as never,
    );
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(proof() as never);
    expect((await POST(request(body), params)).status).toBe(409);
    expect(getPreviewBoot).not.toHaveBeenCalled();
  });

  it("requires the current executable job plan before reading a preview", async () => {
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValueOnce(null);
    expect((await POST(request(body), params)).status).toBe(409);
    expect(getPreviewBoot).not.toHaveBeenCalled();

    const wrong = proof();
    wrong.verificationPlan.plans[0]!.modality = "data";
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValueOnce(
      wrong as never,
    );
    expect((await POST(request(body), params)).status).toBe(409);

    const malformed = proof();
    malformed.verificationPlan.plans[0]!.jobRequest = {
      ...storedRequest(),
      trigger: { ...storedRequest().trigger, path: "/admin" },
    };
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValueOnce(
      malformed as never,
    );
    expect((await POST(request(body), params)).status).toBe(409);
    expect(getPreviewBoot).not.toHaveBeenCalled();
  });

  it("rejects malformed, unsorted, unadvertised, and unavailable digest keys before preview", async () => {
    for (const digestKeyIds of [
      [],
      ["bad key"],
      [hmacKey.keyId, hmacKey.keyId],
      ["z-key", "a-key"],
    ]) {
      expect(
        (await POST(request({ ...body, digestKeyIds }), params)).status,
      ).toBe(400);
    }
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();

    expect(
      (await POST(request({ ...body, digestKeyIds: ["other-key"] }), params))
        .status,
    ).toBe(409);
    delete process.env.REVIEW_DATA_HMAC_KEYS_JSON;
    expect((await POST(request(body), params)).status).toBe(409);
    expect(getPreviewBoot).not.toHaveBeenCalled();
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
  });

  it("rejects absent, expired, non-ready, and every cross-tuple preview", async () => {
    for (const invalidBoot of [
      undefined,
      boot({ expiresAt: new Date(Date.now() - 1) }),
      boot({ status: "starting" }),
      boot({ workspaceId: "ws-other" }),
      boot({ repo: "other/repo" }),
      boot({ prNumber: 43 }),
      boot({ headSha: "b".repeat(40) }),
      boot({ url: null }),
    ]) {
      vi.mocked(getPreviewBoot).mockResolvedValue(invalidBoot as never);
      expect((await POST(request(body), params)).status).toBe(409);
    }
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
  });

  it("appends the exact attempt before returning only the server-owned request", async () => {
    const current = proof();
    const plan = current.verificationPlan.plans[0]!;
    const attempt = buildReviewJobAttempt({
      proof: current,
      plan,
      boot: boot(),
    })!;
    const response = await POST(request(body), params);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      ok: true,
      executionId: attempt.executionId,
      jobId: "job-1",
      criterionId: "AC-JOB",
      expected: "Job completes.",
      previewBootId: "boot-1",
      previewUrl: "https://preview.example.test/",
      jobRequest: storedRequest(),
    });
    expect(appendChangeRecordEvent).toHaveBeenCalledWith({
      recordId: "record-1",
      eventKey: reviewJobAttemptEventKey({ proof: current, plan }),
      stage: "verification",
      actor: "jace:review-job-executor",
      payloadRef: attempt,
    });
  });

  it("holds existing and racing reservations and reports ledger failure", async () => {
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
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValueOnce(
      current as never,
    );
    expect((await POST(request(body), params)).status).toBe(409);
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();

    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(proof() as never);
    vi.mocked(appendChangeRecordEvent).mockResolvedValueOnce({
      event: { payloadRef: attempt },
      inserted: false,
    } as never);
    expect((await POST(request(body), params)).status).toBe(409);

    vi.mocked(appendChangeRecordEvent).mockRejectedValueOnce(
      new Error("ledger down"),
    );
    expect((await POST(request(body), params)).status).toBe(503);
  });
});
