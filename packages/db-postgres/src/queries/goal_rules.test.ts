import { describe, it, expect } from "vitest";
import {
  decideGoalTransition,
  canFileNextIssue,
  type GoalLeashState,
} from "./goal_rules.js";

function baseState(overrides: Partial<GoalLeashState> = {}): GoalLeashState {
  return {
    status: "active",
    maxIssues: 10,
    maxSpendUsd: 50,
    issuesFiled: 1,
    spendUsd: 5,
    stuckThreshold: 2,
    consecutiveNonGreen: 0,
    checkType: "metric",
    checkThreshold: 5,
    greenCount: 0,
    ...overrides,
  };
}

describe("decideGoalTransition — continuation", () => {
  it("refills when nothing has tripped", () => {
    const result = decideGoalTransition(baseState(), { outcome: "green", costUsd: 1 });
    expect(result.action).toBe("refill");
    expect(result.nextStatus).toBe("active");
    expect(result.greenCountAfter).toBe(1);
    expect(result.spendUsdAfter).toBe(6);
  });

  it("a non-green outcome below the stuck threshold still refills", () => {
    const result = decideGoalTransition(baseState({ consecutiveNonGreen: 0, stuckThreshold: 2 }), {
      outcome: "blocked",
      costUsd: 1,
    });
    expect(result.action).toBe("refill");
    expect(result.consecutiveNonGreenAfter).toBe(1);
  });
});

describe("decideGoalTransition — leash (the safety heart, issues)", () => {
  it("trips leashed the instant issuesFiled meets maxIssues", () => {
    const result = decideGoalTransition(
      baseState({ issuesFiled: 10, maxIssues: 10, checkThreshold: 999 }),
      { outcome: "green", costUsd: 0 }
    );
    expect(result.action).toBe("escalate_leashed");
    expect(result.nextStatus).toBe("leashed");
    expect(result.reason).toMatch(/issues filed 10\/10/);
  });

  it("does not trip leashed one issue below the cap", () => {
    const result = decideGoalTransition(
      baseState({ issuesFiled: 9, maxIssues: 10, checkThreshold: 999 }),
      { outcome: "blocked", costUsd: 0 }
    );
    expect(result.action).not.toBe("escalate_leashed");
  });
});

describe("decideGoalTransition — leash (the safety heart, spend)", () => {
  it("trips leashed the instant spend meets maxSpendUsd", () => {
    const result = decideGoalTransition(
      baseState({ spendUsd: 49, maxSpendUsd: 50, checkThreshold: 999 }),
      { outcome: "green", costUsd: 1 }
    );
    expect(result.action).toBe("escalate_leashed");
    expect(result.nextStatus).toBe("leashed");
    expect(result.reason).toMatch(/spend \$50/);
  });

  it("a negative costUsd is treated as zero, never a credit against the leash", () => {
    const result = decideGoalTransition(
      baseState({ spendUsd: 49.5, maxSpendUsd: 50, checkThreshold: 999 }),
      { outcome: "blocked", costUsd: -100 }
    );
    expect(result.spendUsdAfter).toBe(49.5);
    expect(result.action).not.toBe("escalate_leashed");
  });

  it("rounds spend to cents so float drift never masks or falsely trips the cap", () => {
    const result = decideGoalTransition(baseState({ spendUsd: 0.1, maxSpendUsd: 50 }), {
      outcome: "green",
      costUsd: 0.2,
    });
    expect(result.spendUsdAfter).toBe(0.3);
  });
});

describe("decideGoalTransition — stuck rule (the safety heart)", () => {
  it("trips escalate_stuck at exactly the threshold of consecutive non-green outcomes", () => {
    const afterFirstMiss = decideGoalTransition(baseState({ consecutiveNonGreen: 0, stuckThreshold: 2 }), {
      outcome: "blocked",
      costUsd: 0,
    });
    expect(afterFirstMiss.action).toBe("refill");
    expect(afterFirstMiss.consecutiveNonGreenAfter).toBe(1);

    const afterSecondMiss = decideGoalTransition(
      baseState({ consecutiveNonGreen: afterFirstMiss.consecutiveNonGreenAfter, stuckThreshold: 2 }),
      { outcome: "escalated-to-human", costUsd: 0 }
    );
    expect(afterSecondMiss.action).toBe("escalate_stuck");
    expect(afterSecondMiss.nextStatus).toBe("paused");
    expect(afterSecondMiss.reason).toMatch(/2 consecutive non-green/);
  });

  it("a green outcome resets the consecutive-non-green counter to zero", () => {
    const result = decideGoalTransition(baseState({ consecutiveNonGreen: 1, stuckThreshold: 2 }), {
      outcome: "green",
      costUsd: 0,
    });
    expect(result.consecutiveNonGreenAfter).toBe(0);
    expect(result.action).toBe("refill");
  });

  it("both non-green outcomes ('escalated-to-human' and 'blocked') count toward the stuck counter", () => {
    const a = decideGoalTransition(baseState({ consecutiveNonGreen: 0 }), {
      outcome: "escalated-to-human",
      costUsd: 0,
    });
    expect(a.consecutiveNonGreenAfter).toBe(1);
    const b = decideGoalTransition(baseState({ consecutiveNonGreen: 0 }), {
      outcome: "blocked",
      costUsd: 0,
    });
    expect(b.consecutiveNonGreenAfter).toBe(1);
  });
});

