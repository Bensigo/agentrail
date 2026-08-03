import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock("../db.js", () => ({
  db: { execute: mocks.execute },
}));

import {
  listReviewerSuppressionRules,
  parseReviewerDismissalFindingClass,
} from "./judgment_events.js";
import type { JudgmentEventRow } from "../schema/judgment_events.js";

function event(payload: Record<string, unknown>, type = "review_outcome"): JudgmentEventRow {
  return {
    id: "event-1",
    workspaceId: "workspace-1",
    repo: "bensigo/agentrail",
    eventKey: "event-key",
    type: type as JudgmentEventRow["type"],
    refs: {},
    payload,
    actorRef: { type: "agent", id: "reviewer" },
    sourceRef: { type: "pr", id: "1547" },
    occurredAt: new Date("2026-08-03T00:00:00.000Z"),
    createdAt: new Date("2026-08-03T00:00:00.000Z"),
  };
}

describe("reviewer suppression rules", () => {
  beforeEach(() => {
    mocks.execute.mockReset();
  });

  it("normalizes dismissed review finding classes and ignores malformed payloads", () => {
    expect(parseReviewerDismissalFindingClass(event({
      disposition: "dismissed",
      findingClass: "  False Positive / Auth  ",
    }))).toBe("false positive / auth");
    expect(parseReviewerDismissalFindingClass(event({
      disposition: "accepted",
      findingClass: "false positive / auth",
    }))).toBeNull();
    expect(parseReviewerDismissalFindingClass(event({
      disposition: "dismissed",
      findingClass: "",
    }))).toBeNull();
    expect(parseReviewerDismissalFindingClass(event({
      disposition: "dismissed",
      findingClass: ["false-positive"],
    }))).toBeNull();
  });

  it("returns deterministic suppression rules with counts and source event ids", async () => {
    mocks.execute.mockResolvedValue([
      {
        finding_class: "legacy auth false positive",
        count: 3,
        source_event_ids: ["event-a", "event-b", "event-c"],
      },
      {
        finding_class: "stale generated snapshot",
        count: 4,
        source_event_ids: ["event-d", "event-e", "event-f", "event-g"],
      },
    ]);

    const rules = await listReviewerSuppressionRules({
      workspaceId: "workspace-1",
      repo: "bensigo/agentrail",
    });

    expect(rules).toEqual([
      {
        findingClass: "legacy auth false positive",
        count: 3,
        reason:
          '3 prior review findings with class "legacy auth false positive" were dismissed for this repo.',
        sourceEventIds: ["event-a", "event-b", "event-c"],
      },
      {
        findingClass: "stale generated snapshot",
        count: 4,
        reason:
          '4 prior review findings with class "stale generated snapshot" were dismissed for this repo.',
        sourceEventIds: ["event-d", "event-e", "event-f", "event-g"],
      },
    ]);
  });
});
