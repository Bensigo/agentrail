import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  confirmAcceptanceContract: vi.fn(),
  createDraftAcceptanceContract: vi.fn(),
  getWorkspaceMembership: vi.fn(),
  readAcceptanceContracts: vi.fn(),
  readAcceptanceContextPacks: vi.fn(),
  readChangeRecordTimeline: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import {
  confirmAcceptanceContract,
  createDraftAcceptanceContract,
  getWorkspaceMembership,
  readAcceptanceContracts,
  readAcceptanceContextPacks,
  readChangeRecordTimeline,
} from "@agentrail/db-postgres";
import { GET, PATCH } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
const OTHER_WS = "00000000-0000-0000-0000-000000000002";
const RECORD = "00000000-0000-0000-0000-000000000111";
const USER = "user-1";
const CREATED = new Date("2026-08-03T12:00:00.000Z");
const UPDATED = new Date("2026-08-03T12:05:00.000Z");
const REVIEW_AT = new Date("2026-08-03T12:04:00.000Z");
const validContract = {
  originalUserWording: "Add a visible save button",
  goal: "A signed-in user can save a draft",
  acceptanceCriteria: [{ id: "AC-1", text: "The save button saves", required: true, userVisible: false }],
  nonGoals: [], risks: [], environmentExpectations: [], stopConditions: [], affectedCodebaseUnits: [], openQuestions: [],
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

function confirmRequest(body: unknown) {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/change-records/${RECORD}`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
}

const timeline = {
  record: {
    id: RECORD,
    workspaceId: WS,
    repo: "ada/widgets",
    issueNumber: 42,
    prNumber: 98,
    headShas: ["deadbeef", "feedface"],
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
  vi.mocked(readAcceptanceContracts).mockResolvedValue([] as never);
  vi.mocked(readAcceptanceContextPacks).mockResolvedValue([] as never);
  vi.mocked(confirmAcceptanceContract).mockResolvedValue({
    id: "contract-1", recordId: RECORD, version: 2, status: "confirmed",
    contract: { originalRequest: "Add a button" }, createdBy: "user:lead",
    confirmedBy: `user:${USER}`, confirmedAt: UPDATED, createdAt: CREATED,
  } as never);
  vi.mocked(createDraftAcceptanceContract).mockResolvedValue({
    id: "contract-2", recordId: RECORD, version: 2, status: "draft", contract: validContract,
    createdBy: `user:${USER}`, confirmedBy: null, confirmedAt: null, createdAt: CREATED,
  } as never);
});

describe("GET /api/v1/workspaces/[workspaceId]/change-records/[recordId]", () => {
  it("401 when not authenticated, before any workspace or record lookup", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(401);
    expect(getWorkspaceMembership).not.toHaveBeenCalled();
    expect(readChangeRecordTimeline).not.toHaveBeenCalled();
    expect(readAcceptanceContextPacks).not.toHaveBeenCalled();
  });

  it("403 when the user is not a workspace member, before reading the timeline", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(403);
    expect(getWorkspaceMembership).toHaveBeenCalledWith(USER, WS);
    expect(readChangeRecordTimeline).not.toHaveBeenCalled();
    expect(readAcceptanceContextPacks).not.toHaveBeenCalled();
  });

  it("404 when no change record exists in the caller workspace", async () => {
    vi.mocked(readChangeRecordTimeline).mockResolvedValue(null as never);

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(404);
    expect(readChangeRecordTimeline).toHaveBeenCalledWith({
      workspaceId: WS,
      recordId: RECORD,
    });
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
        headShas: ["deadbeef", "feedface"],
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
      contracts: [],
      contextPacks: [],
    });
  });

  it("500 when storage fails", async () => {
    vi.mocked(readChangeRecordTimeline).mockRejectedValue(new Error("db down"));

    const res = await GET(req(), { params: params() });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Failed to load change record timeline",
    });
  });
});

describe("PATCH /api/v1/workspaces/[workspaceId]/change-records/[recordId]", () => {
  it("validates and appends a human draft version for any workspace member", async () => {
    const res = await PATCH(confirmRequest({ action: "create_draft_version", contract: validContract }), { params: params() });
    expect(res.status).toBe(201);
    expect(createDraftAcceptanceContract).toHaveBeenCalledWith({
      recordId: RECORD, contract: validContract, createdBy: `user:${USER}`,
    });
    await expect(res.json()).resolves.toMatchObject({
      contract: { recordId: RECORD, version: 2, status: "draft", createdBy: `user:${USER}` },
    });
  });

  it("returns parser errors without mutating for an invalid human draft", async () => {
    const res = await PATCH(confirmRequest({ action: "create_draft_version", contract: { goal: "missing fields" } }), { params: params() });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ errors: { originalUserWording: expect.any(String) } });
    expect(createDraftAcceptanceContract).not.toHaveBeenCalled();
  });

  it("requires an explicit confirm action and positive contract version", async () => {
    const res = await PATCH(confirmRequest({ action: "approve", version: 2 }), { params: params() });
    expect(res.status).toBe(400);
    expect(confirmAcceptanceContract).not.toHaveBeenCalled();
  });

  it("confirms a draft only after workspace membership and returns the recorded actor", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1", role: "owner" } as never);
    const res = await PATCH(confirmRequest({ action: "confirm_contract", version: 2 }), { params: params() });
    expect(res.status).toBe(200);
    expect(confirmAcceptanceContract).toHaveBeenCalledWith({
      workspaceId: WS, recordId: RECORD, version: 2, confirmedBy: `user:${USER}`,
    });
    await expect(res.json()).resolves.toMatchObject({
      contract: { recordId: RECORD, version: 2, status: "confirmed", confirmedBy: `user:${USER}` },
    });
  });

  it("does not let a regular member confirm the team contract", async () => {
    const res = await PATCH(confirmRequest({ action: "confirm_contract", version: 2 }), { params: params() });

    expect(res.status).toBe(403);
    expect(confirmAcceptanceContract).not.toHaveBeenCalled();
  });
});
