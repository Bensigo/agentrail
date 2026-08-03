import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  db: { select: vi.fn() },
}));

import { db } from "../db.js";
import { getRequirementDecisionReport } from "./requirement_decisions.js";

const mockDb = vi.mocked(db);

function mockGroupedRows(rows: Array<Record<string, unknown>>) {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "leftJoin", "where"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain["groupBy"] = vi.fn(() => Promise.resolve(rows));
  mockDb.select = vi.fn(() => chain as ReturnType<typeof db.select>);
  return chain;
}

const FROM = new Date("2026-08-01T00:00:00.000Z");
const TO = new Date("2026-09-01T00:00:00.000Z");

beforeEach(() => vi.clearAllMocks());

describe("getRequirementDecisionReport", () => {
  it("returns explicit denominators and computes false-refusal/false-accept rates", async () => {
    mockGroupedRows([
      {
        taskFamily: "mechanical",
        evaluatedDenominator: "4",
        refusalCount: "2",
        overrideCount: "1",
        overrideDenominator: "2",
        falseRefusalCount: "1",
        falseRefusalDenominator: "2",
        falseAcceptCount: "1",
        falseAcceptDenominator: "2",
        unknownFinalOutcomeCount: "1",
      },
      {
        taskFamily: null,
        evaluatedDenominator: "1",
        refusalCount: "1",
        overrideCount: "0",
        overrideDenominator: "1",
        falseRefusalCount: "0",
        falseRefusalDenominator: "0",
        falseAcceptCount: "0",
        falseAcceptDenominator: "0",
        unknownFinalOutcomeCount: "1",
      },
    ]);

    const report = await getRequirementDecisionReport({
      from: FROM,
      to: TO,
      workspaceId: "ws-1",
    });

    expect(report).toMatchObject({
      from: FROM.toISOString(),
      to: TO.toISOString(),
      workspaceId: "ws-1",
      evaluatedDenominator: 5,
      refusalCount: 3,
      refusalRate: 3 / 5,
      overrideCount: 1,
      overrideDenominator: 3,
      overrideRate: 1 / 3,
      falseRefusalCount: 1,
      falseRefusalDenominator: 2,
      falseRefusalRate: 0.5,
      falseAcceptCount: 1,
      falseAcceptDenominator: 2,
      falseAcceptRate: 0.5,
      unknownFinalOutcomeCount: 2,
      nullTaskFamilyCount: 1,
    });
    expect(report.byTaskFamily).toHaveLength(2);
  });

  it("returns null rates when their denominators are zero instead of reporting zero", async () => {
    mockGroupedRows([
      {
        taskFamily: "general",
        evaluatedDenominator: "1",
        refusalCount: "0",
        overrideCount: "0",
        overrideDenominator: "0",
        falseRefusalCount: "0",
        falseRefusalDenominator: "0",
        falseAcceptCount: "0",
        falseAcceptDenominator: "0",
        unknownFinalOutcomeCount: "1",
      },
    ]);

    const report = await getRequirementDecisionReport({ from: FROM, to: TO });

    expect(report.falseRefusalRate).toBeNull();
    expect(report.falseAcceptRate).toBeNull();
    expect(report.overrideRate).toBeNull();
    expect(report.byTaskFamily[0]?.falseRefusalRate).toBeNull();
    expect(report.byTaskFamily[0]?.overrideRate).toBeNull();
  });

  it("rejects an empty or reversed date range", async () => {
    await expect(
      getRequirementDecisionReport({ from: TO, to: TO })
    ).rejects.toThrow("to must be after from");
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});
