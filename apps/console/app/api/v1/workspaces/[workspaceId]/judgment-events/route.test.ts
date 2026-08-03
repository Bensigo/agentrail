import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  JUDGMENT_EVENT_TYPES: [
    "review_outcome",
    "requirement_correction",
    "rejected_approach",
    "false_green",
    "missed_check",
  ],
  appendJudgmentEvent: vi.fn(),
  getRepositoryByName: vi.fn(),
  getWorkspaceMembership: vi.fn(),
  listJudgmentEvents: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import {
  appendJudgmentEvent,
  getRepositoryByName,
  getWorkspaceMembership,
  listJudgmentEvents,
} from "@agentrail/db-postgres";

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_WORKSPACE_ID = "22222222-2222-2222-2222-222222222222";
const USER_ID = "user-1";

function makeParams(workspaceId = WORKSPACE_ID) {
  return { params: Promise.resolve({ workspaceId }) };
}

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/judgment-events`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

function makeGetRequest(search = "repo=bensigo/agentrail"): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/judgment-events?${search}`
  );
}

const validBody = {
  repo: "bensigo/agentrail",
  eventKey: "review:finding-1:accepted",
  type: "review_outcome",
  references: { findingId: "finding-1", runId: "run-1" },
  actor: { kind: "user", id: USER_ID },
  source: { kind: "console", id: "review-view" },
  payload: { disposition: "accepted" },
  occurredAt: "2026-08-01T12:00:00.000Z",
};

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "event-1",
    workspaceId: WORKSPACE_ID,
    repo: "bensigo/agentrail",
    eventKey: "review:finding-1:accepted",
    type: "review_outcome",
    refs: { findingId: "finding-1", runId: "run-1" },
    actorRef: { kind: "user", id: USER_ID },
    sourceRef: { kind: "console", id: "review-view" },
    payload: { disposition: "accepted" },
    occurredAt: new Date("2026-08-01T12:00:00.000Z"),
    createdAt: new Date("2026-08-01T12:00:01.000Z"),
    ...overrides,
  };
}

function mockMember() {
  vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    role: "member",
  } as never);
}

describe("workspace judgment events route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(appendJudgmentEvent).mockResolvedValue({
      event: eventRow(),
      inserted: true,
    } as never);
    vi.mocked(getRepositoryByName).mockResolvedValue({
      id: "repo-1",
      workspaceId: WORKSPACE_ID,
      name: "bensigo/agentrail",
    } as never);
    vi.mocked(listJudgmentEvents).mockResolvedValue([eventRow()] as never);
  });

  it("returns 401 when unauthenticated before touching membership or ledger", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await POST(makePostRequest(validBody), makeParams());

    expect(res.status).toBe(401);
    expect(getWorkspaceMembership).not.toHaveBeenCalled();
    expect(getRepositoryByName).not.toHaveBeenCalled();
    expect(appendJudgmentEvent).not.toHaveBeenCalled();
    expect(listJudgmentEvents).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller is not a workspace member before touching the ledger", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);

    const res = await GET(makeGetRequest(), makeParams());

    expect(res.status).toBe(403);
    expect(getWorkspaceMembership).toHaveBeenCalledWith(USER_ID, WORKSPACE_ID);
    expect(getRepositoryByName).not.toHaveBeenCalled();
    expect(listJudgmentEvents).not.toHaveBeenCalled();
    expect(appendJudgmentEvent).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid event type and does not append", async () => {
    mockMember();

    const res = await POST(
      makePostRequest({ ...validBody, type: "approval_vibes" }),
      makeParams()
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors.type).toContain("review_outcome");
    expect(appendJudgmentEvent).not.toHaveBeenCalled();
  });

  it("returns 404 when the repo is not in the caller's workspace", async () => {
    mockMember();
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);

    const res = await GET(makeGetRequest("repo=bensigo/other"), makeParams());

    expect(res.status).toBe(404);
    expect(getRepositoryByName).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "bensigo/other"
    );
    expect(listJudgmentEvents).not.toHaveBeenCalled();
    expect(appendJudgmentEvent).not.toHaveBeenCalled();
  });

  it("returns a 409 idempotent append result when the store reports an existing event", async () => {
    mockMember();
    vi.mocked(appendJudgmentEvent).mockResolvedValue({
      event: eventRow(),
      inserted: false,
    } as never);

    const res = await POST(makePostRequest(validBody), makeParams());

    expect(res.status).toBe(409);
    expect(appendJudgmentEvent).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      repo: "bensigo/agentrail",
      eventKey: "review:finding-1:accepted",
      type: "review_outcome",
      refs: { findingId: "finding-1", runId: "run-1" },
      actorRef: { kind: "user", id: USER_ID },
      sourceRef: { kind: "console", id: "review-view" },
      payload: { disposition: "accepted" },
      occurredAt: new Date("2026-08-01T12:00:00.000Z"),
    });
    const body = await res.json();
    expect(body.inserted).toBe(false);
    expect(body.event.occurredAt).toBe("2026-08-01T12:00:00.000Z");
    expect(body.event.createdAt).toBe("2026-08-01T12:00:01.000Z");
  });

  it("passes bounded filters/order to listJudgmentEvents and returns ordered ISO JSON", async () => {
    mockMember();
    vi.mocked(listJudgmentEvents).mockResolvedValue([
      eventRow({
        id: "older",
        eventKey: "older",
        type: "false_green",
        occurredAt: new Date("2026-08-01T12:00:00.000Z"),
      }),
      eventRow({
        id: "newer",
        eventKey: "newer",
        type: "false_green",
        occurredAt: new Date("2026-08-01T13:00:00.000Z"),
      }),
    ] as never);

    const res = await GET(
      makeGetRequest("repo=bensigo/agentrail&type=false_green&order=asc&limit=500"),
      makeParams()
    );

    expect(res.status).toBe(200);
    expect(listJudgmentEvents).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      repo: "bensigo/agentrail",
      type: "false_green",
      order: "asc",
      limit: 100,
    });
    const body = await res.json();
    expect(body.events.map((event: { id: string }) => event.id)).toEqual([
      "older",
      "newer",
    ]);
    expect(body.events[0].occurredAt).toBe("2026-08-01T12:00:00.000Z");
    expect(body.events[0].references).toEqual({
      findingId: "finding-1",
      runId: "run-1",
    });
  });

  it("keeps cross-tenant reads and writes scoped to the route workspace", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      userId: USER_ID,
      workspaceId: OTHER_WORKSPACE_ID,
      role: "member",
    } as never);

    const postRes = await POST(
      makePostRequest(validBody),
      makeParams(OTHER_WORKSPACE_ID)
    );
    const getRes = await GET(makeGetRequest(), makeParams(OTHER_WORKSPACE_ID));

    expect(postRes.status).toBe(201);
    expect(getRes.status).toBe(200);
    expect(getRepositoryByName).toHaveBeenCalledWith(
      OTHER_WORKSPACE_ID,
      "bensigo/agentrail"
    );
    expect(appendJudgmentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: OTHER_WORKSPACE_ID })
    );
    expect(listJudgmentEvents).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: OTHER_WORKSPACE_ID })
    );
  });

  it("returns 500 with a stable error shape when the store throws", async () => {
    mockMember();
    vi.mocked(appendJudgmentEvent).mockRejectedValue(new Error("db down"));

    const res = await POST(makePostRequest(validBody), makeParams());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: "Failed to append judgment event",
    });
  });
});
