import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  createDraftAcceptanceRecord: vi.fn(),
  getRepositoryByName: vi.fn(),
  getWorkspaceMembership: vi.fn(),
  listChangeRecords: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import {
  createDraftAcceptanceRecord,
  getRepositoryByName,
  getWorkspaceMembership,
  listChangeRecords,
} from "@agentrail/db-postgres";
import { GET, POST } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
const USER = "user-1";
const contract = {
  originalUserWording: "Add a button",
  goal: "Make the action visible",
  acceptanceCriteria: [{ id: "AC-1", text: "A user can see the button", required: true }],
  nonGoals: [], risks: [], environmentExpectations: [], stopConditions: [], affectedCodebaseUnits: [], openQuestions: [],
};
const record = {
  id: "00000000-0000-0000-0000-000000000111",
  workspaceId: WS,
  repo: "ada/widgets",
  issueNumber: 42,
  prNumber: 98,
  headShas: ["deadbeef"],
  mergedSha: null,
  state: "open",
  createdAt: new Date("2026-08-03T12:00:00.000Z"),
  updatedAt: new Date("2026-08-03T12:05:00.000Z"),
};

function request(url = `http://localhost/api/v1/workspaces/${WS}/change-records`) {
  return new NextRequest(url, { method: "GET" });
}

function draftRequest(body: unknown) {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/change-records`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

function params() {
  return Promise.resolve({ workspaceId: WS });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(listChangeRecords).mockResolvedValue([record] as never);
  vi.mocked(getRepositoryByName).mockResolvedValue({ id: "repo-1" } as never);
  vi.mocked(createDraftAcceptanceRecord).mockResolvedValue({
    record: { ...record, workKey: "manual-1", originChannel: "codex_mcp", sourceReferences: [] },
    contract: {
      id: "00000000-0000-0000-0000-000000000222",
      recordId: record.id,
      version: 1,
      status: "draft",
      contract,
      createdBy: `user:${USER}`,
      confirmedBy: null,
      confirmedAt: null,
      createdAt: record.createdAt,
    },
  } as never);
});

describe("GET /api/v1/workspaces/[workspaceId]/change-records", () => {
  it("authenticates before listing", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const response = await GET(request(), { params: params() });
    expect(response.status).toBe(401);
    expect(listChangeRecords).not.toHaveBeenCalled();
  });

  it("scopes the list to the workspace and optional repo filter", async () => {
    const response = await GET(
      request(`http://localhost/api/v1/workspaces/${WS}/change-records?repo=ada%2Fwidgets`),
      { params: params() }
    );
    expect(response.status).toBe(200);
    expect(listChangeRecords).toHaveBeenCalledWith({
      workspaceId: WS,
      repo: "ada/widgets",
    });
    expect(await response.json()).toEqual({
      repo: "ada/widgets",
      records: [{
        ...record,
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
      }],
    });
  });
});

describe("POST /api/v1/workspaces/[workspaceId]/change-records", () => {
  const body = {
    repo: "ada/widgets",
    originChannel: "codex_mcp",
    sourceReferences: [{ kind: "codex_thread", id: "thread-1" }],
    contract,
    workKey: "manual-1",
  };

  it("requires authentication before looking up a repository or creating a draft", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const response = await POST(draftRequest(body), { params: params() });
    expect(response.status).toBe(401);
    expect(getRepositoryByName).not.toHaveBeenCalled();
    expect(createDraftAcceptanceRecord).not.toHaveBeenCalled();
  });

  it("rejects an invalid manual draft before writing", async () => {
    const response = await POST(
      draftRequest({ ...body, contract: [] }),
      { params: params() }
    );
    expect(response.status).toBe(400);
    expect(createDraftAcceptanceRecord).not.toHaveBeenCalled();
  });

  it("creates a workspace-scoped draft only for a connected repository", async () => {
    const response = await POST(draftRequest(body), { params: params() });
    expect(response.status).toBe(201);
    expect(getRepositoryByName).toHaveBeenCalledWith(WS, "ada/widgets");
    expect(createDraftAcceptanceRecord).toHaveBeenCalledWith({
      workspaceId: WS,
      repo: "ada/widgets",
      originChannel: "codex_mcp",
      sourceReferences: [{ kind: "codex_thread", id: "thread-1" }],
      contract,
      createdBy: `user:${USER}`,
      workKey: "manual-1",
    });
    await expect(response.json()).resolves.toMatchObject({
      record: { id: record.id, workKey: "manual-1", originChannel: "codex_mcp" },
      contract: { version: 1, status: "draft" },
    });
  });
});
