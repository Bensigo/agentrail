import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  getApprovalById: vi.fn(),
  resolveApproval: vi.fn(),
}));

vi.mock("../../../../../../../lib/approval-decision", () => ({
  applyAlignmentDecision: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import { getApprovalById, getWorkspaceMembership, resolveApproval } from "@agentrail/db-postgres";
import { applyAlignmentDecision } from "../../../../../../../lib/approval-decision";

const WORKSPACE_ID = "ws-123";
const APPROVAL_ID = "approval-1";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/approvals/${APPROVAL_ID}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

function makeParams() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID, approvalId: APPROVAL_ID }) };
}

const approvalRow = {
  id: APPROVAL_ID,
  workspaceId: WORKSPACE_ID,
  toolName: "create_issue",
  toolInput: { title: "x" },
  queueEntryId: null,
};

function mockMember(role: string) {
  vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({
    userId: "user-1",
    workspaceId: WORKSPACE_ID,
    role,
  } as never);
}

describe("POST /api/v1/workspaces/:workspaceId/approvals/:approvalId", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await POST(makeRequest({ decision: "approved" }), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller is not a workspace member", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await POST(makeRequest({ decision: "approved" }), makeParams());
    expect(res.status).toBe(403);
  });

  it("returns 403 for a member role (read-only)", async () => {
    mockMember("member");
    const res = await POST(makeRequest({ decision: "approved" }), makeParams());
    expect(res.status).toBe(403);
    expect(resolveApproval).not.toHaveBeenCalled();
  });

  it("returns 403 for a viewer role (read-only)", async () => {
    mockMember("viewer");
    const res = await POST(makeRequest({ decision: "approved" }), makeParams());
    expect(res.status).toBe(403);
    expect(resolveApproval).not.toHaveBeenCalled();
  });

  it("allows an owner to approve", async () => {
    mockMember("owner");
    vi.mocked(getApprovalById).mockResolvedValue(approvalRow as never);
    vi.mocked(resolveApproval).mockResolvedValue(true);

    const res = await POST(makeRequest({ decision: "approved" }), makeParams());

    expect(res.status).toBe(200);
    expect(resolveApproval).toHaveBeenCalledWith(APPROVAL_ID, "approved");
    expect(applyAlignmentDecision).toHaveBeenCalledWith(approvalRow, "approved");
  });

  it("allows an admin to deny", async () => {
    mockMember("admin");
    vi.mocked(getApprovalById).mockResolvedValue(approvalRow as never);
    vi.mocked(resolveApproval).mockResolvedValue(true);

    const res = await POST(makeRequest({ decision: "denied" }), makeParams());

    expect(res.status).toBe(200);
    expect(resolveApproval).toHaveBeenCalledWith(APPROVAL_ID, "denied");
    expect(applyAlignmentDecision).toHaveBeenCalledWith(approvalRow, "denied");
  });

  it("returns 400 for a malformed decision value", async () => {
    mockMember("owner");
    const res = await POST(makeRequest({ decision: "maybe" }), makeParams());
    expect(res.status).toBe(400);
    expect(getApprovalById).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON", async () => {
    mockMember("owner");
    const req = new NextRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/approvals/${APPROVAL_ID}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" }
    );
    const res = await POST(req, makeParams());
    expect(res.status).toBe(400);
  });

  it("returns 404 when the approval does not exist", async () => {
    mockMember("owner");
    vi.mocked(getApprovalById).mockResolvedValue(null);
    const res = await POST(makeRequest({ decision: "approved" }), makeParams());
    expect(res.status).toBe(404);
    expect(resolveApproval).not.toHaveBeenCalled();
  });

  it("workspace-scoping negative: an approval id from another workspace is rejected (never trusts the id alone)", async () => {
    mockMember("owner");
    vi.mocked(getApprovalById).mockResolvedValue({
      ...approvalRow,
      workspaceId: "some-other-workspace",
    } as never);

    const res = await POST(makeRequest({ decision: "approved" }), makeParams());

    expect(res.status).toBe(404);
    expect(resolveApproval).not.toHaveBeenCalled();
    expect(applyAlignmentDecision).not.toHaveBeenCalled();
  });

  it("returns 409 when the approval was already resolved (duplicate submit / raced with Telegram)", async () => {
    mockMember("owner");
    vi.mocked(getApprovalById).mockResolvedValue(approvalRow as never);
    vi.mocked(resolveApproval).mockResolvedValue(false);

    const res = await POST(makeRequest({ decision: "approved" }), makeParams());

    expect(res.status).toBe(409);
    expect(applyAlignmentDecision).not.toHaveBeenCalled();
  });
});
