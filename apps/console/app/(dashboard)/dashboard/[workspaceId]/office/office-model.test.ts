import { describe, it, expect } from "vitest";
import {
  recentlyReporting,
  usageSubtotal,
  type OfficeTask,
} from "./office-model";
const now = Date.parse("2026-11-09T12:00:00Z");
const task = (overrides: Partial<OfficeTask> = {}): OfficeTask => ({
  id: "a",
  agent: "Shared agent label",
  title: "Work",
  branch: "main",
  phase: "implementing",
  summary: "Building",
  revision: 1,
  repository_name: "owner/repo",
  updated_at: new Date(now).toISOString(),
  reported_at: new Date(now - 30000).toISOString(),
  reported_phase: "implementing",
  context_at: null,
  usage_at: null,
  context: null,
  usage: null,
  ...overrides,
});
describe("Office report interpretation", () => {
  it("distinguishes known zero, unknown costs and one cumulative snapshot per task", () => {
    expect(
      usageSubtotal([
        task({ usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 } }),
        task({
          id: "b",
          usage: { costUsd: 1.5, inputTokens: 20, outputTokens: 10 },
        }),
        task({ id: "c" }),
      ]),
    ).toEqual({ usd: 1.5, known: 2, unknown: 1 });
  });
  it("does not turn a fresh human edit or waiting state into agent activity", () => {
    expect(recentlyReporting(task(), now)).toBe(true);
    expect(
      recentlyReporting(
        task({ reported_at: new Date(now - 180000).toISOString() }),
        now,
      ),
    ).toBe(false);
    for (const phase of ["closed", "blocked", "needs_review"])
      expect(recentlyReporting(task({ phase }), now)).toBe(false);
    expect(recentlyReporting(task({ reported_at: null }), now)).toBe(false);
    expect(
      recentlyReporting(
        task({ phase: "planning", reported_phase: "needs_review" }),
        now,
      ),
    ).toBe(false);
  });
});
