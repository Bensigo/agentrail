import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  readAcceptanceContracts: vi.fn(),
  readAcceptanceContextPacks: vi.fn(),
  recordAcceptanceContextPack: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  readAcceptanceContracts,
  readAcceptanceContextPacks,
  recordAcceptanceContextPack,
} from "@agentrail/db-postgres";
import { GET, POST } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
const RECORD = "00000000-0000-0000-0000-000000000011";
const USER = "user-1";
const HASH = `sha256:${"a".repeat(64)}`;

const payload = {
  phase: "execute",
  contentHash: HASH,
  compilerVersion: "context-compiler-v1",
  manifest: { citations: [{ path: "src/cart.ts", citation: "src/cart.ts:10-20" }] },
  custody: { fullSourceUploadAllowed: false },
  freshness: { indexBuiltAt: "2026-08-06T12:00:00.000Z" },
  jsonArtifactRef: "workspace://packs/1.json",
  markdownArtifactRef: "workspace://packs/1.md",
};

function params() {
  return Promise.resolve({ workspaceId: WS, recordId: RECORD });
}

function post(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/workspaces/${WS}/change-records/${RECORD}/context-packs`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "member-1" } as never);
  vi.mocked(readAcceptanceContracts).mockResolvedValue([
    { id: "c1", recordId: RECORD, version: 1, status: "confirmed" },
  ] as never);
  vi.mocked(readAcceptanceContextPacks).mockResolvedValue([] as never);
});

describe("Acceptance Context Pack route", () => {
  it("does not expose pack metadata outside a workspace membership", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const response = await GET(
      new NextRequest(`http://localhost/api/v1/workspaces/${WS}/change-records/${RECORD}/context-packs`),
      { params: params() }
    );
    expect(response.status).toBe(403);
    expect(readAcceptanceContextPacks).not.toHaveBeenCalled();
  });

  it("requires a confirmed contract before recording a pack", async () => {
    vi.mocked(readAcceptanceContracts).mockResolvedValue([] as never);
    const response = await POST(post(payload), { params: params() });
    expect(response.status).toBe(409);
    expect(recordAcceptanceContextPack).not.toHaveBeenCalled();
  });

  it("rejects malformed or non-metadata payloads before persistence", async () => {
    const response = await POST(post({ ...payload, contentHash: "not-a-hash" }), { params: params() });
    expect(response.status).toBe(400);
    expect(recordAcceptanceContextPack).not.toHaveBeenCalled();
  });

  it("records a confirmed pack under the authenticated actor", async () => {
    vi.mocked(recordAcceptanceContextPack).mockResolvedValue({
      inserted: true,
      pack: {
        id: "pack-1", recordId: RECORD, version: 1, createdAt: new Date("2026-08-06T12:00:00.000Z"),
        createdBy: `user:${USER}`, ...payload,
      },
    } as never);

    const response = await POST(post(payload), { params: params() });
    expect(response.status).toBe(201);
    expect(recordAcceptanceContextPack).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WS, recordId: RECORD, createdBy: `user:${USER}`, contentHash: HASH,
    }));
    await expect(response.json()).resolves.toMatchObject({
      inserted: true, contextPack: { id: "pack-1", contentHash: HASH },
    });
  });
});
