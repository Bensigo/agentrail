import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@agentrail/db-postgres", () => ({
  completeOwnerElectWorkspace: vi.fn(),
  getWorkspace: vi.fn(),
}));

import {
  completeConnectOwnerElect,
  buildOwnerElectCompletionLine,
  type OwnerElectCompletionResult,
} from "./connect-owner-elect-completion";
import { completeOwnerElectWorkspace, getWorkspace } from "@agentrail/db-postgres";

const mockComplete = vi.mocked(completeOwnerElectWorkspace);
const mockGetWorkspace = vi.mocked(getWorkspace);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("completeConnectOwnerElect", () => {
  it("workspaceId null: nothing to complete — skips both db calls entirely", async () => {
    const result = await completeConnectOwnerElect({ workspaceId: null, userId: "user-1" });

    expect(result).toEqual({ completed: false, workspaceName: null });
    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockGetWorkspace).not.toHaveBeenCalled();
  });

  it("calls completeOwnerElectWorkspace with the exact {workspaceId, userId} pair", async () => {
    mockComplete.mockResolvedValue({ completed: false });

    await completeConnectOwnerElect({ workspaceId: "ws-1", userId: "user-1" });

    expect(mockComplete).toHaveBeenCalledWith({ workspaceId: "ws-1", userId: "user-1" });
  });

  it("completed:false (workspace already had an owner, or nothing to complete): does NOT look up the workspace name", async () => {
    mockComplete.mockResolvedValue({ completed: false });

    const result = await completeConnectOwnerElect({ workspaceId: "ws-owned", userId: "user-1" });

    expect(result).toEqual({ completed: false, workspaceName: null });
    expect(mockGetWorkspace).not.toHaveBeenCalled();
  });

  it("completed:true: looks up the workspace by the SAME id and returns its name", async () => {
    mockComplete.mockResolvedValue({ completed: true });
    mockGetWorkspace.mockResolvedValue({
      id: "ws-1",
      name: "Acme",
      slug: "acme",
      createdAt: new Date("2026-07-18T00:00:00Z"),
      updatedAt: new Date("2026-07-18T00:00:00Z"),
      baselineWindowDays: 30,
      discordWebhookUrl: null,
      hostedExecution: true,
      monthlyBudgetUsd: null,
      budgetExhaustedNotifiedPeriod: null,
      mergePermission: false,
      requireAlignment: true,
      jaceGoalLoop: false,
    });

    const result = await completeConnectOwnerElect({ workspaceId: "ws-1", userId: "user-1" });

    expect(mockGetWorkspace).toHaveBeenCalledWith("ws-1");
    expect(result).toEqual({ completed: true, workspaceName: "Acme" });
  });

  it("completed:true but the workspace lookup returns null (defensive — should be unreachable given FK integrity): completed stays true, name falls back to null", async () => {
    mockComplete.mockResolvedValue({ completed: true });
    // getWorkspace's inferred return type doesn't admit `null` even though
    // its real implementation returns `rows[0] ?? null` (a pre-existing gap
    // in that function's type inference, out of scope here) — `as never`
    // is this codebase's established workaround (see e.g.
    // app/api/v1/context/memory-items/route.test.ts).
    mockGetWorkspace.mockResolvedValue(null as never);

    const result = await completeConnectOwnerElect({ workspaceId: "ws-1", userId: "user-1" });

    expect(result).toEqual({ completed: true, workspaceName: null });
  });

  it("completeOwnerElectWorkspace throws: swallows the error, logs it with context, never rejects, reports completed:false", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockComplete.mockRejectedValue(new Error("connection reset"));

    await expect(
      completeConnectOwnerElect({ workspaceId: "ws-1", userId: "user-1" })
    ).resolves.toEqual({ completed: false, workspaceName: null });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("completeOwnerElectWorkspace"),
      expect.objectContaining({ workspaceId: "ws-1", userId: "user-1" })
    );
    expect(mockGetWorkspace).not.toHaveBeenCalled();
  });

  it("completeOwnerElectWorkspace succeeds but getWorkspace throws: ownership genuinely happened, so completed stays true — only the name is lost, logged with context", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockComplete.mockResolvedValue({ completed: true });
    mockGetWorkspace.mockRejectedValue(new Error("connection reset"));

    await expect(
      completeConnectOwnerElect({ workspaceId: "ws-1", userId: "user-1" })
    ).resolves.toEqual({ completed: true, workspaceName: null });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("getWorkspace"),
      expect.objectContaining({ workspaceId: "ws-1", userId: "user-1" })
    );
  });

  it("a different (workspaceId, userId) pair passes that exact pair, not a stale one", async () => {
    mockComplete.mockResolvedValue({ completed: false });

    await completeConnectOwnerElect({ workspaceId: "ws-2", userId: "user-2" });

    expect(mockComplete).toHaveBeenCalledWith({ workspaceId: "ws-2", userId: "user-2" });
  });
});

describe("buildOwnerElectCompletionLine", () => {
  const CASES: Array<{
    name: string;
    input: OwnerElectCompletionResult;
    expected: string | null;
  }> = [
    {
      name: "completed:false, no name — nothing to complete or already owned: no line",
      input: { completed: false, workspaceName: null },
      expected: null,
    },
    {
      name: "completed:false even with a stray name (defensive — shouldn't happen): still no line, completed is the gate",
      input: { completed: false, workspaceName: "Acme" },
      expected: null,
    },
    {
      name: "completed:true with a name: plain ownership line naming the workspace",
      input: { completed: true, workspaceName: "Acme" },
      expected: "You now own Acme.",
    },
    {
      name: "completed:true with no name (name lookup failed): generic fallback, never blank, never an error",
      input: { completed: true, workspaceName: null },
      expected: "You now own this workspace.",
    },
  ];

  for (const { name, input, expected } of CASES) {
    it(name, () => {
      expect(buildOwnerElectCompletionLine(input)).toBe(expected);
    });
  }

  it("is plain text, no markdown", () => {
    const line = buildOwnerElectCompletionLine({ completed: true, workspaceName: "Acme" });
    expect(line).not.toMatch(/[*_`[\]]/);
  });
});
