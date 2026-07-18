import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

// workspaceHasExecutionPath composes two ALREADY-tested reads (getWorkspace +
// hasActiveSelfHostedRunner) defined in the SAME module and called there by
// plain lexical reference — mocking this module's own exports from outside
// would not intercept those internal self-calls (a well-known ESM
// self-import limitation), so this suite mocks `../db.js` directly (same
// approach as has-active-self-hosted-runner.test.ts) and lets both real
// functions run against it.
//
// `Promise.all([getWorkspace(id), hasActiveSelfHostedRunner(id)])` evaluates
// its array left-to-right synchronously, so the first `db.select()` call
// observed is always getWorkspace's and the second is always
// hasActiveSelfHostedRunner's — deterministic call order, not a race.
const mockState = vi.hoisted(() => ({
  calls: [] as Array<unknown>,
  responses: [] as unknown[][],
}));

vi.mock("../db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          const callIndex = mockState.calls.length;
          mockState.calls.push(cond);
          return {
            limit: async () => mockState.responses[callIndex] ?? [],
          };
        },
      }),
    }),
  },
}));

import { workspaceHasExecutionPath } from "../queries/index.js";

const dialect = new PgDialect();
function render(condition: unknown) {
  return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
}

beforeEach(() => {
  mockState.calls = [];
  mockState.responses = [];
});

describe("workspaceHasExecutionPath — race-free onboard-enqueue gate (#1268)", () => {
  it("is true when hostedExecution=true and no self-hosted runner is active", async () => {
    mockState.responses = [
      [{ id: "ws-1", hostedExecution: true }], // getWorkspace
      [], // hasActiveSelfHostedRunner
    ];
    expect(await workspaceHasExecutionPath("ws-1")).toBe(true);
  });

  it("is true when hostedExecution=false but a self-hosted runner is active", async () => {
    mockState.responses = [
      [{ id: "ws-1", hostedExecution: false }],
      [{ id: "key-1" }],
    ];
    expect(await workspaceHasExecutionPath("ws-1")).toBe(true);
  });

  it("is true when BOTH hostedExecution=true and a self-hosted runner is active", async () => {
    mockState.responses = [
      [{ id: "ws-1", hostedExecution: true }],
      [{ id: "key-1" }],
    ];
    expect(await workspaceHasExecutionPath("ws-1")).toBe(true);
  });

  it("is false when hostedExecution=false and no self-hosted runner is active", async () => {
    mockState.responses = [
      [{ id: "ws-1", hostedExecution: false }],
      [],
    ];
    expect(await workspaceHasExecutionPath("ws-1")).toBe(false);
  });

  it("defensively is false when the workspace row itself doesn't exist", async () => {
    mockState.responses = [[], []];
    expect(await workspaceHasExecutionPath("ws-missing")).toBe(false);
  });

  it("passes the SAME workspaceId to both underlying queries", async () => {
    mockState.responses = [
      [{ id: "ws-9", hostedExecution: true }],
      [],
    ];
    await workspaceHasExecutionPath("ws-9");

    expect(mockState.calls).toHaveLength(2);
    const [workspaceWhere, selfHostedWhere] = mockState.calls;
    expect(render(workspaceWhere).params).toContain("ws-9");
    expect(render(selfHostedWhere).params).toContain("ws-9");
  });
});
