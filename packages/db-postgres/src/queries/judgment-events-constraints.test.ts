import { describe, expect, it } from "vitest";
import {
  evaluateJudgmentConstraints,
  parseJudgmentConstraint,
} from "./judgment_events.js";

const event = (payload: Record<string, unknown>) => ({
  id: "event-1",
  workspaceId: "ws-1",
  repo: "acme/widgets",
  eventKey: "rejected:approach-1",
  type: "rejected_approach" as const,
  refs: {},
  payload,
  actorRef: { kind: "user", id: "u-1" },
  sourceRef: { kind: "chat", id: "s-1" },
  occurredAt: new Date("2026-08-03T00:00:00Z"),
  createdAt: new Date("2026-08-03T00:00:00Z"),
});

describe("judgment constraint evaluation", () => {
  it("extracts the structured blockedTerms contract", () => {
    expect(parseJudgmentConstraint(event({
      blockedTerms: ["Redis", "  managed queue  ", "redis"],
      reason: "The team rejected this dependency.",
    }))).toEqual({
      eventId: "event-1",
      eventKey: "rejected:approach-1",
      terms: ["redis", "managed queue"],
      reason: "The team rejected this dependency.",
    });
  });

  it("ignores malformed or too-short terms instead of creating a blocker", () => {
    expect(parseJudgmentConstraint(event({ blockedTerms: ["no", 42, null] }))).toBeNull();
    expect(parseJudgmentConstraint(event({ reason: "missing terms" }))).toBeNull();
  });

  it("blocks only when every configured term occurs, case-insensitively", () => {
    const constraint = parseJudgmentConstraint(event({
      blockedTerms: ["managed queue", "redis"],
      reason: "Use the existing database-backed worker.",
    }))!;
    expect(evaluateJudgmentConstraints({
      proposalText: "Add Redis as the managed queue for retries",
      constraints: [constraint],
    })).toMatchObject({ allowed: false, blocks: [{ eventId: "event-1" }] });
    expect(evaluateJudgmentConstraints({
      proposalText: "Add a managed queue for retries",
      constraints: [constraint],
    })).toEqual({ allowed: true, blocks: [], warnings: [] });
  });
});
