import { describe, it, expect } from "vitest";
import {
  buildOutcomeMessage,
  parseOutcomeIssueNumber,
  buildRunOutcomeReplyPreface,
  type OutcomeMessageParams,
  type NotifyOutcome,
} from "./outcome-format";

describe("buildOutcomeMessage — byte-identical regression pin (#1277 AC2)", () => {
  it("green, with PR + cost — exact literal text", () => {
    const msg = buildOutcomeMessage({
      issueNumber: "42",
      outcome: "green",
      prUrl: "https://github.com/o/r/pull/9",
      costUsd: 1.2,
    });
    expect(msg).toBe(
      "AgentRail: PR ready — issue #42 (https://github.com/o/r/pull/9 · $1.20)"
    );
  });

  it("green, no extras — exact literal text", () => {
    expect(buildOutcomeMessage({ issueNumber: "7", outcome: "green" })).toBe(
      "AgentRail: PR ready — issue #7"
    );
  });

  it("escalated-to-human — exact literal text", () => {
    expect(
      buildOutcomeMessage({ issueNumber: "1", outcome: "escalated-to-human" })
    ).toBe("AgentRail: Escalated to human — issue #1");
  });

  it("blocked — exact literal text", () => {
    expect(buildOutcomeMessage({ issueNumber: "1", outcome: "blocked" })).toBe(
      "AgentRail: Blocked — issue #1"
    );
  });

  it("cost only, no PR — exact literal text", () => {
    expect(
      buildOutcomeMessage({ issueNumber: "5", outcome: "green", costUsd: 0.5 })
    ).toBe("AgentRail: PR ready — issue #5 ($0.50)");
  });
});

describe("buildOutcomeMessage — opts.hideCost (subscription platform Task 3)", () => {
  it("hideCost: true drops the ' · $X.XX' segment when both PR + cost are present — PR link stays", () => {
    const msg = buildOutcomeMessage(
      {
        issueNumber: "42",
        outcome: "green",
        prUrl: "https://github.com/o/r/pull/9",
        costUsd: 1.2,
      },
      { hideCost: true }
    );
    expect(msg).toBe("AgentRail: PR ready — issue #42 (https://github.com/o/r/pull/9)");
  });

  it("hideCost: true with cost as the ONLY extra — no parens at all (not an empty '()')", () => {
    const msg = buildOutcomeMessage(
      { issueNumber: "5", outcome: "green", costUsd: 0.5 },
      { hideCost: true }
    );
    expect(msg).toBe("AgentRail: PR ready — issue #5");
  });

  it("hideCost: true with no extras to begin with — unaffected", () => {
    const msg = buildOutcomeMessage(
      { issueNumber: "7", outcome: "green" },
      { hideCost: true }
    );
    expect(msg).toBe("AgentRail: PR ready — issue #7");
  });

  it("hideCost: false is byte-identical to opts omitted entirely", () => {
    const params = {
      issueNumber: "42",
      outcome: "green" as const,
      prUrl: "https://github.com/o/r/pull/9",
      costUsd: 1.2,
    };
    expect(buildOutcomeMessage(params, { hideCost: false })).toBe(
      buildOutcomeMessage(params)
    );
  });

  it("opts omitted (undefined) is byte-identical to the pre-Task-3 shape — otherwise byte-identical output, per the binding constraint", () => {
    expect(
      buildOutcomeMessage({
        issueNumber: "42",
        outcome: "green",
        prUrl: "https://github.com/o/r/pull/9",
        costUsd: 1.2,
      })
    ).toBe("AgentRail: PR ready — issue #42 (https://github.com/o/r/pull/9 · $1.20)");
  });

  it("passing {} (no hideCost key) behaves exactly like opts omitted", () => {
    const params = {
      issueNumber: "5",
      outcome: "green" as const,
      costUsd: 0.5,
    };
    expect(buildOutcomeMessage(params, {})).toBe(buildOutcomeMessage(params));
  });

  it("hideCost round-trips through parseOutcomeIssueNumber just like the cost-bearing shape", () => {
    const text = buildOutcomeMessage(
      {
        issueNumber: "123",
        outcome: "escalated-to-human",
        prUrl: "https://github.com/o/r/pull/9",
        costUsd: 3.45,
      },
      { hideCost: true }
    );
    expect(parseOutcomeIssueNumber(text)).toBe(123);
  });

  it("is a PURE function of its arguments — never reads process.env, even when BILLING_SUBSCRIPTIONS_ENFORCED is set", () => {
    const params = {
      issueNumber: "42",
      outcome: "green" as const,
      prUrl: "https://github.com/o/r/pull/9",
      costUsd: 1.2,
    };
    const before = process.env["BILLING_SUBSCRIPTIONS_ENFORCED"];
    try {
      // The env var alone must have ZERO effect: no opts -> cost still shows.
      process.env["BILLING_SUBSCRIPTIONS_ENFORCED"] = "1";
      expect(buildOutcomeMessage(params)).toBe(
        "AgentRail: PR ready — issue #42 (https://github.com/o/r/pull/9 · $1.20)"
      );
      // And an explicit hideCost: false still shows cost even with the env
      // var set — only the PARAMETER controls the output, never the env.
      expect(buildOutcomeMessage(params, { hideCost: false })).toBe(
        "AgentRail: PR ready — issue #42 (https://github.com/o/r/pull/9 · $1.20)"
      );
    } finally {
      if (before === undefined) delete process.env["BILLING_SUBSCRIPTIONS_ENFORCED"];
      else process.env["BILLING_SUBSCRIPTIONS_ENFORCED"] = before;
    }
  });
});

