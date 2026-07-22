import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  appendJaceMessage: vi.fn(),
}));
vi.mock("../../../../../lib/chat/feature-flags", () => ({
  isConsoleChatEnabled: vi.fn(),
}));

import { POST } from "./route";
import { appendJaceMessage } from "@agentrail/db-postgres";
import { isConsoleChatEnabled } from "../../../../../lib/chat/feature-flags";

const mockAppend = vi.mocked(appendJaceMessage);
const mockFlag = vi.mocked(isConsoleChatEnabled);

const WS = "00000000-0000-0000-0000-000000000001";
const CONVERSATION_KEY = "console:user-1:1";

// Central-secret auth (mirrors runner/workspace-memory/route.test.ts's idiom).
const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function req(opts: {
  body?: unknown;
  token?: string;
} = {}): NextRequest {
  const { body, token } = opts;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
  return new NextRequest("http://localhost/api/v1/runner/chat-reply", {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = SECRET;
  mockFlag.mockReturnValue(true);
  mockAppend.mockResolvedValue({
    id: "m1",
    seq: 1,
    workspaceId: WS,
    conversationKey: CONVERSATION_KEY,
    role: "jace",
    text: "hi there",
    createdAt: new Date(),
  } as never);
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("POST /api/v1/runner/chat-reply", () => {
  describe("auth (central JACE_CONSOLE_TOKEN secret)", () => {
    it("401 when JACE_CONSOLE_TOKEN is unset, and never touches the db", async () => {
      delete process.env[ENV_KEY];
      const res = await POST(
        req({ token: SECRET, body: { workspaceId: WS, conversationKey: CONVERSATION_KEY, text: "hi" } })
      );
      expect(res.status).toBe(401);
      expect(mockAppend).not.toHaveBeenCalled();
    });

    it("401 when no Authorization header is sent", async () => {
      const res = await POST(
        req({ body: { workspaceId: WS, conversationKey: CONVERSATION_KEY, text: "hi" } })
      );
      expect(res.status).toBe(401);
    });

    it("401 on a wrong secret", async () => {
      const res = await POST(
        req({ token: "wrong", body: { workspaceId: WS, conversationKey: CONVERSATION_KEY, text: "hi" } })
      );
      expect(res.status).toBe(401);
    });
  });

  describe("validation", () => {
    it("400 when workspaceId is missing", async () => {
      const res = await POST(req({ token: SECRET, body: { conversationKey: CONVERSATION_KEY, text: "hi" } }));
      expect(res.status).toBe(400);
      expect(mockAppend).not.toHaveBeenCalled();
    });

    it("400 when conversationKey is missing", async () => {
      const res = await POST(req({ token: SECRET, body: { workspaceId: WS, text: "hi" } }));
      expect(res.status).toBe(400);
    });

    it("400 when text is missing/blank", async () => {
      const res = await POST(
        req({ token: SECRET, body: { workspaceId: WS, conversationKey: CONVERSATION_KEY, text: "   " } })
      );
      expect(res.status).toBe(400);
    });

    it("400 when text exceeds the max length", async () => {
      const res = await POST(
        req({
          token: SECRET,
          body: { workspaceId: WS, conversationKey: CONVERSATION_KEY, text: "x".repeat(8001) },
        })
      );
      expect(res.status).toBe(400);
    });
  });

  it("404 when the flag is off for this workspace", async () => {
    mockFlag.mockReturnValue(false);
    const res = await POST(
      req({ token: SECRET, body: { workspaceId: WS, conversationKey: CONVERSATION_KEY, text: "hi" } })
    );
    expect(res.status).toBe(404);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("writes a role: 'jace' message on a happy path", async () => {
    const res = await POST(
      req({ token: SECRET, body: { workspaceId: WS, conversationKey: CONVERSATION_KEY, text: "hi there" } })
    );
    expect(res.status).toBe(200);
    expect(mockAppend).toHaveBeenCalledWith({
      workspaceId: WS,
      conversationKey: CONVERSATION_KEY,
      role: "jace",
      text: "hi there",
    });
    const json = await res.json();
    expect(json).toEqual({ ok: true });
  });

  it("502 when the write fails", async () => {
    mockAppend.mockRejectedValue(new Error("pg down"));
    const res = await POST(
      req({ token: SECRET, body: { workspaceId: WS, conversationKey: CONVERSATION_KEY, text: "hi" } })
    );
    expect(res.status).toBe(502);
  });
});
