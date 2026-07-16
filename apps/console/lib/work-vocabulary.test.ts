import { describe, expect, it } from "vitest";
import {
  ACTIVE_QUEUE_STATES,
  DEFAULT_BUDGET,
  WORK_GROUPS,
  WORK_STATE_CHIP_CLASSNAME,
  formatParkReason,
  groupWorkEntries,
  mapQueueEntryRows,
  projectQueueEntries,
  queueStateLabel,
  resolveQueueState,
  workGroupFor,
  workStateLabel,
  type QueueEntryRow,
  type QueueRunInput,
  type QueueState,
} from "./work-vocabulary";

function entryRow(over: Partial<QueueEntryRow>): QueueEntryRow {
  return {
    id: "qe1",
    externalId: "owner/name#12",
    title: "Issue X",
    tier: 0,
    remainingBudget: 2,
    state: "queued",
    blockedBy: [],
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

  it("carries the latest run's id through as the entry id (for run-detail linking)", () => {
    const [entry] = projectQueueEntries([
      run({ id: "a", branch: "feat/d-4", status: "running", createdAt: "2026-06-16T00:00:00.000Z" }),
    ]);
    expect(entry.id).toBe("a");
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

  it("carries the row's durable id through (queue_entries.id == runs.id per claimQueueEntry)", () => {
    const [view] = mapQueueEntryRows([entryRow({ id: "qe-abc123" })]);
    expect(view.id).toBe("qe-abc123");
  });

  it("reads tier directly from the entry (0 cheap, 1 strong) — not from attempt count", () => {
    expect(mapQueueEntryRows([entryRow({ tier: 0 })])[0].tier).toBe("cheap");
    expect(mapQueueEntryRows([entryRow({ tier: 1 })])[0].tier).toBe("strong");
  });

  it("carries remaining budget straight through and derives failed attempts from it", () => {
    const [view] = mapQueueEntryRows([entryRow({ remainingBudget: 1 })]);
    expect(view.remainingBudget).toBe(1);
    expect(view.failedAttempts).toBe(1); // DEFAULT_BUDGET(2) - 1
  });

  it("preserves the parked state (blocked-on-dependency, still in the queue)", () => {
    expect(mapQueueEntryRows([entryRow({ state: "parked" })])[0].state).toBe(
      "parked"
    );
  });

  it("carries blockedBy through, defaulting to empty when absent", () => {
    expect(
      mapQueueEntryRows([entryRow({ state: "parked", blockedBy: [12, 14] })])[0]
        .blockedBy
    ).toEqual([12, 14]);
    const { blockedBy: _omit, ...withoutBlockedBy } = entryRow({});
    expect(mapQueueEntryRows([withoutBlockedBy as QueueEntryRow])[0].blockedBy).toEqual(
      []
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

describe("queueStateLabel (technical vocabulary)", () => {
  it("renders the escalated terminal with its CONTEXT.md wording", () => {
    expect(queueStateLabel("escalated-to-human")).toBe("Escalated to human");
  });
});

// ---------------------------------------------------------------------------
// User-facing Work vocabulary (spec §3) — the AC1 contract: all six states.
// ---------------------------------------------------------------------------

describe("workStateLabel", () => {
  it("maps every queue state to spec §3's user-facing label", () => {
    const expected: Record<QueueState, string> = {
      queued: "Assigned",
      running: "In progress",
      parked: "Blocked",
      green: "Shipped",
      "escalated-to-human": "Needs you",
      blocked: "Blocked",
    };
    for (const [state, label] of Object.entries(expected) as [QueueState, string][]) {
      expect(workStateLabel(state)).toBe(label);
    }
  });

  it("never renders queue_entry, tier, or remaining_budget vocabulary", () => {
    const banned = /queue_entry|tier|remaining_budget/i;
    for (const state of [
      "queued",
      "running",
      "parked",
      "green",
      "escalated-to-human",
      "blocked",
    ] as QueueState[]) {
      expect(workStateLabel(state)).not.toMatch(banned);
    }
  });
});

describe("workGroupFor", () => {
  it("maps every queue state to one of the five board groups", () => {
    const expected: Record<QueueState, string> = {
      queued: "Assigned",
      running: "In progress",
      parked: "Blocked",
      blocked: "Blocked",
      "escalated-to-human": "Needs you",
      green: "Shipped",
    };
    for (const [state, group] of Object.entries(expected) as [QueueState, string][]) {
      expect(workGroupFor(state)).toBe(group);
    }
  });

  it("merges parked and terminal-blocked into the same Blocked column", () => {
    expect(workGroupFor("parked")).toBe(workGroupFor("blocked"));
  });
});

describe("WORK_GROUPS", () => {
  it("has exactly the five spec groups, in board order", () => {
    expect(WORK_GROUPS).toEqual([
      "Assigned",
      "In progress",
      "Blocked",
      "Needs you",
      "Shipped",
    ]);
  });
});

describe("groupWorkEntries", () => {
  it("buckets entries into their board columns", () => {
    const entries = mapQueueEntryRows([
      entryRow({ id: "a", state: "queued" }),
      entryRow({ id: "b", state: "running" }),
      entryRow({ id: "c", state: "parked", blockedBy: [7] }),
      entryRow({ id: "d", state: "blocked" }),
      entryRow({ id: "e", state: "escalated-to-human" }),
      entryRow({ id: "f", state: "green" }),
    ]);
    const groups = groupWorkEntries(entries);
    expect(groups.Assigned.map((e) => e.id)).toEqual(["a"]);
    expect(groups["In progress"].map((e) => e.id)).toEqual(["b"]);
    expect(groups.Blocked.map((e) => e.id).sort()).toEqual(["c", "d"]);
    expect(groups["Needs you"].map((e) => e.id)).toEqual(["e"]);
    expect(groups.Shipped.map((e) => e.id)).toEqual(["f"]);
  });

  it("returns every group key even when a group has no entries", () => {
    const groups = groupWorkEntries([]);
    expect(Object.keys(groups).sort()).toEqual([...WORK_GROUPS].sort());
    for (const group of WORK_GROUPS) {
      expect(groups[group]).toEqual([]);
    }
  });
});

describe("formatParkReason", () => {
  it("returns undefined when there are no recorded blockers", () => {
    expect(formatParkReason(undefined)).toBeUndefined();
    expect(formatParkReason([])).toBeUndefined();
  });

  it("renders a single blocker", () => {
    expect(formatParkReason([12])).toBe("Blocked by #12");
  });

  it("renders two blockers with 'and'", () => {
    expect(formatParkReason([12, 14])).toBe("Blocked by #12 and #14");
  });

  it("renders three or more blockers as an oxford-comma list", () => {
    expect(formatParkReason([12, 14, 16])).toBe(
      "Blocked by #12, #14, and #16"
    );
  });
});

describe("WORK_STATE_CHIP_CLASSNAME", () => {
  it("has a class for all six states and reuses queue-state-badge's exact classes", () => {
    expect(WORK_STATE_CHIP_CLASSNAME.green).toBe(
      "bg-[#29a383]/20 text-[#1fd8a4] border border-[#29a383]/30"
    );
    expect(WORK_STATE_CHIP_CLASSNAME.running).toBe(
      "bg-[#f76b15]/20 text-[#ffa057] border border-[#f76b15]/30"
    );
    expect(WORK_STATE_CHIP_CLASSNAME["escalated-to-human"]).toBe(
      "bg-[#e5484d]/20 text-[#ff9592] border border-[#e5484d]/30"
    );
    expect(WORK_STATE_CHIP_CLASSNAME.blocked).toBe(
      "bg-[#ffe629]/15 text-[#f5e147] border border-[#ffe629]/30"
    );
    expect(WORK_STATE_CHIP_CLASSNAME.parked).toBe(
      "bg-[#3b82f6]/15 text-[#7cc0ff] border border-[#3b82f6]/30"
    );
    expect(WORK_STATE_CHIP_CLASSNAME.queued).toBe(
      "bg-[var(--gray-04)] text-[var(--gray-10)] border border-[var(--gray-06)]"
    );
  });
});

describe("DEFAULT_BUDGET", () => {
  it("is 2, matching queue_state.QueueEntry.remaining_budget's default", () => {
    expect(DEFAULT_BUDGET).toBe(2);
  });
});
