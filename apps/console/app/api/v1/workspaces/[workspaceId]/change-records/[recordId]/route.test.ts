import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  readCurrentAcceptanceCorrectionPackets: vi.fn(),
  readChangeRecordTimeline: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  readCurrentAcceptanceCorrectionPackets,
  readChangeRecordTimeline,
} from "@agentrail/db-postgres";
import { GET } from "./route";

const WS = "00000000-0000-4000-8000-000000000001";
const OTHER_WS = "00000000-0000-4000-8000-000000000002";
const RECORD = "00000000-0000-4000-8000-000000000111";
const USER = "user-1";
const HEAD = "f".repeat(40);
const PRIOR_HEAD = "d".repeat(40);
const CYCLE = "00000000-0000-4000-8000-000000000099";
const CONTRACT = "00000000-0000-4000-8000-000000000088";
const PACKET_ID = `correction-${"c".repeat(48)}`;
const CREATED = new Date("2026-08-03T12:00:00.000Z");
const UPDATED = new Date("2026-08-03T12:05:00.000Z");
const REVIEW_AT = new Date("2026-08-03T12:04:00.000Z");

const currentCorrectionPackets = {
  kind: "current" as const,
  binding: {
    workspaceId: WS,
    recordId: RECORD,
    reviewJobId: CYCLE,
    repo: "ada/widgets",
    prNumber: 98,
    headSha: HEAD,
    headCycleId: CYCLE,
    authorityGeneration: 1,
    acceptanceContract: {
      id: CONTRACT,
      version: 1,
      sha256: "a".repeat(64),
    },
  },
  packetIds: [PACKET_ID],
  packetSetSha256: "b".repeat(64),
  correctionPacketPayloadSetSha256: "c".repeat(64),
  packets: [{
    kind: "review_job_correction_packet",
    version: 1,
    packetId: PACKET_ID,
    workspaceId: WS,
    repo: "ada/widgets",
    prNumber: 98,
    headSha: HEAD,
    recordId: RECORD,
    jobId: CYCLE,
    acceptanceContract: { id: CONTRACT, version: 1 },
    criterion: { id: "criterion-1", snapshot: "The saved page is visible." },
    basis: "acceptance_contract",
    state: "failed",
    expected: "The saved page is visible.",
    observed: "The page returned an error.",
    affectedContext: {
      modality: "ui",
      environmentKind: "isolated_preview",
      flow: "saved-page",
      reproduction: { modality: "ui", steps: [{ action: "open", path: "/saved" }] },
    },
    evidence: { evidenceRef: "criterion:criterion-1:ui-result", previewBootId: "boot-1" },
    scopeBoundary: "Only criterion-1 at the exact PR head.",
    impact: "The saved page cannot be viewed.",
    requiredCorrection: "Make the saved page visible.",
    reverification: "Rerun criterion-1 against the next exact head.",
  }],
};

