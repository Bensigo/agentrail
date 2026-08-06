import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  claimAcceptanceContextPackCompilation: vi.fn(),
  getInstallationToken: vi.fn(),
}));
import { claimAcceptanceContextPackCompilation, getInstallationToken } from "@agentrail/db-postgres";
import { POST } from "./route";

const SECRET = "jace-shared-secret";
const originalSecret = process.env.JACE_CONSOLE_TOKEN;
function request(body: unknown, authorized = true) {
  return new NextRequest("http://localhost/api/v1/runner/acceptance-context-pack-compilations/claim", {
    method: "POST",
    headers: { "content-type": "application/json", ...(authorized ? { Authorization: `Bearer ${SECRET}` } : {}) },
    body: JSON.stringify(body),
  });
}

const claimed = {
  compilation: {
    id: "compilation-1", workspaceId: "ws-1", recordId: "record-1", phase: "execute",
    acceptanceContractId: "contract-1", acceptanceContractVersion: 2,
  },
  repository: { id: "repo-1", name: "ada/widgets", url: null, ref: "main" },
  contract: { id: "contract-1", version: 2, contract: { goal: "Save a draft" } },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JACE_CONSOLE_TOKEN = SECRET;
});
afterEach(() => {
  if (originalSecret === undefined) delete process.env.JACE_CONSOLE_TOKEN;
  else process.env.JACE_CONSOLE_TOKEN = originalSecret;
});

describe("POST acceptance Context Pack compilation claim", () => {
  it("requires the Jace worker secret before it reads a queue item", async () => {
    const response = await POST(request({ workerId: "worker-1" }, false));
    expect(response.status).toBe(401);
    expect(claimAcceptanceContextPackCompilation).not.toHaveBeenCalled();
  });

  it("requires a worker identity and returns 204 when there is no admitted work", async () => {
    expect((await POST(request({}))).status).toBe(400);
    vi.mocked(claimAcceptanceContextPackCompilation).mockResolvedValue(null as never);
    expect((await POST(request({ workerId: "worker-1" }))).status).toBe(204);
    expect(claimAcceptanceContextPackCompilation).toHaveBeenLastCalledWith({ workerId: "worker-1" });
  });

  it("returns only the exact job, confirmed contract, repository ref, and an ephemeral clone token", async () => {
    vi.mocked(claimAcceptanceContextPackCompilation).mockResolvedValue(claimed as never);
    vi.mocked(getInstallationToken).mockResolvedValue("ghs-ephemeral-token" as never);
    const response = await POST(request({ workerId: "worker-1" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      compilation: {
        id: "compilation-1", workspaceId: "ws-1", recordId: "record-1", phase: "execute",
        acceptanceContractId: "contract-1", acceptanceContractVersion: 2,
      },
      repository: { id: "repo-1", name: "ada/widgets", url: "https://github.com/ada/widgets", ref: "main" },
      contract: { id: "contract-1", version: 2, contract: { goal: "Save a draft" } },
      githubToken: "ghs-ephemeral-token",
    });
    expect(getInstallationToken).toHaveBeenCalledWith("ws-1");
  });
});
