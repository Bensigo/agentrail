import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  getJudgmentCalibrationSummary: vi.fn(),
  getRepositoryByName: vi.fn(),
  getWorkspaceMembership: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import {
  getJudgmentCalibrationSummary,
  getRepositoryByName,
  getWorkspaceMembership,
} from "@agentrail/db-postgres";

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "user-1";

function makeParams(workspaceId = WORKSPACE_ID) {
  return { params: Promise.resolve({ workspaceId }) };
}

function makeRequest(search = "repo=bensigo/agentrail"): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/judgment-events/calibration?${search}`
  );
}

function mockMember() {
  vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    role: "member",
  } as never);
}

describe("workspace judgment events calibration route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getRepositoryByName).mockResolvedValue({
      id: "repo-1",
      workspaceId: WORKSPACE_ID,
      name: "bensigo/agentrail",
    } as never);
    vi.mocked(getJudgmentCalibrationSummary).mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      repo: "bensigo/agentrail",
      from: null,
      to: null,
      totalEvents: 0,
      counts: {
        review_outcome: 0,
        false_green: 0,
        missed_check: 0,
        rejected_approach: 0,
      },
      metrics: {
        reviewerAgreement: { total: 0, accepted: 0, edited: 0, dismissed: 0, confirmed: 0, rate: null },
        gateOutcome: { held: 0, reverted: 0, rate: null },
        refusals: { count: 0, attempts: 0, rate: null, byReason: {} },
      },
    } as never);
  });

  it("returns 401 before touching workspace or repo state", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await GET(makeRequest(), makeParams());

    expect(res.status).toBe(401);
    expect(getWorkspaceMembership).not.toHaveBeenCalled();
    expect(getRepositoryByName).not.toHaveBeenCalled();
    expect(getJudgmentCalibrationSummary).not.toHaveBeenCalled();
  });

  it("returns 403 for non-members before touching repo state", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);

    const res = await GET(makeRequest(), makeParams());

    expect(res.status).toBe(403);
    expect(getWorkspaceMembership).toHaveBeenCalledWith(USER_ID, WORKSPACE_ID);
    expect(getRepositoryByName).not.toHaveBeenCalled();
    expect(getJudgmentCalibrationSummary).not.toHaveBeenCalled();
  });

  it("passes repo and optional ISO range to the calibration query", async () => {
    mockMember();

    const res = await GET(
      makeRequest(
        "repo=bensigo/agentrail&from=2026-08-01T00%3A00%3A00.000Z&to=2026-08-02T00%3A00%3A00.000Z"
      ),
      makeParams()
    );

    expect(res.status).toBe(200);
    expect(getRepositoryByName).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "bensigo/agentrail"
    );
    expect(getJudgmentCalibrationSummary).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      repo: "bensigo/agentrail",
      from: new Date("2026-08-01T00:00:00.000Z"),
      to: new Date("2026-08-02T00:00:00.000Z"),
    });
  });

  it("preserves unbounded date semantics as nulls", async () => {
    mockMember();

    const res = await GET(makeRequest(), makeParams());

    expect(res.status).toBe(200);
    expect(getJudgmentCalibrationSummary).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      repo: "bensigo/agentrail",
      from: null,
      to: null,
    });
    await expect(res.json()).resolves.toEqual({
      summary: {
        workspaceId: WORKSPACE_ID,
        repo: "bensigo/agentrail",
        from: null,
        to: null,
        totalEvents: 0,
        counts: {
          review_outcome: 0,
          false_green: 0,
          missed_check: 0,
          rejected_approach: 0,
        },
        metrics: {
          reviewerAgreement: { total: 0, accepted: 0, edited: 0, dismissed: 0, confirmed: 0, rate: null },
          gateOutcome: { held: 0, reverted: 0, rate: null },
          refusals: { count: 0, attempts: 0, rate: null, byReason: {} },
        },
      },
    });
  });

  it("returns 400 for invalid dates without calling repo or ledger queries", async () => {
    mockMember();

    const res = await GET(makeRequest("repo=bensigo/agentrail&from=nope"), makeParams());

    expect(res.status).toBe(400);
    expect(getRepositoryByName).not.toHaveBeenCalled();
    expect(getJudgmentCalibrationSummary).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({
      errors: { from: "from must be an ISO timestamp" },
    });
  });

  it("returns 404 when the repo is outside the workspace", async () => {
    mockMember();
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);

    const res = await GET(makeRequest("repo=bensigo/other"), makeParams());

    expect(res.status).toBe(404);
    expect(getJudgmentCalibrationSummary).not.toHaveBeenCalled();
  });
});
