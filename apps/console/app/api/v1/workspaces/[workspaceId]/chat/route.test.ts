import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  appendJaceMessage: vi.fn(),
  listJaceMessagesSince: vi.fn(),
  enqueueChannelMessage: vi.fn(),
  pendingApprovalsForWorkspace: vi.fn(),
}));
vi.mock("../../../../../../lib/channel-dispatch", () => ({
  dispatchQueuedChannelMessages: vi.fn(),
}));
vi.mock("../../../../../../lib/chat/feature-flags", () => ({
  isConsoleChatEnabled: vi.fn(),
}));

import { GET, POST } from "./route";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  appendJaceMessage,
  listJaceMessagesSince,
  enqueueChannelMessage,
  pendingApprovalsForWorkspace,
} from "@agentrail/db-postgres";
import { dispatchQueuedChannelMessages } from "../../../../../../lib/channel-dispatch";
import { isConsoleChatEnabled } from "../../../../../../lib/chat/feature-flags";

const WS = "00000000-0000-0000-0000-000000000001";
const USER = "user-1";

function getReq(search = ""): NextRequest {
  return new NextRequest(`http://localhost/api/v1/workspaces/${WS}/chat${search}`, {
    method: "GET",
  });
}

function postReq(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/workspaces/${WS}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
  vi.mocked(listJaceMessagesSince).mockResolvedValue([]);
  vi.mocked(pendingApprovalsForWorkspace).mockResolvedValue([]);
  vi.mocked(dispatchQueuedChannelMessages).mockResolvedValue({ processed: 0, failed: 0 });
  vi.mocked(enqueueChannelMessage).mockResolvedValue({ id: "row-1", deduped: false });
  vi.mocked(appendJaceMessage).mockResolvedValue({
    id: "msg-1",
    seq: 1,
    workspaceId: WS,
    conversationKey: `console:${USER}:1`,
    role: "user",
    text: "hello",
    createdAt: new Date("2026-07-22T00:00:00.000Z"),
  } as never);
});

