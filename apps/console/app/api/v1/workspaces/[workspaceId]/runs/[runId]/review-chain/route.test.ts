import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  getRun: vi.fn(),
  getRunQueueEntryIdentity: vi.fn(),
  getQueueEntryBriefReference: vi.fn(),
  getWorkspaceMembership: vi.fn(),
  listReviewEventsForPr: vi.fn(),
  listReviewJobsForPr: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import {
  getRun,
  getRunQueueEntryIdentity,
  getQueueEntryBriefReference,
  getWorkspaceMembership,
  listReviewEventsForPr,
  listReviewJobsForPr,
} from "@agentrail/db-postgres";
import { GET } from "./route";
import { resolveReviewChainPr } from "./review-chain";

const WORKSPACE_ID = "ws-123";
const RUN_ID = "run-123";
const USER_ID = "user-1";

const NOW = new Date("2026-08-04T10:00:00.000Z");

const RUN = {
  id: RUN_ID,
  workspaceId: WORKSPACE_ID,
  repositoryId: "repo-1",
  agent: "claude",
  branch: "main",
  title: "review chain",
  status: "failed",
  startedAt: NOW,
  finishedAt: NOW,
  createdAt: NOW,
  queueEntryId: "queue-entry-1",
  prUrl: "https://github.com/ada/widgets/pull/42",
};

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/runs/${RUN_ID}/review-chain`
  );
}

function makeParams() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID, runId: RUN_ID }) };
}

function mockMember() {
  vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    role: "owner",
  } as never);
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("resolveReviewChainPr", () => {
  it("returns resolved repo+number for a canonical GitHub PR URL", () => {
    expect(resolveReviewChainPr("https://github.com/ada/widgets/pull/42")).toEqual({
      state: "resolved",
      repo: "ada/widgets",
      number: 42,
    });
  });

  it("returns no_pr for an empty or missing PR URL", () => {
    expect(resolveReviewChainPr("")).toEqual({
      state: "no_pr",
      repo: null,
      number: null,
    });
    expect(resolveReviewChainPr(null)).toEqual({
      state: "no_pr",
      repo: null,
      number: null,
    });
  });

  it("returns unknown for a malformed or foreign PR URL instead of guessing", () => {
    expect(resolveReviewChainPr("https://example.com/ada/widgets/pull/42")).toEqual({
      state: "unknown",
      repo: null,
      number: null,
      reason: "malformed_pr_url",
    });
    expect(resolveReviewChainPr("https://github.com/ada/widgets/issues/42")).toEqual({
      state: "unknown",
      repo: null,
      number: null,
      reason: "malformed_pr_url",
    });
  });
});

describe("GET /api/v1/workspaces/:workspaceId/runs/:runId/review-chain", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(401);
    expect(getRun).not.toHaveBeenCalled();
  });

  it("returns 403 when the user is not a member of the workspace", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);

    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(403);
    expect(getRun).not.toHaveBeenCalled();
  });

  it("returns 404 when the run does not exist in the workspace", async () => {
    mockMember();
    vi.mocked(getRun).mockResolvedValue(null as never);

    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(404);
    expect(listReviewJobsForPr).not.toHaveBeenCalled();
    expect(listReviewEventsForPr).not.toHaveBeenCalled();
    expect(getQueueEntryBriefReference).not.toHaveBeenCalled();
  });

  it("returns the queue-entry identity and ordered review history for a resolved PR", async () => {
    mockMember();
    vi.mocked(getRun).mockResolvedValue(RUN as never);
    vi.mocked(getRunQueueEntryIdentity).mockResolvedValue({
      externalId: "ada/widgets#41",
    } as never);
    vi.mocked(getQueueEntryBriefReference).mockResolvedValue({
      alignmentBriefId: "brief-123",
    } as never);
    vi.mocked(listReviewJobsForPr).mockResolvedValue([
      {
        id: "job-1",
        workspaceId: WORKSPACE_ID,
        repo: "ada/widgets",
        prNumber: 42,
        headSha: "a".repeat(40),
        event: "opened",
        state: "queued",
        attempts: 0,
        claimedBy: null,
        claimedAt: null,
        nextEligibleAt: null,
        postedReviewUrl: null,
        verdict: null,
        skipReason: null,
        evidenceKeys: null,
        createdAt: new Date("2026-08-04T10:00:00.000Z"),
        updatedAt: new Date("2026-08-04T10:01:00.000Z"),
      },
    ] as never);
    vi.mocked(listReviewEventsForPr).mockResolvedValue([
      {
        id: "event-1",
        workspaceId: WORKSPACE_ID,
        repo: "ada/widgets",
        prNumber: 42,
        taskFamily: "dependency-upgrade",
        deliveryId: "delivery-1",
        eventType: "opened",
        occurredAt: new Date("2026-08-04T09:55:00.000Z"),
        headSha: "a".repeat(40),
        reviewState: null,
        actorType: null,
        additions: null,
        deletions: null,
        changedFiles: null,
        humanReviewMinutes: null,
        humanReviewSource: null,
        createdAt: new Date("2026-08-04T09:56:00.000Z"),
      },
    ] as never);

    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      run: {
        id: RUN_ID,
        workspaceId: WORKSPACE_ID,
        queueEntryId: "queue-entry-1",
        prUrl: "https://github.com/ada/widgets/pull/42",
      },
      alignmentBrief: { state: "linked", id: "brief-123" },
      prResolution: {
        state: "resolved",
        repo: "ada/widgets",
        number: 42,
      },
      reviewJobs: [
        {
          id: "job-1",
          workspaceId: WORKSPACE_ID,
          repo: "ada/widgets",
          prNumber: 42,
          headSha: "a".repeat(40),
          event: "opened",
          state: "queued",
          attempts: 0,
          claimedBy: null,
          claimedAt: null,
          nextEligibleAt: null,
          postedReviewUrl: null,
          verdict: null,
          skipReason: null,
          evidenceKeys: null,
          createdAt: "2026-08-04T10:00:00.000Z",
          updatedAt: "2026-08-04T10:01:00.000Z",
        },
      ],
      reviewEvents: [
        {
          id: "event-1",
          workspaceId: WORKSPACE_ID,
          repo: "ada/widgets",
          prNumber: 42,
          taskFamily: "dependency-upgrade",
          deliveryId: "delivery-1",
          eventType: "opened",
          occurredAt: "2026-08-04T09:55:00.000Z",
          headSha: "a".repeat(40),
          reviewState: null,
          actorType: null,
          additions: null,
          deletions: null,
          changedFiles: null,
          humanReviewMinutes: null,
          humanReviewSource: null,
          createdAt: "2026-08-04T09:56:00.000Z",
        },
      ],
    });
    expect(listReviewJobsForPr).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      repo: "ada/widgets",
      prNumber: 42,
    });
    expect(listReviewEventsForPr).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      repo: "ada/widgets",
      prNumber: 42,
    });
    expect(getQueueEntryBriefReference).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "queue-entry-1"
    );
  });

  it("returns unknown and does not query history when a valid PR URL belongs to another repository", async () => {
    mockMember();
    vi.mocked(getRun).mockResolvedValue(RUN as never);
    vi.mocked(getRunQueueEntryIdentity).mockResolvedValue({
      externalId: "trusted/repo#41",
    } as never);

    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.prResolution).toEqual({
      state: "unknown",
      repo: null,
      number: null,
      reason: "repository_mismatch",
    });
    expect(listReviewJobsForPr).not.toHaveBeenCalled();
    expect(listReviewEventsForPr).not.toHaveBeenCalled();
  });

  it("queries history when a valid PR URL matches the trusted queue repository", async () => {
    mockMember();
    vi.mocked(getRun).mockResolvedValue(RUN as never);
    vi.mocked(getRunQueueEntryIdentity).mockResolvedValue({
      externalId: "ada/widgets#41",
    } as never);

    const res = await GET(makeRequest(), makeParams());

    expect(res.status).toBe(200);
    expect(listReviewJobsForPr).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      repo: "ada/widgets",
      prNumber: 42,
    });
    expect(listReviewEventsForPr).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      repo: "ada/widgets",
      prNumber: 42,
    });
  });

  it("returns an explicit no_pr state and never guesses history when pr_url is empty", async () => {
    mockMember();
    vi.mocked(getRun).mockResolvedValue({ ...RUN, prUrl: "" } as never);
    vi.mocked(getQueueEntryBriefReference).mockResolvedValue({
      alignmentBriefId: null,
    } as never);

    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.prResolution).toEqual({ state: "no_pr", repo: null, number: null });
    expect(json.alignmentBrief).toEqual({ state: "unknown", id: null });
    expect(listReviewJobsForPr).not.toHaveBeenCalled();
    expect(listReviewEventsForPr).not.toHaveBeenCalled();
    expect(json.reviewJobs).toEqual([]);
    expect(json.reviewEvents).toEqual([]);
  });

  it("returns an explicit unknown state and never guesses history when pr_url is malformed", async () => {
    mockMember();
    vi.mocked(getRun).mockResolvedValue(
      { ...RUN, prUrl: "https://example.com/ada/widgets/pull/42" } as never
    );
    vi.mocked(getQueueEntryBriefReference).mockResolvedValue({
      alignmentBriefId: null,
    } as never);

    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.prResolution).toEqual({
      state: "unknown",
      repo: null,
      number: null,
      reason: "malformed_pr_url",
    });
    expect(listReviewJobsForPr).not.toHaveBeenCalled();
    expect(listReviewEventsForPr).not.toHaveBeenCalled();
  });

  it("returns explicit absence when the run has no queue-entry relation", async () => {
    mockMember();
    vi.mocked(getRun).mockResolvedValue({ ...RUN, queueEntryId: null } as never);

    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.alignmentBrief).toEqual({ state: "absent", id: null });
    expect(getQueueEntryBriefReference).not.toHaveBeenCalled();
  });

  it("keeps a missing queue row unknown rather than inventing an absent brief", async () => {
    mockMember();
    vi.mocked(getRun).mockResolvedValue(RUN as never);
    vi.mocked(getQueueEntryBriefReference).mockResolvedValue(null as never);

    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.alignmentBrief).toEqual({ state: "unknown", id: null });
  });

  it("returns 500 when the workspace-scoped brief lookup fails", async () => {
    mockMember();
    vi.mocked(getRun).mockResolvedValue(RUN as never);
    vi.mocked(getQueueEntryBriefReference).mockRejectedValue(new Error("db down"));

    const res = await GET(makeRequest(), makeParams());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to load review chain" });
    expect(listReviewJobsForPr).not.toHaveBeenCalled();
  });

  it("returns 500 with a stable error when the review-history query throws", async () => {
    mockMember();
    vi.mocked(getRun).mockResolvedValue(RUN as never);
    vi.mocked(getRunQueueEntryIdentity).mockResolvedValue({
      externalId: "ada/widgets#41",
    } as never);
    vi.mocked(listReviewJobsForPr).mockRejectedValue(new Error("db down"));

    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to load review chain" });
  });
});
