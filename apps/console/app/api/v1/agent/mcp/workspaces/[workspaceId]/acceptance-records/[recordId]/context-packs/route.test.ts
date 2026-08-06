import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/agent-mcp-auth", () => ({ requireAgentMcpWorkspace: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({ readAcceptanceContracts: vi.fn(), readAcceptanceContextPacks: vi.fn(), recordAcceptanceContextPack: vi.fn() }));
import { requireAgentMcpWorkspace } from "@/lib/agent-mcp-auth";
import { readAcceptanceContracts, recordAcceptanceContextPack } from "@agentrail/db-postgres";
import { POST } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
const RECORD = "00000000-0000-0000-0000-000000000002";
const hash = `sha256:${"a".repeat(64)}`;
function params() { return Promise.resolve({ workspaceId: WS, recordId: RECORD }); }
function post(body: unknown) {
  return new NextRequest("http://localhost", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
const payload = { phase: "execute", contentHash: hash, compilerVersion: "1", manifest: { tokenBudget: 1000, tokenCount: 200, sources: [{ path: "src/save.ts", citation: "src/save.ts:1-2", startLine: 1, endLine: 2 }], architectureBoundaries: [], tests: [], decisions: [], exclusions: [], acceptanceCriteria: [{ id: "saved" }] }, custody: { fullSourceUploadAllowed: false }, freshness: { indexRevision: "index-1", compiledAt: "2026-08-06T00:00:00.000Z" }, jsonArtifactRef: null, markdownArtifactRef: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAgentMcpWorkspace).mockResolvedValue({ apiKeyId: "mcp-key", workspaceId: WS } as never);
  vi.mocked(readAcceptanceContracts).mockResolvedValue([{ status: "confirmed", contract: { originalUserWording: "save", goal: "save", acceptanceCriteria: [{ id: "saved", text: "Saves", required: true, userVisible: true }] } }] as never);
  vi.mocked(recordAcceptanceContextPack).mockResolvedValue({ pack: { id: "pack-1" }, inserted: true } as never);
});

describe("MCP Context Pack recording", () => {
  it("requires context-write, a confirmed contract, and metadata only", async () => {
    const response = await POST(post(payload), { params: params() });
    expect(response.status).toBe(201);
    expect(requireAgentMcpWorkspace).toHaveBeenCalledWith(expect.any(NextRequest), WS, "acceptance:context:write");
    expect(recordAcceptanceContextPack).toHaveBeenCalledWith(expect.objectContaining({ createdBy: "agent-mcp:mcp-key", workspaceId: WS, recordId: RECORD }));
  });

  it("will not record context before human confirmation", async () => {
    vi.mocked(readAcceptanceContracts).mockResolvedValue([{ status: "draft" }] as never);
    const response = await POST(post(payload), { params: params() });
    expect(response.status).toBe(409);
    expect(recordAcceptanceContextPack).not.toHaveBeenCalled();
  });

  it("rejects source-shaped payloads through database validation", async () => {
    vi.mocked(recordAcceptanceContextPack).mockRejectedValue(new Error("manifest must not contain source content"));
    const response = await POST(post({ ...payload, manifest: { ...payload.manifest, sources: [{ ...payload.manifest.sources[0], content: "secret" }] } }), { params: params() });
    expect(response.status).toBe(422);
  });
});
