import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  appendChangeRecordEvent: vi.fn(),
  getJaceSessionByEveSessionId: vi.fn(),
  getPreviewBoot: vi.fn(),
}));
vi.mock("../../../../../../../../../lib/review-job-proof-attestation", () => ({
  resolveCurrentReviewJobPlan: vi.fn(),
}));
vi.mock("../../../../../../../../../lib/artifacts/store", () => ({
  artifactKey: vi.fn(() => "review-evidence/api-card.json"),
  putArtifact: vi.fn(),
  signedGetUrl: vi.fn(),
  storageConfigured: vi.fn(),
}));

import {
  appendChangeRecordEvent,
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
  buildReviewJobApiAttempt,
  reviewJobApiAttemptEventKey,
  reviewJobApiCardReservationEventKey,
  reviewJobApiResultEventKey,
} from "../../../../../../../../../lib/review-job-api-execution";
import { POST } from "./route";

const secret = "jace-shared-secret-abc123";
const headSha = "a".repeat(40);
const original = {
  token: process.env.JACE_CONSOLE_TOKEN,
  evidence: process.env.REVIEW_EVIDENCE_ENABLED,
};
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
          criterionId: "AC-API",
          criterionTextSnapshot: "Health works.",
          modality: "api",
          environmentKind: "isolated_preview",
          flow: "Read health.",
          uiSteps: null,
          apiRequest: { method: "GET", path: "/health", expectedStatus: 200 },
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
    actor: "jace:review-api-executor",
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
  const plan = current.verificationPlan.plans[0];
  const attempt = buildReviewJobApiAttempt({
    proof: current,
    plan,
    boot: boot(),
  })!;
  current.timeline.events = [
    event(reviewJobApiAttemptEventKey({ proof: current, plan }), attempt),
  ];
  return { current, plan, attempt };
}
function request(body: unknown, executionId: string, token = secret) {
  return new NextRequest(
    `http://localhost/api/v1/runner/review-jobs/job-1/api-executions/${executionId}/complete`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}
const params = (executionId: string) => ({
  params: Promise.resolve({ jobId: "job-1", executionId }),
});
beforeEach(() => {
  vi.clearAllMocks();
  process.env.JACE_CONSOLE_TOKEN = secret;
  process.env.REVIEW_EVIDENCE_ENABLED = "1";
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
});

describe("API execution complete", () => {
  it("fails closed before evidence or ledger reads when its bearer is wrong", async () => {
    const item = bound();
    expect(
      (await POST(request({ eveSessionId: "eve-1", observedStatus: 200 }, item.attempt.executionId, "wrong"), params(item.attempt.executionId))).status,
    ).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    expect(putArtifact).not.toHaveBeenCalled();
  });
  it("requires enabled evidence storage and a closed status-only body", async () => {
    const item = bound();
    vi.mocked(storageConfigured).mockReturnValue(false);
    expect(
      (
        await POST(
          request(
            { eveSessionId: "eve-1", observedStatus: 200 },
            item.attempt.executionId,
          ),
          params(item.attempt.executionId),
        )
      ).status,
    ).toBe(503);
    vi.mocked(storageConfigured).mockReturnValue(true);
    expect(
      (
        await POST(
          request(
            { eveSessionId: "eve-1", observedStatus: 200, path: "/admin" },
            item.attempt.executionId,
          ),
          params(item.attempt.executionId),
        )
      ).status,
    ).toBe(400);
  });
  it("stores a server-built redacted card and keeps status mismatch as failed evidence", async () => {
    const item = bound();
    const response = await POST(
      request(
        { eveSessionId: "eve-1", observedStatus: 503 },
        item.attempt.executionId,
      ),
      params(item.attempt.executionId),
    );
    expect(response.status).toBe(201);
    expect((await response.json()).state).toBe("failed");
    expect(putArtifact).toHaveBeenCalledWith(
      "review-evidence/api-card.json",
      expect.any(Buffer),
      "application/json",
    );
    const uploaded = vi.mocked(putArtifact).mock.calls[0]![1] as Buffer;
    expect(uploaded.toString()).toContain('"method":"GET"');
    expect(uploaded.toString()).not.toContain("authorization");
    expect(appendChangeRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: reviewJobApiCardReservationEventKey({
          proof: item.current,
          plan: item.plan,
        }),
      }),
    );
    expect(appendChangeRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: reviewJobApiResultEventKey({
          proof: item.current,
          plan: item.plan,
        }),
      }),
    );
  });
  it("holds competing or malformed custody before writing artifacts", async () => {
    const item = bound();
    vi.mocked(appendChangeRecordEvent).mockResolvedValueOnce({
      event: {
        payloadRef: {
          kind: "review_job_api_card_upload_reservation",
          result: { artifactKey: "other.json" },
        },
      },
      inserted: false,
    } as never);
    expect(
      (
        await POST(
          request(
            { eveSessionId: "eve-1", observedStatus: 200 },
            item.attempt.executionId,
          ),
          params(item.attempt.executionId),
        )
      ).status,
    ).toBe(409);
    expect(putArtifact).not.toHaveBeenCalled();
    expect(artifactKey).toHaveBeenCalled();
  });
  it("requires the active job-bound workspace and an exact server reservation", async () => {
    const item = bound();
    for (const invalid of [
      undefined,
      { eveSessionId: "eve-1", workspaceId: "ws-1", channel: "review-job", conversationKey: "review-job:job-1", status: "closed" },
      { eveSessionId: "eve-1", workspaceId: "ws-1", channel: "review-job", conversationKey: "review-job:other", status: "active" },
    ]) {
      vi.clearAllMocks();
      vi.mocked(storageConfigured).mockReturnValue(true);
      vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(invalid as never);
      expect((await POST(request({ eveSessionId: "eve-1", observedStatus: 200 }, item.attempt.executionId), params(item.attempt.executionId))).status).toBe(409);
      expect(resolveCurrentReviewJobPlan).not.toHaveBeenCalled();
    }
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({ eveSessionId: "eve-1", workspaceId: "ws-other", channel: "review-job", conversationKey: "review-job:job-1", status: "active" } as never);
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(item.current as never);
    expect((await POST(request({ eveSessionId: "eve-1", observedStatus: 200 }, item.attempt.executionId), params(item.attempt.executionId))).status).toBe(409);

    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({ eveSessionId: "eve-1", workspaceId: "ws-1", channel: "review-job", conversationKey: "review-job:job-1", status: "active" } as never);
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(proof([]) as never);
    expect((await POST(request({ eveSessionId: "eve-1", observedStatus: 200 }, "api-not-reserved"), params("api-not-reserved"))).status).toBe(409);
    expect(getPreviewBoot).not.toHaveBeenCalled();
  });
  it("rejects expired, non-ready, and cross-head preview boots without writing a card", async () => {
    const item = bound();
    for (const invalidBoot of [
      undefined,
      boot({ expiresAt: new Date(Date.now() - 1) }),
      boot({ status: "stopped" }),
      boot({ workspaceId: "ws-other" }),
      boot({ headSha: "b".repeat(40) }),
    ]) {
      vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(item.current as never);
      vi.mocked(getPreviewBoot).mockResolvedValue(invalidBoot as never);
      expect((await POST(request({ eveSessionId: "eve-1", observedStatus: 200 }, item.attempt.executionId), params(item.attempt.executionId))).status).toBe(409);
    }
    expect(putArtifact).not.toHaveBeenCalled();
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
  });
  it("returns an exact immutable replay without another upload, and rejects a conflicting stored result", async () => {
    const item = bound();
    const input = { eveSessionId: "eve-1", observedStatus: 200 };
    expect((await POST(request(input, item.attempt.executionId), params(item.attempt.executionId))).status).toBe(201);
    const calls = vi.mocked(appendChangeRecordEvent).mock.calls;
    const reservation = calls[0]![0].payloadRef as Record<string, unknown>;
    const result = calls[1]![0].payloadRef as Record<string, unknown>;
    item.current.timeline.events.push(
      event(reviewJobApiCardReservationEventKey({ proof: item.current, plan: item.plan }), reservation),
      event(reviewJobApiResultEventKey({ proof: item.current, plan: item.plan }), result),
    );
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(item.current as never);
    vi.mocked(putArtifact).mockClear();
    expect((await POST(request(input, item.attempt.executionId), params(item.attempt.executionId))).status).toBe(200);
    expect(putArtifact).not.toHaveBeenCalled();

    const conflicting = { ...result, observedStatus: 503 };
    item.current.timeline.events[item.current.timeline.events.length - 1] = event(
      reviewJobApiResultEventKey({ proof: item.current, plan: item.plan }),
      conflicting,
    );
    expect((await POST(request(input, item.attempt.executionId), params(item.attempt.executionId))).status).toBe(409);
    expect(putArtifact).not.toHaveBeenCalled();
  });
  it("allows the exact pending reservation to resume after storage or result-record failure, but reports append and signing failures", async () => {
    const item = bound();
    const input = { eveSessionId: "eve-1", observedStatus: 200 };
    vi.mocked(putArtifact).mockRejectedValueOnce(new Error("store down"));
    expect((await POST(request(input, item.attempt.executionId), params(item.attempt.executionId))).status).toBe(500);
    const reservation = vi.mocked(appendChangeRecordEvent).mock.calls[0]![0].payloadRef as Record<string, unknown>;
    item.current.timeline.events.push(event(reviewJobApiCardReservationEventKey({ proof: item.current, plan: item.plan }), reservation));
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(item.current as never);
    vi.mocked(putArtifact).mockResolvedValue(undefined);
    expect((await POST(request(input, item.attempt.executionId), params(item.attempt.executionId))).status).toBe(201);

    const second = bound();
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(second.current as never);
    vi.mocked(appendChangeRecordEvent).mockImplementationOnce(async (input) => ({ event: { payloadRef: input.payloadRef }, inserted: true }) as never).mockRejectedValueOnce(new Error("result append down"));
    expect((await POST(request(input, second.attempt.executionId), params(second.attempt.executionId))).status).toBe(503);
    expect(putArtifact).toHaveBeenCalled();
    const secondReservation = vi.mocked(appendChangeRecordEvent).mock.calls.at(-2)![0].payloadRef as Record<string, unknown>;
    second.current.timeline.events.push(event(reviewJobApiCardReservationEventKey({ proof: second.current, plan: second.plan }), secondReservation));
    expect((await POST(request(input, second.attempt.executionId), params(second.attempt.executionId))).status).toBe(201);

    const signed = bound();
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(signed.current as never);
    vi.mocked(signedGetUrl).mockRejectedValueOnce(new Error("sign down"));
    expect((await POST(request(input, signed.attempt.executionId), params(signed.attempt.executionId))).status).toBe(500);
  });
});
