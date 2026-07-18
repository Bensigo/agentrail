import { describe, it, expect } from "vitest";
import { decideConnectWorkspaceBind } from "./connect-bind-decision";

describe("decideConnectWorkspaceBind", () => {
  it("binds to the sole membership when the identity has no workspace yet", () => {
    const result = decideConnectWorkspaceBind({
      identity: { workspaceId: null },
      memberships: [{ id: "ws-1", name: "Acme" }],
    });

    expect(result).toEqual({
      action: "bind",
      workspace: { id: "ws-1", name: "Acme" },
    });
  });

  it("skips (leaves null) when the user has zero workspace memberships", () => {
    const result = decideConnectWorkspaceBind({
      identity: { workspaceId: null },
      memberships: [],
    });

    expect(result).toEqual({ action: "skip", reason: "no_memberships" });
  });

  it("skips (leaves null) when the user belongs to 2+ workspaces — ambiguous, no auto-pick", () => {
    const result = decideConnectWorkspaceBind({
      identity: { workspaceId: null },
      memberships: [
        { id: "ws-1", name: "Acme" },
        { id: "ws-2", name: "Beta Corp" },
      ],
    });

    expect(result).toEqual({ action: "skip", reason: "ambiguous_memberships" });
  });

  it("skips when the identity already has a workspace_id, even if the user has exactly one membership", () => {
    const result = decideConnectWorkspaceBind({
      identity: { workspaceId: "ws-already-bound" },
      memberships: [{ id: "ws-1", name: "Acme" }],
    });

    expect(result).toEqual({ action: "skip", reason: "already_bound" });
  });

  it("skips (already_bound) even with zero memberships, when the identity already has a workspace_id", () => {
    const result = decideConnectWorkspaceBind({
      identity: { workspaceId: "ws-already-bound" },
      memberships: [],
    });

    expect(result).toEqual({ action: "skip", reason: "already_bound" });
  });
});