function req(workspaceId = WS, recordId = RECORD): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${workspaceId}/change-records/${recordId}`,
    { method: "GET" }
  );
}

function params(workspaceId = WS, recordId = RECORD) {
  return Promise.resolve({ workspaceId, recordId });
}

const timeline = {
  record: {
    id: RECORD,
    workspaceId: WS,
    repo: "ada/widgets",
    issueNumber: 42,
    prNumber: 98,
    headShas: [PRIOR_HEAD, HEAD],
    currentPrHeadSha: HEAD,
    currentPrHeadCycleId: CYCLE,
    currentPrHeadAuthoritative: true,
    currentPrHeadAuthorityGeneration: 1,
    mergedSha: null,
    state: "open",
    createdAt: CREATED,
    updatedAt: UPDATED,
  },
  events: [
    {
      id: "event-1",
      recordId: RECORD,
      eventKey: "issue:intake:42",
      stage: "requirement",
      at: CREATED,
      actor: "jace",
      payloadRef: { kind: "issue_snapshot", issueNumber: 42 },
      createdAt: CREATED,
    },
    {
      id: "event-2",
      recordId: RECORD,
      eventKey: "review:posted:deadbeef",
      stage: "review",
      at: REVIEW_AT,
      actor: "reviewer-of-record",
      payloadRef: { kind: "review_job", jobId: "job-1" },
      createdAt: REVIEW_AT,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1", role: "member" } as never);
  vi.mocked(readChangeRecordTimeline).mockResolvedValue(timeline as never);
  vi.mocked(readCurrentAcceptanceCorrectionPackets).mockResolvedValue(currentCorrectionPackets as never);
});

describe("GET /api/v1/workspaces/[workspaceId]/change-records/[recordId]", () => {
  it("401 when not authenticated, before any workspace or record lookup", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(401);
    expect(getWorkspaceMembership).not.toHaveBeenCalled();
    expect(readChangeRecordTimeline).not.toHaveBeenCalled();
    expect(readCurrentAcceptanceCorrectionPackets).not.toHaveBeenCalled();
  });

  it("403 when the user is not a workspace member, before reading the timeline", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(403);
    expect(getWorkspaceMembership).toHaveBeenCalledWith(USER, WS);
    expect(readChangeRecordTimeline).not.toHaveBeenCalled();
    expect(readCurrentAcceptanceCorrectionPackets).not.toHaveBeenCalled();
  });

  it("404 when no change record exists in the caller workspace", async () => {
    vi.mocked(readChangeRecordTimeline).mockResolvedValue(null as never);

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(404);
    expect(readChangeRecordTimeline).toHaveBeenCalledWith({
      workspaceId: WS,
      recordId: RECORD,
    });
    expect(readCurrentAcceptanceCorrectionPackets).not.toHaveBeenCalled();
  });

  it("keeps cross-tenant isolation by passing the path workspace to the scoped query", async () => {
    vi.mocked(readChangeRecordTimeline).mockResolvedValue(null as never);

    const res = await GET(req(OTHER_WS, RECORD), {
      params: params(OTHER_WS, RECORD),
    });

    expect(res.status).toBe(404);
    expect(getWorkspaceMembership).toHaveBeenCalledWith(USER, OTHER_WS);
    expect(readChangeRecordTimeline).toHaveBeenCalledWith({
      workspaceId: OTHER_WS,
      recordId: RECORD,
    });
    expect(readCurrentAcceptanceCorrectionPackets).not.toHaveBeenCalled();
  });

  it("200 with deterministic record and ordered timeline event shape", async () => {
    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      record: {
        id: RECORD,
        workspaceId: WS,
        repo: "ada/widgets",
        issueNumber: 42,
        prNumber: 98,
        headShas: [PRIOR_HEAD, HEAD],
        currentPrHeadSha: HEAD,
        currentPrHeadCycleId: CYCLE,
        currentPrHeadAuthoritative: true,
        mergedSha: null,
        state: "open",
        createdAt: "2026-08-03T12:00:00.000Z",
        updatedAt: "2026-08-03T12:05:00.000Z",
      },
      events: [
        {
          id: "event-1",
          recordId: RECORD,
          eventKey: "issue:intake:42",
          stage: "requirement",
          actor: "jace",
          payloadRef: { kind: "issue_snapshot", issueNumber: 42 },
          at: "2026-08-03T12:00:00.000Z",
          createdAt: "2026-08-03T12:00:00.000Z",
        },
        {
          id: "event-2",
          recordId: RECORD,
          eventKey: "review:posted:deadbeef",
          stage: "review",
          actor: "reviewer-of-record",
          payloadRef: { kind: "review_job", jobId: "job-1" },
          at: "2026-08-03T12:04:00.000Z",
          createdAt: "2026-08-03T12:04:00.000Z",
        },
      ],
      correctionPackets: currentCorrectionPackets,
    });
    expect(readCurrentAcceptanceCorrectionPackets).toHaveBeenCalledWith({
      workspaceId: WS,
      recordId: RECORD,
    });
  });

  it("downgrades a current packet set when the separately read Record head cycle changed", async () => {
    const nextHead = "e".repeat(40);
    const nextCycle = "00000000-0000-4000-8000-000000000100";
    const nextPacketId = `correction-${"e".repeat(48)}`;
    vi.mocked(readCurrentAcceptanceCorrectionPackets).mockResolvedValue({
      ...currentCorrectionPackets,
      binding: {
        ...currentCorrectionPackets.binding,
        reviewJobId: nextCycle,
        headSha: nextHead,
        headCycleId: nextCycle,
        authorityGeneration: 2,
      },
      packetIds: [nextPacketId],
      packets: [{
        ...currentCorrectionPackets.packets[0],
        packetId: nextPacketId,
        headSha: nextHead,
        jobId: nextCycle,
      }],
    } as never);

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(200);
    expect((await res.json()).correctionPackets).toEqual({ kind: "not_current" });
  });

  it("returns invalid packet custody as a closed not-ready envelope", async () => {
    vi.mocked(readCurrentAcceptanceCorrectionPackets).mockResolvedValue({
      kind: "not_ready",
      reason: "invalid_packet_custody",
    });

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(200);
    expect((await res.json()).correctionPackets).toEqual({
      kind: "not_ready",
      reason: "invalid_packet_custody",
    });
  });

  it("500 when storage fails", async () => {
    vi.mocked(readChangeRecordTimeline).mockRejectedValue(new Error("db down"));

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Failed to load change record detail",
    });
    expect(readCurrentAcceptanceCorrectionPackets).not.toHaveBeenCalled();
  });

  it("500 when current correction packet storage fails", async () => {
    vi.mocked(readCurrentAcceptanceCorrectionPackets).mockRejectedValue(new Error("db down"));

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Failed to load change record detail",
    });
  });
});
