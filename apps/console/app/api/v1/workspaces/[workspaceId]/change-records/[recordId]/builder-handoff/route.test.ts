import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  createAcceptanceBuilderHandoff: vi.fn(),
  getRepositoryByName: vi.fn(),
  getWorkspaceMembership: vi.fn(),
  readAcceptanceContextPacks: vi.fn(),
  readChangeRecordTimeline: vi.fn(),
}));
import { auth } from "@agentrail/auth";
import {
  createAcceptanceBuilderHandoff,
  getRepositoryByName,
  getWorkspaceMembership,
  readAcceptanceContextPacks,
  readChangeRecordTimeline,
} from "@agentrail/db-postgres";
import { POST } from "./route";

const params = Promise.resolve({ workspaceId: "ws-1", recordId: "record-1" });
const body = {
  builder: "codex", taskContextKey: "jace-task-123", repo: "ada/widgets",
  branchName: "jace/saved-state", contractId: "contract-1", contractVersion: 2,
  contextPackId: "pack-1", agentMcpCredentialId: "00000000-0000-4000-8000-000000000099",
};
function request(payload: unknown = body) {
  return new NextRequest("http://localhost/api/v1/workspaces/ws-1/change-records/record-1/builder-handoff", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "membership-1", role: "owner" } as never);
  vi.mocked(readChangeRecordTimeline).mockResolvedValue({ record: { id: "record-1", repo: "ada/widgets" }, events: [] } as never);
  vi.mocked(getRepositoryByName).mockResolvedValue({ id: "repo-1", name: "ada/widgets" } as never);
  vi.mocked(readAcceptanceContextPacks).mockResolvedValue([{ id: "pack-1" }] as never);
  vi.mocked(createAcceptanceBuilderHandoff).mockResolvedValue({
    inserted: true,
    handoff: {
      id: "handoff-1", builder: "codex", taskContextKey: "jace-task-123",
      branchName: "jace/saved-state", acceptanceContractId: "contract-1",
      acceptanceContractVersion: 2, contextPackId: "pack-1", agentMcpCredentialId: body.agentMcpCredentialId, status: "handed_off",
      createdAt: new Date("2026-08-06T00:00:00.000Z"),
    },
  } as never);
});

describe("POST builder handoff", () => {
  it("records a human-selected exact builder route before a PR exists", async () => {
    const response = await POST(request(), { params });
    expect(response.status).toBe(201);
    expect(createAcceptanceBuilderHandoff).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1", recordId: "record-1", repositoryId: "repo-1",
      builder: "codex", taskContextKey: "jace-task-123", branchName: "jace/saved-state",
      contractId: "contract-1", contractVersion: 2, contextPackId: "pack-1", agentMcpCredentialId: body.agentMcpCredentialId, createdBy: "user:user-1",
    }));
  });

  it("rejects a repository that does not match the Acceptance Record", async () => {
    const response = await POST(request({ ...body, repo: "ada/other" }), { params });
    expect(response.status).toBe(409);
    expect(createAcceptanceBuilderHandoff).not.toHaveBeenCalled();
  });

  it("requires a safe planned branch and a selected Context Pack", async () => {
    const invalid = await POST(request({ ...body, branchName: "../wrong" }), { params });
    expect(invalid.status).toBe(400);
    vi.mocked(readAcceptanceContextPacks).mockResolvedValue([] as never);
    const missingPack = await POST(request(), { params });
    expect(missingPack.status).toBe(409);
    expect(createAcceptanceBuilderHandoff).not.toHaveBeenCalled();
  });

  it("requires a valid selected MCP credential ID", async () => {
    const response = await POST(request({ ...body, agentMcpCredentialId: "not-a-uuid" }), { params });
    expect(response.status).toBe(400);
    expect(createAcceptanceBuilderHandoff).not.toHaveBeenCalled();
  });

  it("keeps external-builder selection under human owner/admin authority", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "membership-1", role: "member" } as never);
    const response = await POST(request(), { params });
    expect(response.status).toBe(403);
    expect(createAcceptanceBuilderHandoff).not.toHaveBeenCalled();
  });

  it("does not hand off an unattested or wrong-contract Pack", async () => {
    vi.mocked(createAcceptanceBuilderHandoff).mockRejectedValue(new Error("A compiled execute Context Pack must match the selected confirmed contract and repository"));
    const response = await POST(request(), { params });
    expect(response.status).toBe(409);
  });
});
