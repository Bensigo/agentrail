import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  setMergePermission: vi.fn(),
}));

vi.mock("../../../../../lib/cached", () => ({
  getSession: vi.fn(),
  getMembership: vi.fn(),
}));

import { revalidatePath } from "next/cache";
import { setMergePermission } from "@agentrail/db-postgres";
import { getSession, getMembership } from "../../../../../lib/cached";
import { setMergePermissionAction } from "./actions";

const WORKSPACE_ID = "ws-123";
const OWNER_USER_ID = "user-owner";

function mockSession(userId: string | null) {
  vi.mocked(getSession).mockResolvedValue(
    (userId ? { user: { id: userId } } : null) as Awaited<
      ReturnType<typeof getSession>
    >
  );
}

function mockMembership(role: "owner" | "admin" | "member" | "viewer" | null) {
  vi.mocked(getMembership).mockResolvedValue(
    (role
      ? { userId: OWNER_USER_ID, workspaceId: WORKSPACE_ID, role, createdAt: new Date() }
      : null) as Awaited<ReturnType<typeof getMembership>>
  );
}

/**
 * `setMergePermissionAction` is the ONLY write path for #1278's owner-only
 * trust ceiling — deliberately narrower than this repo's ADMIN_ROLES
 * precedent (owner OR admin). Every non-owner role must be rejected
 * SERVER-side, and the underlying `setMergePermission` write must never be
 * reached for a rejected caller (a client-side `canManage` prop is a UX
 * nicety, never the enforcement boundary — this suite is what actually
 * proves the boundary holds).
 */
describe("setMergePermissionAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(setMergePermission).mockResolvedValue({
      mergePermission: true,
      grantEventId: "grant-1",
    });
  });

  it("rejects when not signed in, and never calls setMergePermission", async () => {
    mockSession(null);

    const result = await setMergePermissionAction(WORKSPACE_ID, true);

    expect(result).toEqual({ ok: false, error: "Not signed in." });
    expect(setMergePermission).not.toHaveBeenCalled();
  });

  it("rejects when the user has no membership on this workspace", async () => {
    mockSession(OWNER_USER_ID);
    mockMembership(null);

    const result = await setMergePermissionAction(WORKSPACE_ID, true);

    expect(result.ok).toBe(false);
    expect(setMergePermission).not.toHaveBeenCalled();
  });

  it.each(["admin", "member", "viewer"] as const)(
    "rejects a %s — owner-only, narrower than the repo's ADMIN_ROLES precedent",
    async (role) => {
      mockSession(OWNER_USER_ID);
      mockMembership(role);

      const result = await setMergePermissionAction(WORKSPACE_ID, true);

      expect(result).toEqual({
        ok: false,
        error: "Only the workspace owner can change merge permission.",
      });
      expect(setMergePermission).not.toHaveBeenCalled();
    }
  );

  it("grants for an owner: calls setMergePermission with the server-derived actor id, revalidates, returns ok", async () => {
    mockSession(OWNER_USER_ID);
    mockMembership("owner");

    const result = await setMergePermissionAction(WORKSPACE_ID, true);

    expect(setMergePermission).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      granted: true,
      grantedByUserId: OWNER_USER_ID,
    });
    expect(revalidatePath).toHaveBeenCalledWith(
      `/dashboard/${WORKSPACE_ID}/permissions`
    );
    expect(result).toEqual({ ok: true, granted: true });
  });

  it("revokes for an owner identically to a grant", async () => {
    mockSession(OWNER_USER_ID);
    mockMembership("owner");
    vi.mocked(setMergePermission).mockResolvedValue({
      mergePermission: false,
      grantEventId: "grant-2",
    });

    const result = await setMergePermissionAction(WORKSPACE_ID, false);

    expect(setMergePermission).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      granted: false,
      grantedByUserId: OWNER_USER_ID,
    });
    expect(result).toEqual({ ok: true, granted: false });
  });
});
