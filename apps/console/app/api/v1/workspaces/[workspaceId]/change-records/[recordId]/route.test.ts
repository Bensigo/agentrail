import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  AcceptancePrDecisionConflictError: class AcceptancePrDecisionConflictError extends Error {},
  AcceptancePrReviewEffortConflictError: class AcceptancePrReviewEffortConflictError extends Error {},
  getWorkspaceMembership: vi.fn(),
  readAcceptancePrReviewMetrics: vi.fn(),
  readCurrentAcceptancePrDecision: vi.fn(),
  readCurrentAcceptanceCorrectionPackets: vi.fn(),
  readChangeRecordTimeline: vi.fn(),
  recordAcceptancePrDecision: vi.fn(),
  recordAcceptancePrReviewEffort: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import {
  AcceptancePrDecisionConflictError,
  AcceptancePrReviewEffortConflictError,
  getWorkspaceMembership,
  readAcceptancePrReviewMetrics,
  readCurrentAcceptancePrDecision,
  readCurrentAcceptanceCorrectionPackets,
  readChangeRecordTimeline,
  recordAcceptancePrDecision,
  recordAcceptancePrReviewEffort,
} from "@agentrail/db-postgres";
import { GET, PATCH } from "./route";

const WS = "00000000-0000-4000-8000-000000000001";
const OTHER_WS = "00000000-0000-4000-8000-000000000002";
const RECORD = "00000000-0000-4000-8000-000000000111";
const USER = "00000000-0000-4000-8000-000000000777";
const HEAD = "f".repeat(40);
const PRIOR_HEAD = "d".repeat(40);
const CYCLE = "00000000-0000-4000-8000-000000000099";
const CONTRACT = "00000000-0000-4000-8000-000000000088";
const PACKET_ID = `correction-${"c".repeat(48)}`;
const CREATED = new Date("2026-08-03T12:00:00.000Z");
const UPDATED = new Date("2026-08-03T12:05:00.000Z");
const REVIEW_AT = new Date("2026-08-03T12:04:00.000Z");
const DECIDED_AT = new Date("2026-08-03T12:06:00.000Z");
const DECISION_EVENT_ID = "00000000-0000-4000-8000-000000000077";
const POSTED_ATTESTATION_EVENT_ID = "00000000-0000-4000-8000-000000000066";
const DECISION_BINDING_ID = "00000000-0000-4000-8000-000000000055";
const EFFORT_EVENT_ID = "00000000-0000-4000-8000-000000000054";
const EFFORT_AT = new Date("2026-08-03T12:07:00.000Z");

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

const currentFinalDecision = {
  kind: "current" as const,
  binding: {
    bindingId: DECISION_BINDING_ID,
    workspaceId: WS,
    recordId: RECORD,
    repo: "ada/widgets",
    prNumber: 98,
    headSha: HEAD,
    headCycleId: CYCLE,
    authorityGeneration: 1,
    reviewJobId: CYCLE,
    reviewVerdict: "failed" as const,
    postedReviewUrl: "https://github.com/ada/widgets/pull/98#pullrequestreview-5",
    postedAttestationEventId: POSTED_ATTESTATION_EVENT_ID,
    acceptanceContract: {
      id: CONTRACT,
      version: 1,
      sha256: "a".repeat(64),
    },
  },
  decision: null,
};

const currentReviewMetrics = {
  kind: "record" as const,
  workspaceId: WS,
  recordId: RECORD,
  repo: "ada/widgets",
  prNumber: 98,
  currentCycle: {
    headSha: HEAD,
    headCycleId: CYCLE,
    authorityGeneration: 1,
  },
  cycles: [{
    binding: {
      workspaceId: WS,
      recordId: RECORD,
      repo: "ada/widgets",
      prNumber: 98,
      headSha: HEAD,
      headCycleId: CYCLE,
      reviewJobId: CYCLE,
      reviewVerdict: "failed" as const,
      postedReviewUrl: "https://github.com/ada/widgets/pull/98#pullrequestreview-5",
      postedAttestationEventId: POSTED_ATTESTATION_EVENT_ID,
      acceptanceContract: { id: CONTRACT, version: 1, sha256: "a".repeat(64) },
    },
    current: true,
    reviewedAt: REVIEW_AT,
    effort: { kind: "unknown" as const },
    decision: { kind: "unknown" as const },
    signedMerge: { kind: "unknown" as const },
    postMergeOutcomes: { kind: "unknown" as const },
  }],
  summary: {
    reviewEffort: {
      eligible: 1,
      known: 0,
      unknown: 1,
      totalMinutes: null,
      averageMinutes: null,
    },
    decisions: { eligible: 1, known: 0, unknown: 1 },
    signedMerges: { eligible: 1, known: 0, unknown: 1 },
    postMergeOutcomes: { eligible: 0, known: 0, unknown: 0 },
  },
};

