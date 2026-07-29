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

/** What the route should hand `admitDiscordChannelMessage` given VALID_BODY
 * with none of the (optional-on-the-wire) engagement fields set — every one
 * degrades to its safe default. */
const EXPECTED_ADMIT_ARGS_DEFAULTS = {
  channelId: "998877",
  providerMessageId: "998877:msg-1",
  senderId: "555",
  senderDisplay: "Ada",
  senderUsername: "ada",
  text: "what's the status?",
  threadId: null,
  mentionsBot: false,
  mentionsOtherUsers: false,
  repliesToMessageId: null,
  repliesToBot: false,
  // Jace-opens-threads Task 2: this route already requires messageId (see
  // the "400 when messageId is missing" test below) and always passes the
  // REAL Gateway message id straight through — never conditionally omitted
  // here, unlike discord-inbound.ts's own tolerant handling of a caller that
  // has none (the slash-command webhook door).
  messageId: "msg-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = SECRET;
  mockAdmit.mockResolvedValue({ deduped: false, skipped: false });
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
    expect(mockAdmit).toHaveBeenCalledWith(EXPECTED_ADMIT_ARGS_DEFAULTS);
    const json = await res.json();
    expect(json).toEqual({ ok: true, deduped: false });
  });

  it("reports deduped:true straight through", async () => {
    mockAdmit.mockResolvedValue({ deduped: true, skipped: false });
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

  // Jace-opens-threads Task 2: this route is the ONLY Discord door that has a
  // real Gateway message id — channel-dispatch.ts's thread-relocation feature
  // needs it to create a thread from the mentioning message. A distinct value
  // from VALID_BODY.messageId (not reusing "msg-1", which every other test's
  // dedupe-key assertion already pins) so this specifically catches a
  // hardcoded/dropped field, not just a coincidental match.
  it("passes the real Gateway messageId straight through to admitDiscordChannelMessage", async () => {
    await POST(req({ token: SECRET, body: { ...VALID_BODY, messageId: "gw-msg-999" } }));
    expect(mockAdmit).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "gw-msg-999", providerMessageId: "998877:gw-msg-999" })
    );
  });

  describe("engagement envelope (spec: docs/superpowers/specs/2026-07-28-thread-native-jace-design.md)", () => {
    it("passes threadId/mentionsBot/mentionsOtherUsers/repliesToMessageId/repliesToBot straight through when all are well-formed", async () => {
      await POST(
        req({
          token: SECRET,
          body: {
            ...VALID_BODY,
            threadId: "thread-42",
            mentionsBot: true,
            mentionsOtherUsers: true,
            repliesToMessageId: "msg-9",
            repliesToBot: true,
          },
        })
      );

      expect(mockAdmit).toHaveBeenCalledWith({
        ...EXPECTED_ADMIT_ARGS_DEFAULTS,
        threadId: "thread-42",
        mentionsBot: true,
        mentionsOtherUsers: true,
        repliesToMessageId: "msg-9",
        repliesToBot: true,
      });
    });

    it("every envelope field degrades to its safe default when absent from the body", async () => {
      await POST(req({ token: SECRET, body: VALID_BODY }));
      expect(mockAdmit).toHaveBeenCalledWith(EXPECTED_ADMIT_ARGS_DEFAULTS);
    });

    it("degrades to safe defaults on malformed (non-string/non-boolean) envelope fields, never crashes", async () => {
      await POST(
        req({
          token: SECRET,
          body: {
            ...VALID_BODY,
            threadId: 12345,
            mentionsBot: "true",
            mentionsOtherUsers: 1,
            repliesToMessageId: {},
            repliesToBot: "yes",
          },
        })
      );

      expect(mockAdmit).toHaveBeenCalledWith(EXPECTED_ADMIT_ARGS_DEFAULTS);
    });

    it("{ ok: true, skipped: true }, no deduped key, when the engagement gate drops the message", async () => {
      mockAdmit.mockResolvedValue({ deduped: false, skipped: true });
      const res = await POST(req({ token: SECRET, body: VALID_BODY }));

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ ok: true, skipped: true });
      expect(json).not.toHaveProperty("deduped");
    });
  });
});
