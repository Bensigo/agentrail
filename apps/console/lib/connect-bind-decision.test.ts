import { describe, it, expect } from "vitest";
import {
  decideConnectWorkspaceBind,
  decideConnectIdentityBind,
} from "./connect-bind-decision";

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

describe("decideConnectIdentityBind", () => {
  const SESSION_USER = "user-1";

  // --- userId null (no one linked yet) -> fresh_bind, composed with
  // decideConnectWorkspaceBind exactly as that function would decide alone. ---

  it("fresh_bind + workspace bind: userId null, no existing workspace, exactly one membership", () => {
    const result = decideConnectIdentityBind({
      identity: { userId: null, workspaceId: null },
      sessionUserId: SESSION_USER,
      memberships: [{ id: "ws-1", name: "Acme" }],
    });

    expect(result).toEqual({
      kind: "fresh_bind",
      workspaceDecision: { action: "bind", workspace: { id: "ws-1", name: "Acme" } },
    });
  });

  it("fresh_bind + workspace skip (no_memberships): userId null, zero memberships", () => {
    const result = decideConnectIdentityBind({
      identity: { userId: null, workspaceId: null },
      sessionUserId: SESSION_USER,
      memberships: [],
    });

    expect(result).toEqual({
      kind: "fresh_bind",
      workspaceDecision: { action: "skip", reason: "no_memberships" },
    });
  });

  it("fresh_bind + workspace skip (ambiguous_memberships): userId null, 2+ memberships", () => {
    const result = decideConnectIdentityBind({
      identity: { userId: null, workspaceId: null },
      sessionUserId: SESSION_USER,
      memberships: [
        { id: "ws-1", name: "Acme" },
        { id: "ws-2", name: "Beta Corp" },
      ],
    });

    expect(result).toEqual({
      kind: "fresh_bind",
      workspaceDecision: { action: "skip", reason: "ambiguous_memberships" },
    });
  });

  it("fresh_bind + workspace skip (already_bound): userId null but the identity already has a workspace_id", () => {
    const result = decideConnectIdentityBind({
      identity: { userId: null, workspaceId: "ws-already-bound" },
      sessionUserId: SESSION_USER,
      memberships: [{ id: "ws-1", name: "Acme" }],
    });

    expect(result).toEqual({
      kind: "fresh_bind",
      workspaceDecision: { action: "skip", reason: "already_bound" },
    });
  });

  // --- userId === sessionUserId (idempotent re-redemption by the rightful
  // owner) -> already_yours, never re-binding the user, but still composed
  // with the same workspace decision as fresh_bind would get. ---

  it("already_yours + workspace bind: identity already linked to THIS user, no existing workspace, exactly one membership", () => {
    const result = decideConnectIdentityBind({
      identity: { userId: SESSION_USER, workspaceId: null },
      sessionUserId: SESSION_USER,
      memberships: [{ id: "ws-1", name: "Acme" }],
    });

    expect(result).toEqual({
      kind: "already_yours",
      workspaceDecision: { action: "bind", workspace: { id: "ws-1", name: "Acme" } },
    });
  });

  it("already_yours + workspace skip (no_memberships): identity already linked to THIS user, zero memberships", () => {
    const result = decideConnectIdentityBind({
      identity: { userId: SESSION_USER, workspaceId: null },
      sessionUserId: SESSION_USER,
      memberships: [],
    });

    expect(result).toEqual({
      kind: "already_yours",
      workspaceDecision: { action: "skip", reason: "no_memberships" },
    });
  });

  it("already_yours + workspace skip (ambiguous_memberships): identity already linked to THIS user, 2+ memberships", () => {
    const result = decideConnectIdentityBind({
      identity: { userId: SESSION_USER, workspaceId: null },
      sessionUserId: SESSION_USER,
      memberships: [
        { id: "ws-1", name: "Acme" },
        { id: "ws-2", name: "Beta Corp" },
      ],
    });

    expect(result).toEqual({
      kind: "already_yours",
      workspaceDecision: { action: "skip", reason: "ambiguous_memberships" },
    });
  });

  it("already_yours + workspace skip (already_bound): identity already linked to THIS user AND already has a workspace_id", () => {
    const result = decideConnectIdentityBind({
      identity: { userId: SESSION_USER, workspaceId: "ws-existing" },
      sessionUserId: SESSION_USER,
      memberships: [{ id: "ws-1", name: "Acme" }],
    });

    expect(result).toEqual({
      kind: "already_yours",
      workspaceDecision: { action: "skip", reason: "already_bound" },
    });
  });

  // --- userId set to someone else entirely -> foreign_user, ALWAYS, no
  // workspaceDecision computed at all (not even "skip") regardless of how
  // favorable the workspace inputs look. This is the hijack case the fix
  // closes: a stale-but-unexpired or mint-side-bypassed link redeemed by an
  // unrelated signed-in account must never bind anything. ---

  it("foreign_user: identity linked to a DIFFERENT user, even with exactly one membership available — must NOT compute or expose a workspace bind", () => {
    const result = decideConnectIdentityBind({
      identity: { userId: "user-2", workspaceId: null },
      sessionUserId: SESSION_USER,
      memberships: [{ id: "ws-1", name: "Acme" }],
    });

    expect(result).toEqual({ kind: "foreign_user" });
    expect(result).not.toHaveProperty("workspaceDecision");
  });

  it("foreign_user: identity linked to a different user, zero memberships", () => {
    const result = decideConnectIdentityBind({
      identity: { userId: "user-2", workspaceId: null },
      sessionUserId: SESSION_USER,
      memberships: [],
    });

    expect(result).toEqual({ kind: "foreign_user" });
  });

  it("foreign_user: identity linked to a different user AND already has its own workspace_id — still just foreign_user, workspace is irrelevant", () => {
    const result = decideConnectIdentityBind({
      identity: { userId: "user-2", workspaceId: "ws-other-tenant" },
      sessionUserId: SESSION_USER,
      memberships: [{ id: "ws-1", name: "Acme" }],
    });

    expect(result).toEqual({ kind: "foreign_user" });
    expect(result).not.toHaveProperty("workspaceDecision");
  });
});
