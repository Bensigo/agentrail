import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  enqueueAcceptanceContextPackCompilation: vi.fn(),
  getRepositoryByName: vi.fn(),
  getWorkspaceMembership: vi.fn(),
  readChangeRecordTimeline: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import {
  enqueueAcceptanceContextPackCompilation,
  getRepositoryByName,
  getWorkspaceMembership,
  readChangeRecordTimeline,
} from "@agentrail/db-postgres";
import { POST } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
const RECORD = "00000000-0000-0000-0000-000000000011";
const params = Promise.resolve({ workspaceId: WS, recordId: RECORD });
const payload = { contractId: "contract-1", contractVersion: 2, phase: "execute" };

function request(body: unknown = payload) {
  return new NextRequest(`http://localhost/api/v1/workspaces/${WS}/change-records/${RECORD}/context-pack-compilations`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "member-1", role: "owner" } as never);
  vi.mocked(readChangeRecordTimeline).mockResolvedValue({ record: { id: RECORD, repo: "ada/widgets" }, events: [] } as never);
  vi.mocked(getRepositoryByName).mockResolvedValue({ id: "repo-1", name: "ada/widgets" } as never);
  vi.mocked(enqueueAcceptanceContextPackCompilation).mockResolvedValue({
    inserted: true,
    compilation: {
      id: "compilation-1", acceptanceContractId: "contract-1", acceptanceContractVersion: 2,
      phase: "execute", status: "queued", createdAt: new Date("2026-08-06T12:00:00.000Z"),
    },
  } as never);
});

describe("POST acceptance Context Pack compilation", () => {
  it("queues one confirmed-contract/repository-bound compilation under a human owner", async () => {
    const response = await POST(request(), { params });
    expect(response.status).toBe(201);
    expect(enqueueAcceptanceContextPackCompilation).toHaveBeenCalledWith({
      workspaceId: WS, recordId: RECORD, repositoryId: "repo-1", contractId: "contract-1",
      contractVersion: 2, phase: "execute", createdBy: "user:user-1",
    });
    await expect(response.json()).resolves.toMatchObject({
      inserted: true, compilation: { id: "compilation-1", status: "queued", phase: "execute" },
    });
  });

  it("rejects a member before it reads the Acceptance Record or queues work", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "member-1", role: "member" } as never);
    const response = await POST(request(), { params });
    expect(response.status).toBe(403);
    expect(readChangeRecordTimeline).not.toHaveBeenCalled();
    expect(enqueueAcceptanceContextPackCompilation).not.toHaveBeenCalled();
  });

  it("requires an exact positive contract version and known phase", async () => {
    const response = await POST(request({ ...payload, contractVersion: 0, phase: "anything" }), { params });
    expect(response.status).toBe(400);
    expect(readChangeRecordTimeline).not.toHaveBeenCalled();
    expect(enqueueAcceptanceContextPackCompilation).not.toHaveBeenCalled();
  });

  it("does not queue work when the Acceptance Record or its connected repository is absent", async () => {
    vi.mocked(readChangeRecordTimeline).mockResolvedValue(null as never);
    expect((await POST(request(), { params })).status).toBe(404);
    vi.mocked(readChangeRecordTimeline).mockResolvedValue({ record: { id: RECORD, repo: "ada/widgets" }, events: [] } as never);
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);
    expect((await POST(request(), { params })).status).toBe(404);
    expect(enqueueAcceptanceContextPackCompilation).not.toHaveBeenCalled();
  });
});
