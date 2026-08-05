import { describe, expect, it } from "vitest";
import {
  computeProductionHumanFalseGreen,
  type SuccessfulRunForHumanFalseGreen,
} from "./human_false_green.js";
import type { ReviewEventRow } from "./schema/review_events.js";

const WS = "ws-1";
const HEAD = "a".repeat(40);
const completed = new Date("2026-08-01T10:00:00Z");
const window = {
  from: new Date("2026-08-01T00:00:00Z"),
  to: new Date("2026-08-02T00:00:00Z"),
  observedUntil: new Date("2026-08-03T00:00:00Z"),
};

function run(overrides: Partial<SuccessfulRunForHumanFalseGreen> = {}): SuccessfulRunForHumanFalseGreen {
  return {
    id: "run-1",
    workspaceId: WS,
    status: "success",
    finishedAt: completed,
    prUrl: "https://github.com/acme/widgets/pull/42",
    prHeadSha: HEAD,
    ...overrides,
  };
}

function event(overrides: Partial<ReviewEventRow> = {}): ReviewEventRow {
  return {
    id: "event-1",
    workspaceId: WS,
    repo: "acme/widgets",
    prNumber: 42,
    taskFamily: null,
    deliveryId: "delivery-1",
    eventType: "review_submitted",
    occurredAt: new Date("2026-08-01T11:00:00Z"),
    headSha: HEAD,
    reviewState: "CHANGES_REQUESTED",
    actorType: "human",
    additions: null,
    deletions: null,
    changedFiles: null,
    humanReviewMinutes: null,
    humanReviewSource: null,
    createdAt: new Date("2026-08-01T11:00:00Z"),
    ...overrides,
  };
}

describe("computeProductionHumanFalseGreen", () => {
  it("counts an exact post-completion human change request as a false green", () => {
    const report = computeProductionHumanFalseGreen([run()], [event()], window);

    expect(report).toMatchObject({
      successfulRuns: 1,
      knownSampleSize: 1,
      falseGreenCount: 1,
      falseGreenRate: 1,
      unknown: {
        missingPr: 0,
        missingPublishedHead: 0,
        malformedPr: 0,
        noMatchingHumanOutcome: 0,
      },
    });
  });

  it("counts an exact explicit human approval in the known denominator, not as false green", () => {
    const report = computeProductionHumanFalseGreen(
      [run()],
      [event({ reviewState: "APPROVED" })],
      window
    );

    expect(report.knownSampleSize).toBe(1);
    expect(report.falseGreenCount).toBe(0);
    expect(report.falseGreenRate).toBe(0);
  });

  it.each([
    ["different repository", event({ repo: "acme/other" })],
    ["different PR", event({ prNumber: 99 })],
    ["different head", event({ headSha: "b".repeat(40) })],
    ["agent review", event({ actorType: "agent" })],
    ["non-decision review", event({ reviewState: "COMMENTED" })],
    ["generic rework event", event({ eventType: "post_merge_rework", actorType: "human" })],
    ["outcome before completion", event({ occurredAt: new Date("2026-08-01T09:00:00Z") })],
  ])("leaves %s evidence unknown rather than attributing it", (_label, evidence) => {
    const report = computeProductionHumanFalseGreen([run()], [evidence], window);

    expect(report.knownSampleSize).toBe(0);
    expect(report.falseGreenRate).toBeNull();
    expect(report.unknown.noMatchingHumanOutcome).toBe(1);
  });

  it("reports absent PR/head provenance as separate unknown reasons", () => {
    const report = computeProductionHumanFalseGreen(
      [run({ id: "missing-pr", prUrl: null }), run({ id: "missing-head", prHeadSha: null })],
      [],
      window
    );

    expect(report.successfulRuns).toBe(2);
    expect(report.unknown).toMatchObject({ missingPr: 1, missingPublishedHead: 1 });
  });

  it("rejects an observation cutoff that ends before the report window", () => {
    expect(() =>
      computeProductionHumanFalseGreen([run()], [], {
        ...window,
        observedUntil: new Date("2026-08-01T12:00:00Z"),
      })
    ).toThrow("observedUntil");
  });
});
