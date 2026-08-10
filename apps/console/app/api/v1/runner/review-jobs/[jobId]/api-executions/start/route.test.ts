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

import {
  appendChangeRecordEvent,
  getJaceSessionByEveSessionId,
  getPreviewBoot,
} from "@agentrail/db-postgres";
import {
  resolveCurrentReviewJobPlan,
  type ExactReviewJobProof,
} from "../../../../../../../../lib/review-job-proof-attestation";
import {
  buildReviewJobApiAttempt,
  reviewJobApiAttemptEventKey,
} from "../../../../../../../../lib/review-job-api-execution";
import { POST } from "./route";

const secret = "jace-shared-secret-abc123";
const original = process.env.JACE_CONSOLE_TOKEN;
const headSha = "a".repeat(40);
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
function request(body: unknown, token = secret) {
  return new NextRequest(
    "http://localhost/api/v1/runner/review-jobs/job-1/api-executions/start",
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
const params = { params: Promise.resolve({ jobId: "job-1" }) };
const body = {
  eveSessionId: "eve-1",
  criterionId: "AC-API",
  previewBootId: "boot-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JACE_CONSOLE_TOKEN = secret;
  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(session() as never);
  vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(proof() as never);
  vi.mocked(getPreviewBoot).mockResolvedValue(boot() as never);
  vi.mocked(appendChangeRecordEvent).mockImplementation(
    async (input) =>
      ({ event: { payloadRef: input.payloadRef }, inserted: true }) as never,
  );
});
afterEach(() => {
  if (original === undefined) delete process.env.JACE_CONSOLE_TOKEN;
  else process.env.JACE_CONSOLE_TOKEN = original;
});

describe("API execution start", () => {
  it("fails closed before reading a session when its bearer is missing or wrong", async () => {
    expect((await POST(request(body, "wrong"), params)).status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });
  it("rejects caller-supplied repo, path, headers, or status before any job lookup", async () => {
    for (const supplied of [
      { ...body, repo: "attacker/repo" },
      { ...body, path: "/admin" },
      { ...body, headers: { authorization: "x" } },
    ])
      expect((await POST(request(supplied), params)).status).toBe(400);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });
  it("reserves and returns only the server-persisted safe GET descriptor", async () => {
    const current = proof();
    const plan = current.verificationPlan.plans[0];
    const attempt = buildReviewJobApiAttempt({
      proof: current,
      plan,
      boot: boot(),
    })!;
    const response = await POST(request(body), params);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      executionId: attempt.executionId,
      apiRequest: { method: "GET", path: "/health", expectedStatus: 200 },
    });
    expect(appendChangeRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: reviewJobApiAttemptEventKey({ proof: current, plan }),
        payloadRef: attempt,
      }),
    );
  });
  it("requires an active review conversation and its resolved workspace before reading the plan", async () => {
    for (const invalid of [
      undefined,
      session({ status: "closed" }),
      session({ channel: "other" }),
      session({ conversationKey: "review-job:other" }),
    ]) {
      vi.clearAllMocks();
      vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(invalid as never);
      expect((await POST(request(body), params)).status).toBe(409);
      expect(resolveCurrentReviewJobPlan).not.toHaveBeenCalled();
    }
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(session({ workspaceId: "ws-other" }) as never);
    expect((await POST(request(body), params)).status).toBe(409);
    expect(getPreviewBoot).not.toHaveBeenCalled();
  });
  it("rejects non-executable plans and every stale or cross-head preview before reservation", async () => {
    const unsafe = proof();
    unsafe.verificationPlan.plans[0]!.apiRequest = { method: "POST", path: "/health", expectedStatus: 200 } as never;
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValueOnce(unsafe as never);
    expect((await POST(request(body), params)).status).toBe(409);
    expect(getPreviewBoot).not.toHaveBeenCalled();

    for (const invalidBoot of [
      undefined,
      boot({ expiresAt: new Date(Date.now() - 1) }),
      boot({ status: "starting" }),
      boot({ workspaceId: "ws-other" }),
      boot({ headSha: "b".repeat(40) }),
    ]) {
      vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(proof() as never);
      vi.mocked(getPreviewBoot).mockResolvedValue(invalidBoot as never);
      expect((await POST(request(body), params)).status).toBe(409);
    }
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
  });
  it("holds both historical and racing attempt reservations, and surfaces an append outage", async () => {
    const current = proof();
    const plan = current.verificationPlan.plans[0]!;
    const attempt = buildReviewJobApiAttempt({ proof: current, plan, boot: boot() })!;
    current.timeline.events = [eventless(reviewJobApiAttemptEventKey({ proof: current, plan }), attempt)];
    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValueOnce(current as never);
    expect((await POST(request(body), params)).status).toBe(409);
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();

    vi.mocked(resolveCurrentReviewJobPlan).mockResolvedValue(proof() as never);
    vi.mocked(appendChangeRecordEvent).mockResolvedValueOnce({ event: { payloadRef: attempt }, inserted: false } as never);
    expect((await POST(request(body), params)).status).toBe(409);

    vi.mocked(appendChangeRecordEvent).mockRejectedValueOnce(new Error("ledger down"));
    expect((await POST(request(body), params)).status).toBe(503);
  });
});

function eventless(eventKey: string, payloadRef: Record<string, unknown>) {
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
