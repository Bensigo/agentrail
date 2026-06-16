import { describe, expect, it } from "vitest";
import {
  approvalKindLabel,
  pendingCount,
  projectApprovals,
  type AuditEventInput,
} from "./approval-helpers";

function ev(over: Partial<AuditEventInput>): AuditEventInput {
  return {
    runId: "run-1",
    type: "security_block",
    target: "main",
    reason: "protected_target",
    ts: "2026-06-16T00:00:00.000Z",
    ...over,
  };
}

describe("projectApprovals", () => {
  it("surfaces a protected-target block as a pending irreversible action", () => {
    const items = projectApprovals([ev({})]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("protected_push");
    expect(items[0].target).toBe("main");
    expect(items[0].status).toBe("pending");
  });

  it("does not surface a secret block (not human-approvable)", () => {
    const items = projectApprovals([
      ev({ reason: "secret_detected", target: "feature/x" }),
    ]);
    expect(items).toHaveLength(0);
  });

  it("marks an action approved once an approval_granted event resolves it", () => {
    const items = projectApprovals([
      ev({}),
      ev({
        type: "approval_granted",
        actionKind: "protected_push",
        target: "main",
        approvedBy: "alice@example.com",
        ts: "2026-06-16T01:00:00.000Z",
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("approved");
    expect(items[0].approvedBy).toBe("alice@example.com");
  });

  it("surfaces a merge approval recorded directly from the console", () => {
    const items = projectApprovals([
      ev({
        type: "approval_granted",
        actionKind: "merge",
        target: "PR #42",
        approvedBy: "bob@example.com",
        ts: "2026-06-16T02:00:00.000Z",
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("merge");
    expect(items[0].status).toBe("approved");
  });

  it("sorts most-recently-updated first", () => {
    const items = projectApprovals([
      ev({ runId: "run-a", target: "main", ts: "2026-06-16T00:00:00.000Z" }),
      ev({ runId: "run-b", target: "prod", ts: "2026-06-16T05:00:00.000Z" }),
    ]);
    expect(items[0].runId).toBe("run-b");
  });
});

describe("pendingCount", () => {
  it("counts only pending actions", () => {
    const items = projectApprovals([
      ev({ runId: "run-a", target: "main" }),
      ev({
        runId: "run-b",
        type: "approval_granted",
        actionKind: "merge",
        target: "PR #1",
        approvedBy: "x",
        ts: "2026-06-16T03:00:00.000Z",
      }),
    ]);
    expect(pendingCount(items)).toBe(1);
  });
});

describe("approvalKindLabel", () => {
  it("uses CONTEXT.md wording", () => {
    expect(approvalKindLabel("protected_push")).toBe("Protected-target push");
    expect(approvalKindLabel("merge")).toBe("Merge");
    expect(approvalKindLabel("deploy")).toBe("Deploy");
  });
});
