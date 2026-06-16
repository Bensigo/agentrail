import { describe, expect, it } from "vitest";
import {
  projectQueueEntries,
  queueStateLabel,
  resolveQueueState,
  type QueueRunInput,
} from "./queue-helpers";

function run(over: Partial<QueueRunInput>): QueueRunInput {
  return {
    id: "r1",
    branch: "feat/x-1",
    title: "Issue X",
    agent: "claude",
    status: "queued",
    createdAt: "2026-06-16T00:00:00.000Z",
    ...over,
  };
}

describe("projectQueueEntries", () => {
  it("groups runs by branch into one Issue Queue entry per issue", () => {
    const entries = projectQueueEntries([
      run({ id: "a", branch: "feat/login-12", status: "queued" }),
      run({ id: "b", branch: "feat/login-12", status: "running" }),
      run({ id: "c", branch: "feat/logout-13", status: "success" }),
    ]);
    expect(entries).toHaveLength(2);
    const login = entries.find((e) => e.issueKey === "feat/login-12");
    expect(login?.attempts).toBe(2);
  });

  it("derives tier from attempt count: first attempt is cheap, retries escalate to strong", () => {
    const [oneAttempt] = projectQueueEntries([
      run({ id: "a", branch: "feat/a-1", status: "running" }),
    ]);
    expect(oneAttempt.tier).toBe("cheap");

    const [escalated] = projectQueueEntries([
      run({ id: "a", branch: "feat/b-2", status: "failed" }),
      run({ id: "b", branch: "feat/b-2", status: "running" }),
    ]);
    expect(escalated.tier).toBe("strong");
  });

  it("decrements remaining budget by the number of failed attempts", () => {
    const [entry] = projectQueueEntries([
      run({ id: "a", branch: "feat/c-3", status: "failed" }),
      run({ id: "b", branch: "feat/c-3", status: "running" }),
    ]);
    // Default budget 2, one failed attempt consumed → 1 remaining.
    expect(entry.remainingBudget).toBe(1);
  });
});

describe("resolveQueueState", () => {
  it("maps a successful issue to the GREEN terminal", () => {
    expect(resolveQueueState(["queued", "success"])).toBe("green");
  });

  it("maps a running issue to RUNNING", () => {
    expect(resolveQueueState(["queued", "running"])).toBe("running");
  });

  it("maps a still-queued issue to QUEUED", () => {
    expect(resolveQueueState(["queued"])).toBe("queued");
  });

  it("maps an exhausted-budget failed issue to the ESCALATED_TO_HUMAN terminal", () => {
    // Two failed attempts with no success = budget exhausted → hard stop.
    expect(resolveQueueState(["failed", "failed"])).toBe("escalated-to-human");
  });
});

describe("queueStateLabel", () => {
  it("renders the escalated terminal with its CONTEXT.md wording", () => {
    expect(queueStateLabel("escalated-to-human")).toBe("Escalated to human");
  });
});