function req(workspaceId = WS, recordId = RECORD): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${workspaceId}/change-records/${recordId}`,
    { method: "GET" }
  );
}

function patchReq(
  body: unknown,
  options: { contentType?: string; contentLength?: string } = {},
): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/change-records/${RECORD}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": options.contentType ?? "application/json",
        ...(options.contentLength ? { "Content-Length": options.contentLength } : {}),
      },
      body: JSON.stringify(body),
    },
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
  vi.mocked(readCurrentAcceptancePrDecision).mockResolvedValue(currentFinalDecision as never);
  vi.mocked(readAcceptancePrReviewMetrics).mockResolvedValue(currentReviewMetrics as never);
  vi.mocked(recordAcceptancePrDecision).mockResolvedValue({
    kind: "recorded",
    binding: currentFinalDecision.binding,
    decision: {
      eventId: DECISION_EVENT_ID,
      eventKey: `acceptance-pr-decision:${CYCLE}`,
      decision: "changes_requested",
      rationale: "The failed criterion must be repaired.",
      decidedBy: `user:${USER}`,
      decidedRole: "owner",
      decidedAt: DECIDED_AT,
    },
  } as never);
  vi.mocked(recordAcceptancePrReviewEffort).mockResolvedValue({
    kind: "recorded",
    binding: currentFinalDecision.binding,
    effort: {
      eventId: EFFORT_EVENT_ID,
      eventKey: `acceptance-pr-review-effort:${CYCLE}`,
      minutes: 37,
      source: "human_input",
      recordedBy: `user:${USER}`,
      recordedRole: "owner",
      recordedAt: EFFORT_AT,
    },
  } as never);
});

describe("GET /api/v1/workspaces/[workspaceId]/change-records/[recordId]", () => {
  it("401 when not authenticated, before any workspace or record lookup", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(401);
    expect(getWorkspaceMembership).not.toHaveBeenCalled();
    expect(readChangeRecordTimeline).not.toHaveBeenCalled();
    expect(readCurrentAcceptanceCorrectionPackets).not.toHaveBeenCalled();
    expect(readCurrentAcceptancePrDecision).not.toHaveBeenCalled();
    expect(readAcceptancePrReviewMetrics).not.toHaveBeenCalled();
  });

  it("403 when the user is not a workspace member, before reading the timeline", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(403);
    expect(getWorkspaceMembership).toHaveBeenCalledWith(USER, WS);
    expect(readChangeRecordTimeline).not.toHaveBeenCalled();
    expect(readCurrentAcceptanceCorrectionPackets).not.toHaveBeenCalled();
    expect(readCurrentAcceptancePrDecision).not.toHaveBeenCalled();
    expect(readAcceptancePrReviewMetrics).not.toHaveBeenCalled();
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
    expect(readCurrentAcceptancePrDecision).not.toHaveBeenCalled();
    expect(readAcceptancePrReviewMetrics).not.toHaveBeenCalled();
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
    expect(readCurrentAcceptancePrDecision).not.toHaveBeenCalled();
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
      finalDecision: currentFinalDecision,
      reviewMetrics: {
        ...currentReviewMetrics,
        cycles: [{
          ...currentReviewMetrics.cycles[0],
          reviewedAt: REVIEW_AT.toISOString(),
        }],
      },
      canRecordFinalDecision: false,
      canRecordReviewEffort: false,
    });
    expect(readCurrentAcceptanceCorrectionPackets).toHaveBeenCalledWith({
      workspaceId: WS,
      recordId: RECORD,
    });
    expect(readCurrentAcceptancePrDecision).toHaveBeenCalledWith({
      workspaceId: WS,
      recordId: RECORD,
    });
    expect(readAcceptancePrReviewMetrics).toHaveBeenCalledWith({
      workspaceId: WS,
      recordId: RECORD,
    });
  });

  it("returns owner/admin decision capability without widening member read access", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1", role: "admin" } as never);

    const res = await GET(req(), { params: params() });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.canRecordFinalDecision).toBe(true);
    expect(body.canRecordReviewEffort).toBe(true);
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

  it("downgrades a separately read current final decision on an exact-head generation race", async () => {
    vi.mocked(readCurrentAcceptancePrDecision).mockResolvedValue({
      ...currentFinalDecision,
      binding: {
        ...currentFinalDecision.binding,
        headSha: "e".repeat(40),
        headCycleId: "00000000-0000-4000-8000-000000000100",
        reviewJobId: "00000000-0000-4000-8000-000000000100",
        authorityGeneration: 2,
      },
    } as never);

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(200);
    expect((await res.json()).finalDecision).toEqual({ kind: "not_current" });
  });

  it("downgrades review metrics when their current cycle races the separately read Record head", async () => {
    vi.mocked(readAcceptancePrReviewMetrics).mockResolvedValue({
      ...currentReviewMetrics,
      currentCycle: {
        headSha: "e".repeat(40),
        headCycleId: "00000000-0000-4000-8000-000000000100",
        authorityGeneration: 2,
      },
    } as never);

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(200);
    expect((await res.json()).reviewMetrics).toEqual({
      kind: "unavailable",
      reason: "invalid_review_custody",
    });
  });

  it("downgrades metrics when current-head authority and the metrics current-cycle marker disagree", async () => {
    vi.mocked(readAcceptancePrReviewMetrics).mockResolvedValue({
      ...currentReviewMetrics,
      currentCycle: null,
      cycles: [{ ...currentReviewMetrics.cycles[0], current: false }],
    } as never);

    const missingCurrent = await GET(req(), { params: params() });
    expect((await missingCurrent.json()).reviewMetrics).toEqual({
      kind: "unavailable",
      reason: "invalid_review_custody",
    });

    vi.mocked(readChangeRecordTimeline).mockResolvedValue({
      ...timeline,
      record: { ...timeline.record, currentPrHeadAuthoritative: false },
    } as never);
    vi.mocked(readAcceptancePrReviewMetrics).mockResolvedValue(currentReviewMetrics as never);

    const unexpectedCurrent = await GET(req(), { params: params() });
    expect((await unexpectedCurrent.json()).reviewMetrics).toEqual({
      kind: "unavailable",
      reason: "invalid_review_custody",
    });
  });

  it("serializes every historical review-metrics timestamp without inferring unknown effort", async () => {
    vi.mocked(readAcceptancePrReviewMetrics).mockResolvedValue({
      ...currentReviewMetrics,
      cycles: [{
        ...currentReviewMetrics.cycles[0],
        effort: {
          kind: "known",
          value: {
            eventId: EFFORT_EVENT_ID,
            eventKey: `acceptance-pr-review-effort:${CYCLE}`,
            minutes: 37,
            source: "human_input",
            recordedBy: `user:${USER}`,
            recordedRole: "admin",
            recordedAt: EFFORT_AT,
          },
        },
        decision: {
          kind: "known",
          value: {
            eventId: DECISION_EVENT_ID,
            eventKey: `acceptance-pr-decision:${CYCLE}`,
            decision: "changes_requested",
            rationale: null,
            decidedBy: `user:${USER}`,
            decidedRole: "owner",
            decidedAt: DECIDED_AT,
          },
        },
        signedMerge: {
          kind: "known",
          value: {
            mergeEventId: "00000000-0000-4000-8000-000000000053",
            deliveryEventId: "00000000-0000-4000-8000-000000000052",
            mergeSha: "b".repeat(40),
            mergedAt: new Date("2026-08-03T12:08:00.000Z"),
            decisionAlignment: "decision_conflicts_merge",
          },
        },
        postMergeOutcomes: {
          kind: "known",
          values: [{
            eventId: "00000000-0000-4000-8000-000000000051",
            eventKey: "acceptance-post-merge:deployed:1",
            outcome: "deployed",
            recordedBy: `user:${USER}`,
            recordedAt: new Date("2026-08-03T12:09:00.000Z"),
          }],
        },
      }],
      summary: {
        ...currentReviewMetrics.summary,
        reviewEffort: {
          eligible: 1,
          known: 1,
          unknown: 0,
          totalMinutes: 37,
          averageMinutes: 37,
        },
        signedMerges: { eligible: 1, known: 1, unknown: 0 },
        postMergeOutcomes: { eligible: 1, known: 1, unknown: 0 },
      },
    } as never);

    const res = await GET(req(), { params: params() });
    const body = await res.json();

    expect(body.reviewMetrics.cycles[0]).toMatchObject({
      reviewedAt: REVIEW_AT.toISOString(),
      effort: { value: { recordedAt: EFFORT_AT.toISOString() } },
      decision: { value: { decidedAt: DECIDED_AT.toISOString() } },
      signedMerge: { value: { mergedAt: "2026-08-03T12:08:00.000Z" } },
      postMergeOutcomes: { values: [{ recordedAt: "2026-08-03T12:09:00.000Z" }] },
    });
  });

  it("serializes an immutable current decision timestamp and role", async () => {
    vi.mocked(readCurrentAcceptancePrDecision).mockResolvedValue({
      ...currentFinalDecision,
      binding: { ...currentFinalDecision.binding, reviewVerdict: "proven" },
      decision: {
        eventId: DECISION_EVENT_ID,
        eventKey: `acceptance-pr-decision:${CYCLE}`,
        decision: "approved",
        rationale: null,
        decidedBy: `user:${USER}`,
        decidedRole: "owner",
        decidedAt: DECIDED_AT,
      },
    } as never);

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(200);
    expect((await res.json()).finalDecision.decision).toEqual({
      eventId: DECISION_EVENT_ID,
      eventKey: `acceptance-pr-decision:${CYCLE}`,
      decision: "approved",
      rationale: null,
      decidedBy: `user:${USER}`,
      decidedRole: "owner",
      decidedAt: DECIDED_AT.toISOString(),
    });
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
    expect(readCurrentAcceptancePrDecision).not.toHaveBeenCalled();
    expect(readAcceptancePrReviewMetrics).not.toHaveBeenCalled();
  });

  it("500 when current correction packet storage fails", async () => {
    vi.mocked(readCurrentAcceptanceCorrectionPackets).mockRejectedValue(new Error("db down"));

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Failed to load change record detail",
    });
  });

  it("500 when current final-decision storage fails", async () => {
    vi.mocked(readCurrentAcceptancePrDecision).mockRejectedValue(new Error("db down"));

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Failed to load change record detail",
    });
  });

  it("500 when historical review-metrics storage fails", async () => {
    vi.mocked(readAcceptancePrReviewMetrics).mockRejectedValue(new Error("db down"));

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to load change record detail" });
  });
});

describe("PATCH /api/v1/workspaces/[workspaceId]/change-records/[recordId]", () => {
  beforeEach(() => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1", role: "owner" } as never);
  });

  it("authenticates and owner/admin-authorizes before parsing or writing", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const unauthenticated = await PATCH(patchReq({ nope: true }), { params: params() });
    expect(unauthenticated.status).toBe(401);
    expect(getWorkspaceMembership).not.toHaveBeenCalled();
    expect(recordAcceptancePrDecision).not.toHaveBeenCalled();
    expect(recordAcceptancePrReviewEffort).not.toHaveBeenCalled();

    vi.mocked(auth).mockResolvedValue({ user: { id: "not-a-uuid" } } as never);
    const invalidActor = await PATCH(patchReq({ nope: true }), { params: params() });
    expect(invalidActor.status).toBe(401);
    expect(getWorkspaceMembership).not.toHaveBeenCalled();
    expect(recordAcceptancePrDecision).not.toHaveBeenCalled();
    expect(recordAcceptancePrReviewEffort).not.toHaveBeenCalled();

    vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1", role: "member" } as never);
    const forbidden = await PATCH(patchReq({ nope: true }), { params: params() });
    expect(forbidden.status).toBe(403);
    expect(recordAcceptancePrDecision).not.toHaveBeenCalled();
    expect(recordAcceptancePrReviewEffort).not.toHaveBeenCalled();
  });

  it("rejects non-JSON, declared oversize, unknown decisions, and extra authority fields", async () => {
    const bodies = [
      patchReq({ action: "record_pr_decision", bindingId: DECISION_BINDING_ID, decision: "merge_now" }),
      patchReq({
        action: "record_pr_decision",
        bindingId: DECISION_BINDING_ID,
        decision: "approved",
        headSha: HEAD,
      }),
      patchReq({ action: "record_pr_decision", bindingId: DECISION_BINDING_ID, decision: "approved_with_exception" }),
      patchReq({ action: "record_pr_decision", bindingId: DECISION_BINDING_ID, decision: "approved" }, { contentType: "text/plain" }),
      patchReq(
        { action: "record_pr_decision", bindingId: DECISION_BINDING_ID, decision: "approved" },
        { contentLength: String(20 * 1024 + 1) },
      ),
      patchReq({ action: "record_pr_decision", bindingId: "not-a-uuid", decision: "approved" }),
      patchReq({ bindingId: DECISION_BINDING_ID, decision: "approved" }),
    ];

    for (const request of bodies) {
      const response = await PATCH(request, { params: params() });
      expect(response.status).toBe(400);
    }
    expect(recordAcceptancePrDecision).not.toHaveBeenCalled();
  });

  it("derives workspace, Record, actor, and current proof while normalizing bounded rationale", async () => {
    const response = await PATCH(patchReq({
      action: "record_pr_decision",
      bindingId: DECISION_BINDING_ID,
      decision: "changes_requested",
      rationale: "  The failed criterion must be repaired.  ",
    }), { params: params() });

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(recordAcceptancePrDecision).toHaveBeenCalledWith({
      workspaceId: WS,
      recordId: RECORD,
      bindingId: DECISION_BINDING_ID,
      decision: "changes_requested",
      rationale: "The failed criterion must be repaired.",
      decidedBy: `user:${USER}`,
    });
    expect(await response.json()).toEqual({
      kind: "recorded",
      binding: currentFinalDecision.binding,
      decision: {
        eventId: DECISION_EVENT_ID,
        eventKey: `acceptance-pr-decision:${CYCLE}`,
        decision: "changes_requested",
        rationale: "The failed criterion must be repaired.",
        decidedBy: `user:${USER}`,
        decidedRole: "owner",
        decidedAt: DECIDED_AT.toISOString(),
      },
    });
  });

  it("reports exact replay as 200 without claiming another recording", async () => {
    vi.mocked(recordAcceptancePrDecision).mockResolvedValue({
      kind: "replayed",
      binding: { ...currentFinalDecision.binding, reviewVerdict: "proven" },
      decision: {
        eventId: DECISION_EVENT_ID,
        eventKey: `acceptance-pr-decision:${CYCLE}`,
        decision: "approved",
        rationale: null,
        decidedBy: `user:${USER}`,
        decidedRole: "admin",
        decidedAt: DECIDED_AT,
      },
    } as never);

    const response = await PATCH(patchReq({
      action: "record_pr_decision",
      bindingId: DECISION_BINDING_ID,
      decision: "approved",
    }), { params: params() });

    expect(response.status).toBe(200);
    expect((await response.json()).kind).toBe("replayed");
  });

  it("returns not_current when the rendered binding is stale", async () => {
    const staleBindingId = "00000000-0000-4000-8000-000000000044";
    vi.mocked(recordAcceptancePrDecision).mockResolvedValue({ kind: "not_current" });

    const response = await PATCH(patchReq({
      action: "record_pr_decision",
      bindingId: staleBindingId,
      decision: "rejected",
    }), { params: params() });

    expect(recordAcceptancePrDecision).toHaveBeenCalledWith({
      workspaceId: WS,
      recordId: RECORD,
      bindingId: staleBindingId,
      decision: "rejected",
      decidedBy: `user:${USER}`,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ kind: "not_current" });
  });

  it.each([
    [{ kind: "not_found" }, 404],
    [{ kind: "not_authorized" }, 403],
    [{ kind: "not_current" }, 409],
    [{ kind: "not_ready", reason: "review_job_unavailable" }, 409],
    [{ kind: "decision_not_allowed", reason: "approval_requires_proven" }, 409],
  ] as const)("maps the closed DB result %# without inventing success", async (result, status) => {
    vi.mocked(recordAcceptancePrDecision).mockResolvedValue(result as never);

    const response = await PATCH(patchReq({
      action: "record_pr_decision",
      bindingId: DECISION_BINDING_ID,
      decision: "approved",
    }), { params: params() });

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(result);
  });

  it("maps an immutable decision conflict to 409 and sanitizes unexpected storage failures", async () => {
    vi.mocked(recordAcceptancePrDecision).mockRejectedValueOnce(
      new AcceptancePrDecisionConflictError(),
    );
    const conflict = await PATCH(patchReq({
      action: "record_pr_decision",
      bindingId: DECISION_BINDING_ID,
      decision: "rejected",
    }), { params: params() });
    expect(conflict.status).toBe(409);

    vi.mocked(recordAcceptancePrDecision).mockRejectedValueOnce(
      new Error("postgres://secret@db/internal"),
    );
    const unavailable = await PATCH(patchReq({
      action: "record_pr_decision",
      bindingId: DECISION_BINDING_ID,
      decision: "rejected",
    }), { params: params() });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "Change Record action unavailable" });
  });

  it("records whole-minute review effort using only the rendered binding and server-derived actor", async () => {
    const response = await PATCH(patchReq({
      action: "record_pr_review_effort",
      bindingId: DECISION_BINDING_ID,
      minutes: 37,
    }), { params: params() });

    expect(response.status).toBe(201);
    expect(recordAcceptancePrReviewEffort).toHaveBeenCalledWith({
      workspaceId: WS,
      recordId: RECORD,
      bindingId: DECISION_BINDING_ID,
      minutes: 37,
      recordedBy: `user:${USER}`,
    });
    expect(recordAcceptancePrDecision).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      kind: "recorded",
      binding: currentFinalDecision.binding,
      effort: {
        eventId: EFFORT_EVENT_ID,
        eventKey: `acceptance-pr-review-effort:${CYCLE}`,
        minutes: 37,
        source: "human_input",
        recordedBy: `user:${USER}`,
        recordedRole: "owner",
        recordedAt: EFFORT_AT.toISOString(),
      },
    });
  });

  it.each([
    { action: "record_pr_review_effort", bindingId: DECISION_BINDING_ID, minutes: 0 },
    { action: "record_pr_review_effort", bindingId: DECISION_BINDING_ID, minutes: 1_441 },
    { action: "record_pr_review_effort", bindingId: DECISION_BINDING_ID, minutes: 3.5 },
    { action: "record_pr_review_effort", bindingId: DECISION_BINDING_ID, minutes: "37" },
    { action: "record_pr_review_effort", bindingId: "stale-head", minutes: 37 },
    { action: "record_pr_review_effort", bindingId: DECISION_BINDING_ID, minutes: 37, headSha: HEAD },
    { action: "record_pr_review_effort", bindingId: DECISION_BINDING_ID },
  ])("rejects invalid or authority-bearing review-effort input %#", async (body) => {
    const response = await PATCH(patchReq(body), { params: params() });

    expect(response.status).toBe(400);
    expect(recordAcceptancePrReviewEffort).not.toHaveBeenCalled();
  });

  it("reports exact effort replay as 200 without inventing another receipt", async () => {
    vi.mocked(recordAcceptancePrReviewEffort).mockResolvedValue({
      kind: "replayed",
      binding: currentFinalDecision.binding,
      effort: {
        eventId: EFFORT_EVENT_ID,
        eventKey: `acceptance-pr-review-effort:${CYCLE}`,
        minutes: 37,
        source: "human_input",
        recordedBy: `user:${USER}`,
        recordedRole: "admin",
        recordedAt: EFFORT_AT,
      },
    } as never);

    const response = await PATCH(patchReq({
      action: "record_pr_review_effort",
      bindingId: DECISION_BINDING_ID,
      minutes: 37,
    }), { params: params() });

    expect(response.status).toBe(200);
    expect((await response.json()).kind).toBe("replayed");
  });

  it.each([
    [{ kind: "not_found" }, 404],
    [{ kind: "not_authorized" }, 403],
    [{ kind: "not_current" }, 409],
    [{ kind: "not_ready", reason: "invalid_review_custody" }, 409],
  ] as const)("maps the closed review-effort DB result %# without inventing success", async (result, status) => {
    vi.mocked(recordAcceptancePrReviewEffort).mockResolvedValue(result as never);

    const response = await PATCH(patchReq({
      action: "record_pr_review_effort",
      bindingId: DECISION_BINDING_ID,
      minutes: 37,
    }), { params: params() });

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(result);
  });

  it("maps immutable effort conflicts to 409 and sanitizes storage failures", async () => {
    vi.mocked(recordAcceptancePrReviewEffort).mockRejectedValueOnce(
      new AcceptancePrReviewEffortConflictError(),
    );
    const conflict = await PATCH(patchReq({
      action: "record_pr_review_effort",
      bindingId: DECISION_BINDING_ID,
      minutes: 37,
    }), { params: params() });
    expect(conflict.status).toBe(409);

    vi.mocked(recordAcceptancePrReviewEffort).mockRejectedValueOnce(
      new Error("postgres://secret@db/internal"),
    );
    const unavailable = await PATCH(patchReq({
      action: "record_pr_review_effort",
      bindingId: DECISION_BINDING_ID,
      minutes: 37,
    }), { params: params() });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "Change Record action unavailable" });
  });
});
