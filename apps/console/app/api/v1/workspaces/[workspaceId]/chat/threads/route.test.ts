import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  listConsoleChatThreads: vi.fn(),
}));
vi.mock("../../../../../../../lib/chat/feature-flags", () => ({
  isConsoleChatEnabled: vi.fn(),
}));

import { GET } from "./route";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listConsoleChatThreads } from "@agentrail/db-postgres";
import { isConsoleChatEnabled } from "../../../../../../../lib/chat/feature-flags";

const WS = "00000000-0000-0000-0000-000000000001";
const USER = "user-1";

function getReq(): NextRequest {
  return new NextRequest(`http://localhost/api/v1/workspaces/${WS}/chat/threads`, {
    method: "GET",
  });
}

function params() {
  return Promise.resolve({ workspaceId: WS });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1", role: "member" } as never);
  vi.mocked(isConsoleChatEnabled).mockReturnValue(true);
  vi.mocked(listConsoleChatThreads).mockResolvedValue([]);
});

describe("GET /api/v1/workspaces/[workspaceId]/chat/threads", () => {
  it("401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(getReq(), { params: params() });
    expect(res.status).toBe(401);
  });

  it("403 when not a workspace member", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await GET(getReq(), { params: params() });
    expect(res.status).toBe(403);
  });

  it("404 when the flag is off — the endpoint does not exist, not just forbidden", async () => {
    vi.mocked(isConsoleChatEnabled).mockReturnValue(false);
    const res = await GET(getReq(), { params: params() });
    expect(res.status).toBe(404);
  });

  it("scopes the thread read to the SERVER session's own user id (no IDOR via a client param)", async () => {
    await GET(getReq(), { params: params() });
    expect(listConsoleChatThreads).toHaveBeenCalledWith(WS, USER);
  });

  it("maps threads to snake_case wire fields, newest first", async () => {
    vi.mocked(listConsoleChatThreads).mockResolvedValue([
      { n: 2, title: "ship the picker", lastMessageAt: new Date("2026-07-22T02:00:00.000Z"), messageCount: 4 },
      { n: 1, title: "hello jace", lastMessageAt: new Date("2026-07-22T01:00:00.000Z"), messageCount: 2 },
    ] as never);

    const res = await GET(getReq(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.threads).toEqual([
      { n: 2, title: "ship the picker", last_message_at: "2026-07-22T02:00:00.000Z", message_count: 4 },
      { n: 1, title: "hello jace", last_message_at: "2026-07-22T01:00:00.000Z", message_count: 2 },
    ]);
  });

  it("returns an empty array when the member has no threads yet", async () => {
    const res = await GET(getReq(), { params: params() });
    const json = await res.json();
    expect(json.threads).toEqual([]);
  });
});
