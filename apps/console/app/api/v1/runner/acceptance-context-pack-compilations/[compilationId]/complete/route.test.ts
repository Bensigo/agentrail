import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  readClaimedAcceptanceContextPackCompilation: vi.fn(),
  recordAcceptanceContextPack: vi.fn(),
  reportAcceptanceContextPackCompilation: vi.fn(),
}));
import {
  readClaimedAcceptanceContextPackCompilation,
  recordAcceptanceContextPack,
  reportAcceptanceContextPackCompilation,
} from "@agentrail/db-postgres";
import { POST } from "./route";

const SECRET = "jace-secret";
const originalSecret = process.env.JACE_CONSOLE_TOKEN;
const params = Promise.resolve({ compilationId: "compilation-1" });
const HASH = `sha256:${"a".repeat(64)}`;
const compiled = {
  workerId: "worker-1", status: "compiled", compilerVersion: "compiler-v1", contentHash: HASH,
  manifest: { tokenBudget: 500, tokenCount: 100, sources: [{ path: "src/save.ts", citation: "src/save.ts:1-10", startLine: 1, endLine: 10, reason: "contains the save implementation" }], architectureBoundaries: [], tests: [], decisions: [], exclusions: [], acceptanceCriteria: [{ id: "saved" }] },
  custody: { fullSourceUploadAllowed: false },
  freshness: { indexRevision: "sha-1", repositoryRef: "main", compiledAt: "2026-08-06T12:00:00.000Z" },
  jsonArtifactRef: "artifact://pack.json", markdownArtifactRef: "artifact://pack.md",
};
function request(body: unknown, authorized = true) {
  return new NextRequest("http://localhost", { method: "POST", headers: { "content-type": "application/json", ...(authorized ? { Authorization: `Bearer ${SECRET}` } : {}) }, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JACE_CONSOLE_TOKEN = SECRET;
  vi.mocked(readClaimedAcceptanceContextPackCompilation).mockResolvedValue({
    compilation: { id: "compilation-1", workspaceId: "ws-1", recordId: "record-1", phase: "execute", repositoryRef: "main", acceptanceContractId: "contract-1", acceptanceContractVersion: 1 },
    contract: { id: "contract-1", version: 1, contract: { originalUserWording: "save", goal: "save", acceptanceCriteria: [{ id: "saved", text: "saves", required: true, userVisible: true }] } },
  } as never);
  vi.mocked(recordAcceptanceContextPack).mockResolvedValue({ inserted: true, pack: { id: "pack-1", version: 1 } } as never);
  vi.mocked(reportAcceptanceContextPackCompilation).mockResolvedValue({ id: "compilation-1", status: "compiled", contextPackId: "pack-1" } as never);
});
afterEach(() => { if (originalSecret === undefined) delete process.env.JACE_CONSOLE_TOKEN; else process.env.JACE_CONSOLE_TOKEN = originalSecret; });

describe("Context Pack compilation completion", () => {
  it("requires Jace worker auth before reading or updating a claim", async () => {
    expect((await POST(request(compiled, false), { params })).status).toBe(401);
    expect(readClaimedAcceptanceContextPackCompilation).not.toHaveBeenCalled();
  });

  it("records only contract-validated metadata under the claimed job binding", async () => {
    const response = await POST(request(compiled), { params });
    expect(response.status).toBe(200);
    expect(recordAcceptanceContextPack).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1", recordId: "record-1", phase: "execute", createdBy: "worker:worker-1", contentHash: HASH }));
    expect(reportAcceptanceContextPackCompilation).toHaveBeenCalledWith({ compilationId: "compilation-1", workerId: "worker-1", status: "compiled", contextPackId: "pack-1" });
  });

  it("rejects a metadata payload that cannot prove all confirmed criteria", async () => {
    const response = await POST(request({ ...compiled, manifest: { ...compiled.manifest, acceptanceCriteria: [] } }), { params });
    expect(response.status).toBe(400);
    expect(recordAcceptanceContextPack).not.toHaveBeenCalled();
    expect(reportAcceptanceContextPackCompilation).not.toHaveBeenCalled();
  });

  it("rejects a compiled report from a foreign or stale repository ref", async () => {
    const response = await POST(request({ ...compiled, freshness: { ...compiled.freshness, repositoryRef: "other-ref" } }), { params });
    expect(response.status).toBe(409);
    expect(recordAcceptanceContextPack).not.toHaveBeenCalled();
    expect(reportAcceptanceContextPackCompilation).not.toHaveBeenCalled();
  });

  it("rejects a selected source without a reason", async () => {
    const response = await POST(request({ ...compiled, manifest: { ...compiled.manifest, sources: [{ ...compiled.manifest.sources[0], reason: " " }] } }), { params });
    expect(response.status).toBe(400);
    expect(recordAcceptanceContextPack).not.toHaveBeenCalled();
  });

  it("records a bounded failure without accepting a Pack", async () => {
    vi.mocked(reportAcceptanceContextPackCompilation).mockResolvedValue({ id: "compilation-1", status: "failed", reason: "clone denied" } as never);
    const response = await POST(request({ workerId: "worker-1", status: "failed", reason: "clone denied" }), { params });
    expect(response.status).toBe(200);
    expect(recordAcceptanceContextPack).not.toHaveBeenCalled();
    expect(reportAcceptanceContextPackCompilation).toHaveBeenCalledWith({ compilationId: "compilation-1", workerId: "worker-1", status: "failed", reason: "clone denied" });
  });
});