describe("parseOutcomeIssueNumber — round-trip drift guard (#1277)", () => {
  const OUTCOMES: NotifyOutcome[] = ["green", "escalated-to-human", "blocked"];
  const SHAPES: Array<Omit<OutcomeMessageParams, "issueNumber" | "outcome">> = [
    {},
    { prUrl: "https://github.com/o/r/pull/9" },
    { costUsd: 1.2 },
    { prUrl: "https://github.com/o/r/pull/9", costUsd: 3.45 },
    // #1278: the console-merged headline ("Merged") must round-trip too —
    // merged is only meaningful on green, but the builder must stay
    // parseable for every combination it can emit.
    { merged: true },
    { merged: true, prUrl: "https://github.com/o/r/pull/9", costUsd: 3.45 },
  ];

  for (const outcome of OUTCOMES) {
    for (const shape of SHAPES) {
      const label = `${outcome} ${JSON.stringify(shape)}`;
      it(`builder output round-trips back to its issue number — ${label}`, () => {
        const params: OutcomeMessageParams = { issueNumber: "123", outcome, ...shape };
        const text = buildOutcomeMessage(params);
        expect(parseOutcomeIssueNumber(text)).toBe(123);
      });
    }
  }

  it("round-trips a multi-digit issue number without truncation (greedy digit capture)", () => {
    const text = buildOutcomeMessage({ issueNumber: "101", outcome: "green" });
    expect(parseOutcomeIssueNumber(text)).toBe(101);
    expect(parseOutcomeIssueNumber(text)).not.toBe(10);
  });
});

describe("parseOutcomeIssueNumber — strict negatives", () => {
  it("rejects plain unrelated text", () => {
    expect(parseOutcomeIssueNumber("hey, how's it going?")).toBeNull();
  });

  it("rejects text missing the AgentRail prefix", () => {
    expect(parseOutcomeIssueNumber("PR ready — issue #42")).toBeNull();
  });

  it("rejects a non-numeric suffix after 'issue #'", () => {
    expect(parseOutcomeIssueNumber("AgentRail: PR ready — issue #abc")).toBeNull();
  });

  it("rejects trailing junk after the number that isn't the '(...)' extras group", () => {
    expect(
      parseOutcomeIssueNumber("AgentRail: PR ready — issue #42 pwned")
    ).toBeNull();
  });

  it("rejects an empty issue number (no digits at all)", () => {
    expect(parseOutcomeIssueNumber("AgentRail: PR ready — issue #")).toBeNull();
  });

  it("rejects the empty string", () => {
    expect(parseOutcomeIssueNumber("")).toBeNull();
  });

  it("rejects a hyphen stand-in for the em dash (must be the exact '—' character)", () => {
    expect(parseOutcomeIssueNumber("AgentRail: PR ready - issue #42")).toBeNull();
  });

  it("accepts the real template with extras, parsing the correct number", () => {
    expect(
      parseOutcomeIssueNumber(
        "AgentRail: Escalated to human — issue #99 (https://github.com/o/r/pull/3 · $2.00)"
      )
    ).toBe(99);
  });

  it("a lookalike/forged message in our exact format still parses (format-only check — see threat-model note; safety comes from the workspace-scoped query, not the parser)", () => {
    expect(
      parseOutcomeIssueNumber("AgentRail: PR ready — issue #999999")
    ).toBe(999999);
  });
});

describe("buildRunOutcomeReplyPreface", () => {
  it("renders the found-run shape", () => {
    expect(
      buildRunOutcomeReplyPreface(42, { runId: "run-abc", state: "failed" })
    ).toBe(
      "[reply to the run-outcome notification for issue #42 — latest run: run-abc, state: failed]"
    );
  });

  it("renders an honest not-found message rather than fabricating one", () => {
    expect(buildRunOutcomeReplyPreface(42, null)).toBe(
      "[reply to the run-outcome notification for issue #42 — no matching run found]"
    );
  });
});