describe("decideGoalTransition — reached (metric check)", () => {
  it("reaches when the green count meets the threshold", () => {
    const result = decideGoalTransition(baseState({ greenCount: 4, checkThreshold: 5 }), {
      outcome: "green",
      costUsd: 0,
    });
    expect(result.action).toBe("reached");
    expect(result.nextStatus).toBe("reached");
  });

  it("does not reach one green short of the threshold", () => {
    const result = decideGoalTransition(baseState({ greenCount: 3, checkThreshold: 5 }), {
      outcome: "green",
      costUsd: 0,
    });
    expect(result.action).toBe("refill");
  });

  it("reached takes priority over leash when both are satisfied by the same event", () => {
    const result = decideGoalTransition(
      baseState({
        greenCount: 4,
        checkThreshold: 5,
        issuesFiled: 10,
        maxIssues: 10,
      }),
      { outcome: "green", costUsd: 0 }
    );
    expect(result.action).toBe("reached");
    expect(result.nextStatus).toBe("reached");
  });

  it("a command-type goal never auto-reaches via this function (v1 scope cut, not a safety gap — leash/stuck still bound it)", () => {
    const result = decideGoalTransition(
      baseState({ checkType: "command", checkThreshold: null, greenCount: 999 }),
      { outcome: "green", costUsd: 0 }
    );
    expect(result.action).toBe("refill");
  });

  it("a metric goal with no threshold configured never auto-reaches (defensive: null threshold is not '>= anything')", () => {
    const result = decideGoalTransition(
      baseState({ checkType: "metric", checkThreshold: null, greenCount: 999 }),
      { outcome: "green", costUsd: 0 }
    );
    expect(result.action).toBe("refill");
  });
});

describe("decideGoalTransition — terminal safety net (never loops forever)", () => {
  it.each(["reached", "leashed", "paused", "abandoned"] as const)(
    "a %s goal is noop for ANY further event and every counter freezes verbatim",
    (status) => {
      const state = baseState({
        status,
        issuesFiled: 7,
        spendUsd: 12.34,
        consecutiveNonGreen: 1,
        greenCount: 2,
      });
      const result = decideGoalTransition(state, { outcome: "green", costUsd: 999 });
      expect(result.action).toBe("noop");
      expect(result.nextStatus).toBe(status);
      expect(result.issuesFiledAfter).toBe(7);
      expect(result.spendUsdAfter).toBe(12.34);
      expect(result.consecutiveNonGreenAfter).toBe(1);
      expect(result.greenCountAfter).toBe(2);
    }
  );

  it("a huge cost on a terminal goal never mutates spend (freeze is absolute, not just 'small' events)", () => {
    const result = decideGoalTransition(baseState({ status: "leashed", spendUsd: 50 }), {
      outcome: "blocked",
      costUsd: 1_000_000,
    });
    expect(result.spendUsdAfter).toBe(50);
    expect(result.action).toBe("noop");
  });

  it("simulating a goal that NEVER reaches its check across 1000 non-green events terminates at the stuck threshold, not at event 1000", () => {
    let status: GoalLeashState["status"] = "active";
    let consecutiveNonGreen = 0;
    let issuesFiled = 0;
    let spendUsd = 0;
    let greenCount = 0;
    let transitionsAfterTerminal = 0;
    let terminalAtEvent = -1;

    for (let i = 0; i < 1000; i++) {
      const result = decideGoalTransition(
        {
          status,
          maxIssues: 1000, // leash deliberately loose so ONLY the stuck rule can stop this
          maxSpendUsd: 1_000_000,
          issuesFiled,
          spendUsd,
          stuckThreshold: 2,
          consecutiveNonGreen,
          checkType: "metric",
          checkThreshold: 999999, // unreachable — this goal NEVER completes its check
          greenCount,
        },
        { outcome: "blocked", costUsd: 0.01 }
      );

      if (status !== "active" && result.action !== "noop") {
        transitionsAfterTerminal++;
      }
      if (status === "active" && result.nextStatus !== "active" && terminalAtEvent === -1) {
        terminalAtEvent = i;
      }

      status = result.nextStatus;
      consecutiveNonGreen = result.consecutiveNonGreenAfter;
      spendUsd = result.spendUsdAfter;
      greenCount = result.greenCountAfter;
      if (result.action === "refill") issuesFiled++; // only a refill files another issue
    }

    // Proves the bound: an unreachable-check goal fed nothing but bad news
    // stops at the stuck threshold (its 2nd non-green outcome), not at
    // event 1000 — and NEVER transitions again after that.
    expect(terminalAtEvent).toBe(1);
    expect(status).toBe("paused");
    expect(transitionsAfterTerminal).toBe(0);
  });
});

describe("canFileNextIssue", () => {
  it("allows filing while the leash has room and the goal is active", () => {
    const result = canFileNextIssue({
      status: "active",
      issuesFiled: 3,
      maxIssues: 10,
      spendUsd: 5,
      maxSpendUsd: 50,
    });
    expect(result.allow).toBe(true);
  });

  it("refuses at exactly maxIssues", () => {
    const result = canFileNextIssue({
      status: "active",
      issuesFiled: 10,
      maxIssues: 10,
      spendUsd: 0,
      maxSpendUsd: 50,
    });
    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/issues filed 10\/10/);
  });

  it("refuses at exactly maxSpendUsd", () => {
    const result = canFileNextIssue({
      status: "active",
      issuesFiled: 0,
      maxIssues: 10,
      spendUsd: 50,
      maxSpendUsd: 50,
    });
    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/spend \$50/);
  });

  it.each(["reached", "leashed", "paused", "abandoned"] as const)(
    "refuses for a %s (non-active) goal even with leash room left",
    (status) => {
      const result = canFileNextIssue({
        status,
        issuesFiled: 0,
        maxIssues: 10,
        spendUsd: 0,
        maxSpendUsd: 50,
      });
      expect(result.allow).toBe(false);
    }
  );
});
