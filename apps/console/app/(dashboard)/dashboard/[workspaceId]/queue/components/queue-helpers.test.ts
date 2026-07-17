import { describe, expect, it } from "vitest";
import {
  ACTIVE_QUEUE_STATES,
  mapQueueEntryRows,
  projectQueueEntries,
  queueStateLabel,
  resolveQueueState,
  type QueueEntryRow,
  type QueueRunInput,
} from "./queue-helpers";

function entryRow(over: Partial<QueueEntryRow>): QueueEntryRow {
  return {
    id: "qe1",
    externalId: "owner/name#12",
    title: "Issue X",
    tier: 0,
    remainingBudget: 2,
    state: "queued",
    updatedAt: "2026-06-16T00:00:00.000Z",
    ...over,
  };
}

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

describe("mapQueueEntryRows", () => {
  it("maps a durable queue_entries row to a view entry, keyed by external id", () => {
    const [view] = mapQueueEntryRows([
      entryRow({ externalId: "owner/name#42", title: "Login", state: "queued" }),
    ]);
    expect(view.issueKey).toBe("owner/name#42");
    expect(view.title).toBe("Login");
    expect(view.state).toBe("queued");
  });

  it("reads tier directly from the entry (0 cheap, 1 strong) — not from attempt count", () => {
    expect(mapQueueEntryRows([entryRow({ tier: 0 })])[0].tier).toBe("cheap");
    expect(mapQueueEntryRows([entryRow({ tier: 1 })])[0].tier).toBe("strong");
  });

  it("carries remaining budget straight through and derives failed attempts from it", () => {
    const [view] = mapQueueEntryRows([entryRow({ remainingBudget: 1 })]);
    expect(view.remainingBudget).toBe(1);
    // Issue #1240: mapQueueEntryRows derives failedAttempts from the durable
    // queue_entries default (5), not the runs-projection's DEFAULT_BUDGET(2).
    expect(view.failedAttempts).toBe(4); // QUEUE_ENTRY_DEFAULT_BUDGET(5) - 1
  });

  it("preserves the parked state (blocked-on-dependency, still in the queue)", () => {
    expect(mapQueueEntryRows([entryRow({ state: "parked" })])[0].state).toBe(
      "parked"
    );
  });

  it("sorts most-recently-updated first", () => {
    const views = mapQueueEntryRows([
      entryRow({ id: "old", updatedAt: "2026-06-15T00:00:00.000Z" }),
      entryRow({ id: "new", updatedAt: "2026-06-16T00:00:00.000Z" }),
    ]);
    expect(views.map((v) => v.issueKey)).toBeTruthy();
    expect(views[0].updatedAt > views[1].updatedAt).toBe(true);
  });
});

describe("ACTIVE_QUEUE_STATES", () => {
  it("is exactly the non-terminal states — terminals leave the queue", () => {
    expect([...ACTIVE_QUEUE_STATES].sort()).toEqual(
      ["parked", "queued", "running"].sort()
    );
    expect(ACTIVE_QUEUE_STATES).not.toContain("green");
    expect(ACTIVE_QUEUE_STATES).not.toContain("escalated-to-human");
    expect(ACTIVE_QUEUE_STATES).not.toContain("blocked");
  });
});

describe("queueStateLabel", () => {
  it("renders the escalated terminal with its CONTEXT.md wording", () => {
    expect(queueStateLabel("escalated-to-human")).toBe("Escalated to human");
  });
});
