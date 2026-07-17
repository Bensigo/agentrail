import { describe, it, expect, beforeEach, vi } from "vitest";

// Mocked db chain, matching has-active-runner.test.ts's style: a hoisted
// mutable holder feeds the terminal chain method (`orderBy`) so the test
// controls exactly what the "query" returns without a live Postgres.
const mockState = vi.hoisted(() => ({
  rows: [] as unknown[],
}));

vi.mock("../db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            orderBy: async () => mockState.rows,
          }),
        }),
      }),
    }),
  },
}));

import { pendingApprovalsForWorkspace } from "./jace_sessions.js";

describe("pendingApprovalsForWorkspace", () => {
  beforeEach(() => {
    mockState.rows = [];
  });

  it("returns pending approvals joined with the owning session's channel/conversationKey", async () => {
    const createdAt = new Date("2026-07-01T00:00:00Z");
    mockState.rows = [
      {
        id: "appr-1",
        toolName: "create_issue",
        toolInput: { title: "x" },
        approveOptionId: "approve",
        denyOptionId: "deny",
        channel: "telegram",
        conversationKey: "chat-1",
        createdAt,
      },
    ];

    const result = await pendingApprovalsForWorkspace("ws-1");

    expect(result).toEqual(mockState.rows);
  });

  it("returns an empty array when the workspace has no pending approvals", async () => {
    mockState.rows = [];

    const result = await pendingApprovalsForWorkspace("ws-1");

    expect(result).toEqual([]);
  });
});
