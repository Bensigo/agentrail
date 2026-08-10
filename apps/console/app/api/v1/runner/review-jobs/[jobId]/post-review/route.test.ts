import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  appendChangeRecordEvent: vi.fn(),
  getInstallationToken: vi.fn(),
  getJaceSessionByEveSessionId: vi.fn(),
  getPreviewBoot: vi.fn(),
  getRepositoryByName: vi.fn(),
  getReviewJobById: vi.fn(),
  readAcceptanceContracts: vi.fn(),
  readChangeRecordTimelineByPr: vi.fn(),
}));
vi.mock("../../../../../../../lib/github-advisory-review", () => ({
  postGithubAdvisoryReview: vi.fn(),
}));

import {
  appendChangeRecordEvent,
  getInstallationToken,
  getJaceSessionByEveSessionId,
  getPreviewBoot,
  getRepositoryByName,
  getReviewJobById,
  readAcceptanceContracts,
  readChangeRecordTimelineByPr,
} from "@agentrail/db-postgres";
import { postGithubAdvisoryReview } from "../../../../../../../lib/github-advisory-review";
import {
  R7_READY_NOT_PROVEN_OBSERVATION,
  r7UnavailablePreviewObservation,
} from "../../../../../../../lib/review-job-proof-attestation";
import { POST } from "./route";

const secret = "test-secret";
const jobId = "job-1";
const workspaceId = "00000000-0000-0000-0000-000000000001";
const recordId = "00000000-0000-0000-0000-000000000002";
const headSha = "abcdef1234567890";
const bootLogKey = "review-evidence/ws-1/ada__widgets/98/abcdef/boot.log";

const session = {
  id: "session-1",
  eveSessionId: "eve-session-1",
  workspaceId,
  chatIdentityId: null,
  channel: "review-job",
  conversationKey: `review-job:${jobId}`,
  status: "active",
};
const job = {
  id: jobId,
  workspaceId,
  repo: "ada/widgets",
  prNumber: 98,
  headSha,
  state: "running",
};
const contract = {
  id: "contract-1",
  version: 3,
  status: "confirmed",
  contract: {
    acceptanceCriteria: [
      {
        id: "AC-1",
        text: "The saved value remains visible after reload.",
        userVisible: true,
      },
    ],
  },
};
const planPayload = {
  kind: "review_job_verification_plan",
  jobId,
  workspaceId,
  repo: job.repo,
  prNumber: job.prNumber,
  headSha,
  recordId,
  acceptanceContractId: contract.id,
  acceptanceContractVersion: contract.version,
  plannedBy: "jace:review-job-worker",
  plans: [
    {
      criterionId: "AC-1",
      criterionTextSnapshot: "The saved value remains visible after reload.",
      modality: "ui",
      environmentKind: "isolated_preview",
      flow: "Save a value, reload, and observe the saved row.",
      status: "planned",
      notTestableReason: null,
    },
  ],
};

let timeline: {
  record: {
    id: string;
    workspaceId: string;
    repo: string;
    prNumber: number;
    headShas: string[];
  };
  events: Array<{ eventKey: string; payloadRef: Record<string, unknown> }>;
};

const criterionResults = [
  {
    criterionId: "AC-1",
    state: "not_proven",
    expected: "The saved value remains visible after reload.",
    observed: R7_READY_NOT_PROVEN_OBSERVATION,
    evidenceRefs: ["preview-boot:boot-1"],
  },
];
const validBody = {
  eveSessionId: "eve-session-1",
  summary: "The exact-head environment was available; behavior remains unproven.",
  comments: [
    { path: "src/widget.ts", line: 12, body: "This guard is required." },
  ],
  criterionResults,
  verdict: "not_proven",
  summaryLine: "ada/widgets #98 — not_proven",
  evidenceKeys: [bootLogKey],
};

function request(body: unknown = validBody, authorized = true) {
  return new NextRequest(
    `http://localhost/api/v1/runner/review-jobs/${jobId}/post-review`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorized ? { Authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify(body),
    }
  );
}

