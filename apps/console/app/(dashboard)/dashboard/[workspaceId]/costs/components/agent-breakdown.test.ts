import { describe, expect, it } from "vitest";
import {
  buildSavingsUrl,
  deriveAgentRow,
  formatAgentCost,
  formatAgentSavings,
  normalizeAgentBreakdown,
  type AgentBreakdownEntry,
} from "./agent-breakdown-helpers";

describe("normalizeAgentBreakdown", () => {
  it("always returns exactly three rows in claude/codex/cursor order", () => {
    const raw: AgentBreakdownEntry[] = [
      { agent: "cursor", totalCostUsd: 1.5, dollarsSaved: 0.3, eventCount: 5 },
      { agent: "claude", totalCostUsd: 2.0, dollarsSaved: 0.8, eventCount: 10 },
      // codex absent
    ];

    const result = normalizeAgentBreakdown(raw);

    expect(result).toHaveLength(3);
    expect(result[0].agent).toBe("claude");
    expect(result[1].agent).toBe("codex");
    expect(result[2].agent).toBe("cursor");
  });

  it("fills absent agents with zero eventCount row", () => {
    const raw: AgentBreakdownEntry[] = [
      { agent: "claude", totalCostUsd: 1.0, dollarsSaved: 0.2, eventCount: 3 },
    ];

    const result = normalizeAgentBreakdown(raw);
    const codex = result.find((r) => r.agent === "codex");
    const cursor = result.find((r) => r.agent === "cursor");

    expect(codex).toBeDefined();
    expect(codex!.eventCount).toBe(0);
    expect(codex!.totalCostUsd).toBe(0);

    expect(cursor).toBeDefined();
    expect(cursor!.eventCount).toBe(0);
  });

  it("returns all three zero rows when raw is empty", () => {
    const result = normalizeAgentBreakdown([]);

    expect(result).toHaveLength(3);
    expect(result.every((r) => r.eventCount === 0)).toBe(true);
    expect(result.map((r) => r.agent)).toEqual(["claude", "codex", "cursor"]);
  });

  it("preserves existing entries including all three agents", () => {
    const raw: AgentBreakdownEntry[] = [
      { agent: "claude", totalCostUsd: 1.0, dollarsSaved: 0.2, eventCount: 3 },
      { agent: "codex", totalCostUsd: 0.5, dollarsSaved: 0.1, eventCount: 2 },
      { agent: "cursor", totalCostUsd: 0.8, dollarsSaved: 0.15, eventCount: 4 },
    ];

    const result = normalizeAgentBreakdown(raw);

    expect(result[0].totalCostUsd).toBe(1.0);
    expect(result[1].totalCostUsd).toBe(0.5);
    expect(result[2].totalCostUsd).toBe(0.8);
  });
});

describe("deriveAgentRow — zero-row muted state", () => {
  it("returns muted=true and — for cost/savings when eventCount is 0", () => {
    const entry: AgentBreakdownEntry = {
      agent: "codex",
      totalCostUsd: 0,
      dollarsSaved: 0,
      eventCount: 0,
    };

    const row = deriveAgentRow(entry);

    expect(row.muted).toBe(true);
    expect(row.cost).toBe("—");
    expect(row.savings).toBe("—");
    expect(row.eventCount).toBe(0);
    expect(row.agent).toBe("codex");
  });

  it("returns muted=false with formatted values when eventCount > 0", () => {
    const entry: AgentBreakdownEntry = {
      agent: "claude",
      totalCostUsd: 1.2345,
      dollarsSaved: 0.42,
      eventCount: 7,
    };

    const row = deriveAgentRow(entry);

    expect(row.muted).toBe(false);
    expect(row.cost).toBe("$1.2345");
    expect(row.savings).toBe("~$0.42");
    expect(row.eventCount).toBe(7);
  });

  it("savings always carries ~ estimate marker when non-zero", () => {
    const entry: AgentBreakdownEntry = {
      agent: "cursor",
      totalCostUsd: 0.5,
      dollarsSaved: 0.125,
      eventCount: 2,
    };

    const row = deriveAgentRow(entry);

    expect(row.savings.startsWith("~")).toBe(true);
  });
});

describe("formatAgentCost", () => {
  it("formats zero as $0.0000", () => {
    expect(formatAgentCost(0)).toBe("$0.0000");
  });

  it("formats very small values with 6 decimal places", () => {
    expect(formatAgentCost(0.000001)).toBe("$0.000001");
  });

  it("formats normal values with 4 decimal places", () => {
    expect(formatAgentCost(3.14159)).toBe("$3.1416");
  });
});

describe("formatAgentSavings", () => {
  it("formats zero as ~$0.00", () => {
    expect(formatAgentSavings(0)).toBe("~$0.00");
  });

  it("formats positive savings with ~ prefix and 2 decimal places", () => {
    expect(formatAgentSavings(1.5)).toBe("~$1.50");
    expect(formatAgentSavings(0.1234)).toBe("~$0.12");
  });
});

describe("buildSavingsUrl", () => {
  it("builds URL without time params when timeRange is empty", () => {
    const url = buildSavingsUrl({
      workspaceId: "ws-1",
      origin: "http://localhost",
      timeRange: "",
    });

    expect(url).toBe(
      "http://localhost/api/v1/workspaces/ws-1/costs/savings"
    );
  });

  it("builds URL with time_from and time_to when timeRange is set", () => {
    const url = buildSavingsUrl({
      workspaceId: "ws-1",
      origin: "http://localhost",
      timeRange: "24h",
      now: new Date("2026-06-15T10:00:00.000Z"),
    });

    expect(url).toBe(
      "http://localhost/api/v1/workspaces/ws-1/costs/savings?time_from=2026-06-14T10%3A00%3A00.000Z&time_to=2026-06-15T10%3A00%3A00.000Z"
    );
  });
});

describe("error state helper coverage", () => {
  it("deriveAgentRow handles non-zero totalCostUsd with eventCount=0 as muted", () => {
    // Edge case: API could theoretically return cost > 0 with eventCount = 0
    // We treat eventCount as the authoritative zero-state signal per AC2
    const entry: AgentBreakdownEntry = {
      agent: "cursor",
      totalCostUsd: 0.5,
      dollarsSaved: 0,
      eventCount: 0,
    };

    const row = deriveAgentRow(entry);

    expect(row.muted).toBe(true);
    expect(row.cost).toBe("—");
    expect(row.savings).toBe("—");
  });
});
