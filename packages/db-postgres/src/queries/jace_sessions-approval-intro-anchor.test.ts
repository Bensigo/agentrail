import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocked db chain: same "mock the chain, control the terminal value"
// approach as jace_sessions-intro-anchor.test.ts / chat_identities.test.ts.
vi.mock("../db.js", () => ({
  db: {
    insert: vi.fn(),
  },
}));

import { db } from "../db.js";
import { recordApprovalRequest } from "./jace_sessions.js";

const mockDb = vi.mocked(db);

/** A chainable mock: every method returns the chain except `terminalMethod`, which resolves `finalValue`. */
function makeChain(terminalMethod: string, finalValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ["values"];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain[terminalMethod] = vi.fn(() => Promise.resolve(finalValue));
  return chain;
}

const BASE_INPUT = {
  sessionId: "session-1",
  eveSessionId: "eve-session-1",
  requestId: "req-1",
  toolName: "create_issue",
  toolInput: { title: "x" },
  approveOptionId: "approve",
  denyOptionId: "deny",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("recordApprovalRequest — intro-anchor optionality (#1273)", () => {
  it("throws before the INSERT when neither workspaceId nor chatIdentityId is provided", async () => {
    await expect(recordApprovalRequest({ ...BASE_INPUT })).rejects.toThrow(
      /recordApprovalRequest: requires either workspaceId or chatIdentityId/
    );
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("inserts an intro approval anchored on chatIdentityId alone (workspaceId omitted)", async () => {
    const returnedRow = {
      id: "approval-1",
      workspaceId: null,
      chatIdentityId: "chat-identity-1",
      sessionId: "session-1",
      eveSessionId: "eve-session-1",
      requestId: "req-1",
      callbackToken: "abc123",
      toolName: "create_workspace",
      toolInput: { name: "Acme" },
      approveOptionId: "approve",
      denyOptionId: "deny",
      status: "pending",
      publishedIssueUrl: null,
      createdAt: new Date("2026-07-18T00:00:00Z"),
      resolvedAt: null,
    };
    const insertChain = makeChain("returning", [returnedRow]);
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);

    const result = await recordApprovalRequest({
      ...BASE_INPUT,
      toolName: "create_workspace",
      toolInput: { name: "Acme" },
      chatIdentityId: "chat-identity-1",
    });

    expect(result).toEqual(returnedRow);
    const valuesArgs = (insertChain.values as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(valuesArgs.chatIdentityId).toBe("chat-identity-1");
    expect(valuesArgs.workspaceId).toBeUndefined();
  });

  it("still inserts a workspace-anchored approval when only workspaceId is provided (pre-#1273 shape unchanged)", async () => {
    const returnedRow = {
      id: "approval-2",
      workspaceId: "ws-1",
      chatIdentityId: null,
      sessionId: "session-1",
      eveSessionId: "eve-session-1",
      requestId: "req-1",
      callbackToken: "def456",
      toolName: "create_issue",
      toolInput: { title: "x" },
      approveOptionId: "approve",
      denyOptionId: "deny",
      status: "pending",
      publishedIssueUrl: null,
      createdAt: new Date("2026-07-18T00:00:00Z"),
      resolvedAt: null,
    };
    const insertChain = makeChain("returning", [returnedRow]);
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);

    const result = await recordApprovalRequest({
      ...BASE_INPUT,
      workspaceId: "ws-1",
    });

    expect(result).toEqual(returnedRow);
    const valuesArgs = (insertChain.values as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(valuesArgs.workspaceId).toBe("ws-1");
    expect(valuesArgs.chatIdentityId).toBeUndefined();
  });

  it("passes BOTH anchors through when the caller supplies both (graduated session, identity known for the sender check)", async () => {
    const returnedRow = {
      id: "approval-3",
      workspaceId: "ws-1",
      chatIdentityId: "chat-identity-1",
      sessionId: "session-1",
      eveSessionId: "eve-session-1",
      requestId: "req-1",
      callbackToken: "ghi789",
      toolName: "create_repo",
      toolInput: { name: "acme-repo" },
      approveOptionId: "approve",
      denyOptionId: "deny",
      status: "pending",
      publishedIssueUrl: null,
      createdAt: new Date("2026-07-18T00:00:00Z"),
      resolvedAt: null,
    };
    const insertChain = makeChain("returning", [returnedRow]);
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);

    const result = await recordApprovalRequest({
      ...BASE_INPUT,
      workspaceId: "ws-1",
      chatIdentityId: "chat-identity-1",
    });

    expect(result).toEqual(returnedRow);
    const valuesArgs = (insertChain.values as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(valuesArgs.workspaceId).toBe("ws-1");
    expect(valuesArgs.chatIdentityId).toBe("chat-identity-1");
  });

  it("throws a prefixed error when the insert returns no row (unreachable in practice)", async () => {
    const insertChain = makeChain("returning", []);
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);

    await expect(
      recordApprovalRequest({ ...BASE_INPUT, workspaceId: "ws-1" })
    ).rejects.toThrow(
      /recordApprovalRequest: insert returned no row for session session-1 request req-1/
    );
  });
});