const params = { params: Promise.resolve({ jobId }) };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JACE_CONSOLE_TOKEN = secret;
  timeline = {
    record: {
      id: recordId,
      workspaceId,
      repo: job.repo,
      prNumber: job.prNumber,
      headShas: [headSha],
    },
    events: [{ eventKey: `verification:plan:${jobId}`, payloadRef: planPayload }],
  };
  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(session as never);
  vi.mocked(getReviewJobById).mockResolvedValue(job as never);
  vi.mocked(readChangeRecordTimelineByPr).mockImplementation(async () => timeline as never);
  vi.mocked(readAcceptanceContracts).mockResolvedValue([contract] as never);
  vi.mocked(getPreviewBoot).mockResolvedValue({
    id: "boot-1",
    workspaceId,
    repo: job.repo,
    prNumber: job.prNumber,
    headSha,
    status: "ready",
    url: "http://127.0.0.1:43123",
    bootLogKey,
  } as never);
  vi.mocked(getRepositoryByName).mockResolvedValue({ name: job.repo } as never);
  vi.mocked(getInstallationToken).mockResolvedValue("ghs-token");
  vi.mocked(appendChangeRecordEvent).mockImplementation(async (input) => ({
    inserted: true,
    event: { eventKey: input.eventKey, payloadRef: input.payloadRef },
  }) as never);
  vi.mocked(postGithubAdvisoryReview).mockResolvedValue({
    ok: true,
    reviewUrl: "https://github.com/ada/widgets/pull/98#pullrequestreview-1",
    summary: "The exact-head behavior passed.",
    inlineCommentsPosted: 1,
    foldedComments: [],
  });
});

