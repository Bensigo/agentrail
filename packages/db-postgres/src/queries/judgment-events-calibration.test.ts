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
      metrics: {
        reviewerAgreement: { total: 0, accepted: 0, edited: 0, dismissed: 0, confirmed: 0, rate: null },
        gateOutcome: { held: 0, reverted: 0, rate: null },
        refusals: { count: 0, attempts: 0, rate: null, byReason: {} },
      },
    });
  });

  it("maps sparse grouped rows without inventing missing categories", async () => {
    mocks.execute.mockResolvedValue([
      { type: "review_outcome", disposition: "accepted", gate_outcome: null, refusal_kind: null, decision_attempt: 1, count: 2 },
      { type: "review_outcome", disposition: "dismissed", gate_outcome: null, refusal_kind: null, decision_attempt: 1, count: 2 },
      { type: "false_green", disposition: null, gate_outcome: "reverted", refusal_kind: null, decision_attempt: 0, count: 1 },
      { type: "missed_check", disposition: null, gate_outcome: null, refusal_kind: null, decision_attempt: 0, count: 2 },
      { type: "requirement_correction", disposition: null, gate_outcome: null, refusal_kind: "unverifiable", decision_attempt: 1, count: 1 },
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
      metrics: {
        reviewerAgreement: {
          total: 4,
          accepted: 2,
          edited: 0,
          dismissed: 2,
          confirmed: 2,
          rate: 0.5,
        },
        gateOutcome: { held: 0, reverted: 1, rate: 0 },
        refusals: {
          count: 1,
          attempts: 5,
          rate: 0.2,
          byReason: { unverifiable: 1 },
        },
      },
    });
  });
});
