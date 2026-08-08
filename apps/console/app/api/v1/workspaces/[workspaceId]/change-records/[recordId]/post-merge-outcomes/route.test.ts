import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  recordAcceptancePostMergeOutcome: vi.fn(),
  validateAcceptancePostMergeOutcome: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  recordAcceptancePostMergeOutcome,
  validateAcceptancePostMergeOutcome,
} from "@agentrail/db-postgres";
import { POST } from "./route";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
const RECORD_ID = "00000000-0000-0000-0000-000000000002";
const NOW = new Date("2026-08-08T12:00:00.000Z");
const MERGE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

function params() {
  return Promise.resolve({ workspaceId: WORKSPACE_ID, recordId: RECORD_ID });
}

function request(body: unknown) {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/change-records/${RECORD_ID}/post-merge-outcomes`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
}

const outcome = {
  kind: "merged",
  prNumber: 12,
  headSha: HEAD_SHA,
  mergeSha: MERGE_SHA,
  mergeReference: "https://github.com/acme/widgets/pull/12",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "membership-1", role: "owner" } as never);
  vi.mocked(validateAcceptancePostMergeOutcome).mockReturnValue(true);
  vi.mocked(recordAcceptancePostMergeOutcome).mockResolvedValue({
    inserted: true,
    event: {
      id: "event-1", recordId: RECORD_ID,
      eventKey: `acceptance-post-merge:merged:${MERGE_SHA}`,
      stage: "post_merge_outcome", actor: "user:user-1",
      at: NOW, payloadRef: { kind: "acceptance_post_merge_outcome", outcome }, createdAt: NOW,
    },
  } as never);
});

describe("POST /api/v1/workspaces/[workspaceId]/change-records/[recordId]/post-merge-outcomes", () => {
  it("requires an authenticated workspace owner or admin", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    expect((await POST(request({ outcome }), { params: params() })).status).toBe(401);
    expect(getWorkspaceMembership).not.toHaveBeenCalled();

    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "membership-1", role: "member" } as never);
    expect((await POST(request({ outcome }), { params: params() })).status).toBe(403);
    expect(recordAcceptancePostMergeOutcome).not.toHaveBeenCalled();
  });

  it("rejects an invalid outcome before recording any timeline event", async () => {
    vi.mocked(validateAcceptancePostMergeOutcome).mockReturnValue(false);

    const response = await POST(request({ outcome: { kind: "merged" } }), { params: params() });

    expect(response.status).toBe(400);
    expect(recordAcceptancePostMergeOutcome).not.toHaveBeenCalled();
  });

  it("records an immutable outcome through the scoped query and reports insertion", async () => {
    const response = await POST(request({ outcome }), { params: params() });

    expect(response.status).toBe(201);
    expect(recordAcceptancePostMergeOutcome).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      recordId: RECORD_ID,
      recordedBy: "user:user-1",
      outcome,
    });
    await expect(response.json()).resolves.toEqual({
      inserted: true,
      event: {
        id: "event-1",
        eventKey: `acceptance-post-merge:merged:${MERGE_SHA}`,
        stage: "post_merge_outcome",
        at: NOW.toISOString(),
        payloadRef: { kind: "acceptance_post_merge_outcome", outcome },
      },
    });
  });

  it("reports an idempotent replay without claiming a second append", async () => {
    vi.mocked(recordAcceptancePostMergeOutcome).mockResolvedValue({
      inserted: false,
      event: {
        id: "event-1", recordId: RECORD_ID, eventKey: `acceptance-post-merge:merged:${MERGE_SHA}`,
        stage: "post_merge_outcome", actor: "user:user-1", at: NOW,
        payloadRef: { kind: "acceptance_post_merge_outcome", outcome }, createdAt: NOW,
      },
    } as never);

    const response = await POST(request({ outcome }), { params: params() });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ inserted: false });
  });

  it("does not convert a lineage conflict into a successful outcome", async () => {
    vi.mocked(recordAcceptancePostMergeOutcome).mockRejectedValue(new Error("wrong merge SHA"));

    const response = await POST(request({ outcome }), { params: params() });

    expect(response.status).toBe(409);
  });
});