describe("POST /api/v1/runner/review-jobs/[jobId]/post-review", () => {
  it("authenticates before resolving a session or touching GitHub", async () => {
    const response = await POST(request(validBody, false), params);
    expect(response.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("accepts no caller-authored repo, PR, head, workspace, or other extra field", async () => {
    for (const extra of [
      { repo: "evil/repo" },
      { prNumber: 7 },
      { headSha: "deadbeef" },
      { workspaceId: "foreign" },
      { event: "APPROVE" },
    ]) {
      const response = await POST(request({ ...validBody, ...extra }), params);
      expect(response.status).toBe(400);
    }
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("rejects an unbound or inactive session before looking up the job", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
      ...session,
      conversationKey: "review-job:other",
    } as never);
    const response = await POST(request(), params);
    expect(response.status).toBe(409);
    expect(getReviewJobById).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("invalid or foreign preview evidence never reserves or calls GitHub", async () => {
    vi.mocked(getPreviewBoot).mockResolvedValue({
      id: "boot-1",
      workspaceId: "foreign-workspace",
      repo: job.repo,
      prNumber: job.prNumber,
      headSha,
      status: "ready",
      url: "http://127.0.0.1:43123",
    } as never);
    const response = await POST(request(), params);
    expect(response.status).toBe(409);
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("reserves the exact outcome before one COMMENT-only GitHub helper call, then records the posted receipt", async () => {
    const response = await POST(request(), params);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      posted: true,
      replayed: false,
      reviewUrl: "https://github.com/ada/widgets/pull/98#pullrequestreview-1",
    });

    expect(getRepositoryByName).toHaveBeenCalledWith(workspaceId, job.repo);
    expect(postGithubAdvisoryReview).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: job.repo,
        prNumber: job.prNumber,
        headSha,
        token: "ghs-token",
        comments: validBody.comments,
        summary: expect.stringContaining(`agentrail-review-job:${jobId}:`),
      })
    );
    expect(
      vi.mocked(postGithubAdvisoryReview).mock.calls[0][0].summary
    ).toMatch(/^\*\*AgentRail exact-head verification: not_proven\.\*\*/);
    expect(appendChangeRecordEvent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(appendChangeRecordEvent).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(postGithubAdvisoryReview).mock.invocationCallOrder[0]
    );
    expect(vi.mocked(postGithubAdvisoryReview).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(appendChangeRecordEvent).mock.invocationCallOrder[1]
    );
    expect(appendChangeRecordEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        recordId,
        eventKey: `review:github-attempt:${jobId}`,
        payloadRef: expect.objectContaining({
          jobId,
          repo: job.repo,
          prNumber: job.prNumber,
          headSha,
          acceptanceContractVersion: contract.version,
        }),
      })
    );
    expect(appendChangeRecordEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        recordId,
        eventKey: `review:github-posted:${jobId}`,
        payloadRef: expect.objectContaining({
          kind: "review_job_github_posted",
          postedReviewUrl: "https://github.com/ada/widgets/pull/98#pullrequestreview-1",
        }),
      })
    );
  });

  it("an existing attempt with no posted receipt holds instead of issuing a duplicate GitHub write", async () => {
    timeline.events.push({
      eventKey: `review:github-attempt:${jobId}`,
      payloadRef: { kind: "unknown-or-conflicting-attempt" },
    });
    const response = await POST(request(), params);
    expect(response.status).toBe(409);
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("replays an exact stored posted receipt without a second reservation or GitHub write", async () => {
    const first = await POST(request(), params);
    expect(first.status).toBe(201);
    const postedCall = vi.mocked(appendChangeRecordEvent).mock.calls[1][0];
    timeline.events.push({
      eventKey: postedCall.eventKey,
      payloadRef: postedCall.payloadRef,
    });
    vi.mocked(appendChangeRecordEvent).mockClear();
    vi.mocked(postGithubAdvisoryReview).mockClear();

    const replay = await POST(request(), params);

    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      posted: true,
      replayed: true,
      reviewUrl: "https://github.com/ada/widgets/pull/98#pullrequestreview-1",
    });
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("a GitHub failure leaves only the durable attempt reservation and never records a false posted receipt", async () => {
    vi.mocked(postGithubAdvisoryReview).mockResolvedValue({
      ok: false,
      status: 502,
      error: "Could not reach GitHub.",
    });
    const response = await POST(request(), params);
    expect(response.status).toBe(502);
    expect(appendChangeRecordEvent).toHaveBeenCalledTimes(1);
    expect(appendChangeRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventKey: `review:github-attempt:${jobId}` })
    );
  });

  it("rejects proof claims and extra artifact references until R7.2 custody exists", async () => {
    for (const criterionResult of [
      { ...criterionResults[0], state: "proven", observed: "It passed." },
      { ...criterionResults[0], state: "failed", observed: "It failed." },
      {
        ...criterionResults[0],
        evidenceRefs: ["preview-boot:boot-1", "artifact://fabricated"],
      },
    ]) {
      const response = await POST(
        request({ ...validBody, criterionResults: [criterionResult] }),
        params
      );
      expect(response.status).toBe(409);
    }
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("accepts a server-custodied before-ready boot failure only as not_testable", async () => {
    const reason = "preview command exited 1";
    vi.mocked(getPreviewBoot).mockResolvedValue({
      id: "boot-1",
      workspaceId,
      repo: job.repo,
      prNumber: job.prNumber,
      headSha,
      status: "failed",
      url: null,
      reason,
      bootLogKey,
    } as never);
    const result = {
      ...criterionResults[0],
      state: "not_testable",
      observed: r7UnavailablePreviewObservation({ status: "failed", reason }),
    };

    const response = await POST(
      request({
        ...validBody,
        criterionResults: [result],
        verdict: "not_testable",
        summaryLine: "ada/widgets #98 — not_testable",
      }),
      params
    );

    expect(response.status).toBe(201);
    expect(postGithubAdvisoryReview).toHaveBeenCalledTimes(1);
  });

  it("holds in-flight, failed-after-ready, and reasonless terminal boots", async () => {
    for (const boot of [
      { status: "pending", url: null, reason: null },
      { status: "ready", url: null, reason: null },
      { status: "failed", url: "http://127.0.0.1:43123", reason: "stale" },
      { status: "failed", url: null, reason: "   " },
      { status: "failed", url: null, reason: "line one\nline two" },
      { status: "failed", url: null, reason: "x".repeat(2001) },
      { status: "torn_down", url: null, reason: null },
    ]) {
      vi.mocked(getPreviewBoot).mockResolvedValueOnce({
        id: "boot-1",
        workspaceId,
        repo: job.repo,
        prNumber: job.prNumber,
        headSha,
        bootLogKey,
        ...boot,
      } as never);
      const response = await POST(request(), params);
      expect(response.status).toBe(409);
    }
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });

  it("rejects evidenceKeys that are not custodied on the exact boot row", async () => {
    const response = await POST(
      request({ ...validBody, evidenceKeys: ["review-evidence/fabricated.png"] }),
      params
    );

    expect(response.status).toBe(409);
    expect(appendChangeRecordEvent).not.toHaveBeenCalled();
    expect(postGithubAdvisoryReview).not.toHaveBeenCalled();
  });
});
