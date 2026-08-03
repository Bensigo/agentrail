import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock("../db.js", () => ({
  db: { execute: mocks.execute },
}));

import { getJudgmentCalibrationSummary } from "./judgment_events.js";

describe("judgment calibration summary", () => {
  beforeEach(() => {
    mocks.execute.mockReset();
  });

  it("returns explicit denominators and zeroes for an empty window", async () => {
    mocks.execute.mockResolvedValue([]);

    const summary = await getJudgmentCalibrationSummary({
      workspaceId: "workspace-1",
      repo: "bensigo/agentrail",
      from: null,
      to: null,
    });

    expect(summary).toEqual({
      workspaceId: "workspace-1",
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
    });
  });

  it("maps sparse grouped rows without inventing missing categories", async () => {
    mocks.execute.mockResolvedValue([
      { type: "review_outcome", count: 4 },
      { type: "false_green", count: 1 },
      { type: "missed_check", count: 2 },
    ]);

    const summary = await getJudgmentCalibrationSummary({
      workspaceId: "workspace-1",
      repo: "bensigo/agentrail",
      from: new Date("2026-08-01T00:00:00.000Z"),
      to: new Date("2026-08-02T00:00:00.000Z"),
    });

    expect(summary).toEqual({
      workspaceId: "workspace-1",
      repo: "bensigo/agentrail",
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
      totalEvents: 7,
      counts: {
        review_outcome: 4,
        false_green: 1,
        missed_check: 2,
        rejected_approach: 0,
      },
    });
  });
});