describe("GET /api/v1/workspaces/[workspaceId]/chat", () => {
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

  it("defaults after_seq to 0 and scopes the read to this user's own conversation key", async () => {
    await GET(getReq(), { params: params() });
    expect(listJaceMessagesSince).toHaveBeenCalledWith(WS, `console:${USER}:1`, 0);
  });

  it("parses after_seq from the query string", async () => {
    await GET(getReq("?after_seq=7"), { params: params() });
    expect(listJaceMessagesSince).toHaveBeenCalledWith(WS, `console:${USER}:1`, 7);
  });

  it("scopes to the requested thread via ?n= (multi-thread)", async () => {
    await GET(getReq("?n=3&after_seq=2"), { params: params() });
    expect(listJaceMessagesSince).toHaveBeenCalledWith(WS, `console:${USER}:3`, 2);
  });

  it("400s on an invalid ?n=", async () => {
    expect((await GET(getReq("?n=abc"), { params: params() })).status).toBe(400);
    expect((await GET(getReq("?n=0"), { params: params() })).status).toBe(400);
    expect((await GET(getReq("?n=-1"), { params: params() })).status).toBe(400);
  });

  it("returns the mapped message list on a happy path", async () => {
    vi.mocked(listJaceMessagesSince).mockResolvedValue([
      {
        id: "m1",
        seq: 1,
        workspaceId: WS,
        conversationKey: `console:${USER}:1`,
        role: "user",
        text: "hi",
        createdAt: new Date("2026-07-22T00:00:00.000Z"),
      },
      {
        id: "m2",
        seq: 2,
        workspaceId: WS,
        conversationKey: `console:${USER}:1`,
        role: "jace",
        text: "hello!",
        createdAt: new Date("2026-07-22T00:00:01.000Z"),
      },
    ] as never);

    const res = await GET(getReq(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.messages).toEqual([
      { id: "m1", seq: 1, role: "user", text: "hi", created_at: "2026-07-22T00:00:00.000Z" },
      { id: "m2", seq: 2, role: "jace", text: "hello!", created_at: "2026-07-22T00:00:01.000Z" },
    ]);
  });

  describe("approvals (#1288 AC2 — inline, same seam)", () => {
    it("includes only THIS member's own console-conversation approvals, never another member's or another channel's", async () => {
      vi.mocked(pendingApprovalsForWorkspace).mockResolvedValue([
        {
          id: "appr-1",
          toolName: "create_issue",
          toolInput: { title: "Fix the bug" },
          approveOptionId: "approve",
          denyOptionId: "deny",
          channel: "console",
          conversationKey: `console:${USER}:1`,
          createdAt: new Date("2026-07-22T00:00:00.000Z"),
        },
        {
          id: "appr-2",
          toolName: "create_repo",
          toolInput: {},
          approveOptionId: "approve",
          denyOptionId: "deny",
          channel: "console",
          conversationKey: "console:some-other-user:1",
          createdAt: new Date(),
        },
        {
          id: "appr-3",
          toolName: "create_workspace",
          toolInput: {},
          approveOptionId: "approve",
          denyOptionId: "deny",
          channel: "telegram",
          conversationKey: "555",
          createdAt: new Date(),
        },
      ] as never);

      const res = await GET(getReq(), { params: params() });
      const json = await res.json();
      expect(json.approvals).toEqual([
        {
          id: "appr-1",
          tool_name: "create_issue",
          tool_input: { title: "Fix the bug" },
          created_at: "2026-07-22T00:00:00.000Z",
        },
      ]);
    });

    it("returns an empty approvals array when nothing is pending", async () => {
      const res = await GET(getReq(), { params: params() });
      const json = await res.json();
      expect(json.approvals).toEqual([]);
    });
  });
});

describe("POST /api/v1/workspaces/[workspaceId]/chat", () => {
  it("401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await POST(postReq({ text: "hi" }), { params: params() });
    expect(res.status).toBe(401);
  });

  it("403 when not a workspace member", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await POST(postReq({ text: "hi" }), { params: params() });
    expect(res.status).toBe(403);
  });

  it("404 when the flag is off", async () => {
    vi.mocked(isConsoleChatEnabled).mockReturnValue(false);
    const res = await POST(postReq({ text: "hi" }), { params: params() });
    expect(res.status).toBe(404);
  });

  it("400 on empty/missing text", async () => {
    expect((await POST(postReq({}), { params: params() })).status).toBe(400);
    expect((await POST(postReq({ text: "   " }), { params: params() })).status).toBe(400);
  });

  it("400 on text over the max length", async () => {
    const res = await POST(postReq({ text: "x".repeat(8001) }), { params: params() });
    expect(res.status).toBe(400);
  });

  it("writes the member's own message synchronously with role: 'user', scoped to console:<userId>:1", async () => {
    await POST(postReq({ text: "hello jace" }), { params: params() });
    expect(appendJaceMessage).toHaveBeenCalledWith({
      workspaceId: WS,
      conversationKey: `console:${USER}:1`,
      role: "user",
      text: "hello jace",
    });
  });

  it("enqueues the same message into channel_inbox with channel: 'console' and the default model", async () => {
    await POST(postReq({ text: "hello jace" }), { params: params() });
    expect(enqueueChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        channel: "console",
        conversationKey: `console:${USER}:1`,
        kind: "message",
        senderId: USER,
        payload: { text: "hello jace", model: "anthropic/claude-sonnet-4.6" },
      })
    );
  });

  it("scopes the write + enqueue to the requested thread via body.n", async () => {
    await POST(postReq({ text: "hi", n: 4 }), { params: params() });
    expect(appendJaceMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationKey: `console:${USER}:4` })
    );
    expect(enqueueChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationKey: `console:${USER}:4` })
    );
  });

  it("400s on an invalid body.n", async () => {
    expect((await POST(postReq({ text: "hi", n: 0 }), { params: params() })).status).toBe(400);
    expect((await POST(postReq({ text: "hi", n: "x" }), { params: params() })).status).toBe(400);
  });

  it("400s on an unknown model", async () => {
    const res = await POST(postReq({ text: "hi", model: "made/up" }), { params: params() });
    expect(res.status).toBe(400);
  });

  it("400s on a known-but-not-enabled model (no dead selection routes nowhere)", async () => {
    // z-ai/glm-5.2 is a known option but has no endpoint wired in the test env,
    // so it is not enabled — the route must reject it rather than enqueue it.
    const res = await POST(postReq({ text: "hi", model: "z-ai/glm-5.2" }), { params: params() });
    expect(res.status).toBe(400);
  });

  it("accepts the default model explicitly and enqueues it", async () => {
    await POST(postReq({ text: "hi", model: "anthropic/claude-sonnet-4.6" }), { params: params() });
    expect(enqueueChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { text: "hi", model: "anthropic/claude-sonnet-4.6" },
      })
    );
  });

  it("kicks the dispatcher after enqueueing (fire-and-forget)", async () => {
    await POST(postReq({ text: "hello jace" }), { params: params() });
    expect(dispatchQueuedChannelMessages).toHaveBeenCalledTimes(1);
  });

  it("201s with the inserted message shape", async () => {
    const res = await POST(postReq({ text: "hello jace" }), { params: params() });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.message).toEqual({
      id: "msg-1",
      seq: 1,
      role: "user",
      text: "hello",
      created_at: "2026-07-22T00:00:00.000Z",
    });
  });

  it("never fails the request when the dispatch kick itself rejects", async () => {
    vi.mocked(dispatchQueuedChannelMessages).mockRejectedValue(new Error("drain boom"));
    const res = await POST(postReq({ text: "hello jace" }), { params: params() });
    expect(res.status).toBe(201);
  });
});
