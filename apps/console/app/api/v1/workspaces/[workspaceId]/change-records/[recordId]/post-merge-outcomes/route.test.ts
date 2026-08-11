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

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const RECORD_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-08-08T12:00:00.000Z");
const MERGE_SHA = "a".repeat(40);

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
  kind: "deployed",
  revisionSha: MERGE_SHA,
  environment: "production",
  deploymentReference: "deploy-2026-08-08-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "membership-1", role: "owner" } as never);
  vi.mocked(validateAcceptancePostMergeOutcome).mockReturnValue(true);
  vi.mocked(recordAcceptancePostMergeOutcome).mockResolvedValue({
    inserted: true,
    event: {
      id: "event-1", recordId: RECORD_ID,
      eventKey: `acceptance-post-merge:deployed:${outcome.deploymentReference}`,
      stage: "post_merge_outcome", actor: `user:${USER_ID}`,
      at: NOW, payloadRef: { kind: "acceptance_post_merge_outcome", outcome }, createdAt: NOW,
    },
  } as never);
});

describe("POST /api/v1/workspaces/[workspaceId]/change-records/[recordId]/post-merge-outcomes", () => {
  it("requires an authenticated workspace owner or admin", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    expect((await POST(request({ outcome }), { params: params() })).status).toBe(401);
    expect(getWorkspaceMembership).not.toHaveBeenCalled();

    vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "membership-1", role: "member" } as never);
    expect((await POST(request({ outcome }), { params: params() })).status).toBe(403);
    expect(recordAcceptancePostMergeOutcome).not.toHaveBeenCalled();
  });

  it("rejects an invalid outcome before recording any timeline event", async () => {
    vi.mocked(validateAcceptancePostMergeOutcome).mockReturnValue(false);

    const response = await POST(request({ outcome: { kind: "unknown" } }), { params: params() });

    expect(response.status).toBe(400);
    expect(recordAcceptancePostMergeOutcome).not.toHaveBeenCalled();
  });

  it("rejects a caller-supplied merged outcome even when the generic validator accepts it", async () => {
    vi.mocked(validateAcceptancePostMergeOutcome).mockReturnValue(true);
    const legacyMergedOutcome = {
      kind: "merged",
      prNumber: 12,
      baseSha: "c".repeat(40),
      headSha: "b".repeat(40),
      mergeSha: MERGE_SHA,
      mergeReference: "https://github.com/acme/widgets/pull/12",
    };

    const response = await POST(request({ outcome: legacyMergedOutcome }), { params: params() });

    expect(response.status).toBe(400);
    expect(recordAcceptancePostMergeOutcome).not.toHaveBeenCalled();
  });

  it("records an immutable outcome through the scoped query and reports insertion", async () => {
    const response = await POST(request({ outcome }), { params: params() });

    expect(response.status).toBe(201);
    expect(recordAcceptancePostMergeOutcome).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      recordId: RECORD_ID,
      recordedBy: `user:${USER_ID}`,
      outcome,
    });
    await expect(response.json()).resolves.toEqual({
      inserted: true,
      event: {
        id: "event-1",
        eventKey: `acceptance-post-merge:deployed:${outcome.deploymentReference}`,
        stage: "post_merge_outcome",
        at: NOW.toISOString(),
        payloadRef: { kind: "acceptance_post_merge_outcome", outcome },
      },
    });
  });

  it.each([
    {
      kind: "incident",
      revisionSha: MERGE_SHA,
      incidentReference: "incident-2026-08-11-1",
    },
    {
      kind: "reverted",
      revertedSha: MERGE_SHA,
      revertSha: "d".repeat(40),
      revertReference: "revert-2026-08-11-1",
    },
  ] as const)("retains the $kind outcome for DB-enforced signed-merge lineage", async (retained) => {
    const response = await POST(request({ outcome: retained }), { params: params() });

    expect(response.status).toBe(201);
    expect(recordAcceptancePostMergeOutcome).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      recordId: RECORD_ID,
      recordedBy: `user:${USER_ID}`,
      outcome: retained,
    });
  });

  it("reports an idempotent replay without claiming a second append", async () => {
    vi.mocked(recordAcceptancePostMergeOutcome).mockResolvedValue({
      inserted: false,
      event: {
        id: "event-1", recordId: RECORD_ID,
        eventKey: `acceptance-post-merge:deployed:${outcome.deploymentReference}`,
        stage: "post_merge_outcome", actor: `user:${USER_ID}`, at: NOW,
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
