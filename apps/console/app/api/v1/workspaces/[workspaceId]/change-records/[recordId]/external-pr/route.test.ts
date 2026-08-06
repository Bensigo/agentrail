import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({ attachExternalPullRequest: vi.fn(), getWorkspaceMembership: vi.fn(), readAcceptanceContracts: vi.fn() }));
import { auth } from "@agentrail/auth";
import { attachExternalPullRequest, getWorkspaceMembership, readAcceptanceContracts } from "@agentrail/db-postgres";
import { POST } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
const RECORD = "00000000-0000-0000-0000-000000000002";
const sha = "a".repeat(40);
function params() { return Promise.resolve({ workspaceId: WS, recordId: RECORD }); }
function post(body: unknown) { return new NextRequest("http://localhost", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
const valid = { repo: "acme/web", prNumber: 42, prUrl: "https://github.com/acme/web/pull/42", baseSha: sha, headSha: "b".repeat(40) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: "lead-1" } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "member" } as never);
  vi.mocked(readAcceptanceContracts).mockResolvedValue([{ status: "confirmed" }] as never);
  vi.mocked(attachExternalPullRequest).mockResolvedValue({ id: RECORD, repo: "acme/web", prNumber: 42, headShas: [valid.headSha] } as never);
});

describe("external PR attachment", () => {
  it("binds a confirmed record to a GitHub PR and exact head", async () => {
    const response = await POST(post(valid), { params: params() });
    expect(response.status).toBe(201);
    expect(attachExternalPullRequest).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS, recordId: RECORD, headSha: valid.headSha, attachedBy: "user:lead-1" }));
  });
  it("rejects abbreviated or mismatched PR claims", async () => {
    const response = await POST(post({ ...valid, headSha: "abc", prUrl: "https://github.com/acme/other/pull/42" }), { params: params() });
    expect(response.status).toBe(400);
    expect(attachExternalPullRequest).not.toHaveBeenCalled();
  });
  it("will not attach a PR before human confirmation", async () => {
    vi.mocked(readAcceptanceContracts).mockResolvedValue([{ status: "draft" }] as never);
    const response = await POST(post(valid), { params: params() });
    expect(response.status).toBe(409);
  });
});
