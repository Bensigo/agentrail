import { describe, expect, it } from "vitest";
import {
  evaluateJudgmentConstraints,
  parseDecisionMemoryConstraint,
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
  it("turns explicitly tagged decision memories into enforceable constraints", () => {
    expect(parseDecisionMemoryConstraint({
      id: "decision-1",
      content: "Keep the worker on Postgres.",
      tags: ["adr", "judgment:blocked-term:Redis", "judgment:blocked-term: redis"],
    })).toEqual({
      eventId: "decision-1",
      eventKey: "memory:decision-1",
      terms: ["redis"],
      reason: "Keep the worker on Postgres.",
    });
  });

  it("keeps untagged decisions advisory", () => {
    expect(parseDecisionMemoryConstraint({
      id: "decision-2",
      content: "Use Postgres for durable state.",
      tags: ["adr"],
    })).toBeNull();
  });

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
