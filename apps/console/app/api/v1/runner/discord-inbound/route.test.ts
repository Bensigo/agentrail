import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("../../../../../lib/discord-inbound", () => ({
  admitDiscordChannelMessage: vi.fn(),
}));

import { POST } from "./route";
import { admitDiscordChannelMessage } from "../../../../../lib/discord-inbound";

const mockAdmit = vi.mocked(admitDiscordChannelMessage);

// Central-secret auth (mirrors runner/chat-reply/route.test.ts's idiom).
const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function req(opts: { body?: unknown; token?: string } = {}): NextRequest {
  const { body, token } = opts;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
  return new NextRequest("http://localhost/api/v1/runner/discord-inbound", {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
}

const VALID_BODY = {
  channelId: "998877",
  messageId: "msg-1",
  senderId: "555",
  senderDisplay: "Ada",
  senderUsername: "ada",
  text: "what's the status?",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = SECRET;
  mockAdmit.mockResolvedValue({ deduped: false });
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("POST /api/v1/runner/discord-inbound", () => {
  describe("auth (central JACE_CONSOLE_TOKEN secret)", () => {
    it("401 when JACE_CONSOLE_TOKEN is unset, and never touches the pipeline", async () => {
      delete process.env[ENV_KEY];
      const res = await POST(req({ token: SECRET, body: VALID_BODY }));
      expect(res.status).toBe(401);
      expect(mockAdmit).not.toHaveBeenCalled();
    });

    it("401 when no Authorization header is sent", async () => {
      const res = await POST(req({ body: VALID_BODY }));
      expect(res.status).toBe(401);
      expect(mockAdmit).not.toHaveBeenCalled();
    });

    it("401 on a wrong secret", async () => {
      const res = await POST(req({ token: "wrong", body: VALID_BODY }));
      expect(res.status).toBe(401);
    });
  });

  describe("validation", () => {
    it("400 when channelId is missing", async () => {
      const { channelId, ...rest } = VALID_BODY;
      const res = await POST(req({ token: SECRET, body: rest }));
      expect(res.status).toBe(400);
      expect(mockAdmit).not.toHaveBeenCalled();
    });

    it("400 when messageId is missing", async () => {
      const { messageId, ...rest } = VALID_BODY;
      const res = await POST(req({ token: SECRET, body: rest }));
      expect(res.status).toBe(400);
    });

    it("400 when senderId is missing", async () => {
      const { senderId, ...rest } = VALID_BODY;
      const res = await POST(req({ token: SECRET, body: rest }));
      expect(res.status).toBe(400);
    });

    it("400 when text is missing/blank", async () => {
      const res = await POST(req({ token: SECRET, body: { ...VALID_BODY, text: "   " } }));
      expect(res.status).toBe(400);
      expect(mockAdmit).not.toHaveBeenCalled();
    });

    it("400 when text exceeds the max length", async () => {
      const res = await POST(req({ token: SECRET, body: { ...VALID_BODY, text: "x".repeat(4001) } }));
      expect(res.status).toBe(400);
    });

    it("falls back senderDisplay to senderId when blank", async () => {
      await POST(req({ token: SECRET, body: { ...VALID_BODY, senderDisplay: "" } }));
      expect(mockAdmit).toHaveBeenCalledWith(expect.objectContaining({ senderDisplay: "555" }));
    });
  });

  it("happy path: builds the channelId:messageId dedupe key and calls admitDiscordChannelMessage", async () => {
    const res = await POST(req({ token: SECRET, body: VALID_BODY }));
    expect(res.status).toBe(200);
    expect(mockAdmit).toHaveBeenCalledWith({
      channelId: "998877",
      providerMessageId: "998877:msg-1",
      senderId: "555",
      senderDisplay: "Ada",
      senderUsername: "ada",
      text: "what's the status?",
    });
    const json = await res.json();
    expect(json).toEqual({ ok: true, deduped: false });
  });

  it("reports deduped:true straight through", async () => {
    mockAdmit.mockResolvedValue({ deduped: true });
    const res = await POST(req({ token: SECRET, body: VALID_BODY }));
    const json = await res.json();
    expect(json).toEqual({ ok: true, deduped: true });
  });

  it("502 when the pipeline throws", async () => {
    mockAdmit.mockRejectedValue(new Error("pg down"));
    const res = await POST(req({ token: SECRET, body: VALID_BODY }));
    expect(res.status).toBe(502);
  });

  it("senderUsername defaults to null when absent", async () => {
    const { senderUsername, ...rest } = VALID_BODY;
    await POST(req({ token: SECRET, body: rest }));
    expect(mockAdmit).toHaveBeenCalledWith(expect.objectContaining({ senderUsername: null }));
  });
});
