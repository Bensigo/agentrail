import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { generateKeyPairSync, sign as cryptoSign } from "crypto";

vi.mock("@agentrail/db-postgres", () => ({
  resolveInboundChatIdentity: vi.fn(),
  enqueueChannelMessage: vi.fn(),
}));

vi.mock("../../../../../../lib/channel-dispatch", () => ({
  dispatchQueuedChannelMessages: vi.fn(),
}));

import { POST } from "./route";
import { resolveInboundChatIdentity, enqueueChannelMessage } from "@agentrail/db-postgres";
import { dispatchQueuedChannelMessages } from "../../../../../../lib/channel-dispatch";

const mockResolve = vi.mocked(resolveInboundChatIdentity);
const mockEnqueue = vi.mocked(enqueueChannelMessage);
const mockDispatch = vi.mocked(dispatchQueuedChannelMessages);
mockDispatch.mockResolvedValue({ processed: 0, failed: 0 });

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY_HEX = publicKey
  .export({ type: "spki", format: "der" })
  .subarray(-32)
  .toString("hex");

function sign(timestamp: string, rawBody: string): string {
  return cryptoSign(null, Buffer.from(timestamp + rawBody), privateKey).toString("hex");
}

const ORIGINAL_PUBLIC_KEY_ENV = process.env["DISCORD_PUBLIC_KEY"];

function req(rawBody: string, opts: { signature?: string; timestamp?: string } = {}): NextRequest {
  const timestamp = opts.timestamp ?? "1700000000";
  const signature = opts.signature ?? sign(timestamp, rawBody);
  return new NextRequest("http://localhost/api/v1/connectors/discord/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-signature-ed25519": signature,
      "x-signature-timestamp": timestamp,
    },
    body: rawBody,
  });
}

const PING_BODY = JSON.stringify({ id: "int-1", type: 1 });

function commandBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: "int-42",
    type: 2,
    channel_id: "998877",
    data: { name: "jace", options: [{ name: "message", value: "hello jace" }] },
    user: { id: "555", username: "ada", global_name: "Ada" },
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDispatch.mockResolvedValue({ processed: 0, failed: 0 });
  process.env["DISCORD_PUBLIC_KEY"] = PUBLIC_KEY_HEX;
});

afterEach(() => {
  if (ORIGINAL_PUBLIC_KEY_ENV === undefined) {
    delete process.env["DISCORD_PUBLIC_KEY"];
  } else {
    process.env["DISCORD_PUBLIC_KEY"] = ORIGINAL_PUBLIC_KEY_ENV;
  }
});

describe("POST /api/v1/connectors/discord/webhook — verify (fail closed)", () => {
  it("401s when DISCORD_PUBLIC_KEY is unset, even with a well-formed signature header", async () => {
    delete process.env["DISCORD_PUBLIC_KEY"];

    const res = await POST(req(PING_BODY));

    expect(res.status).toBe(401);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("401s when the signature header is missing entirely", async () => {
    const request = new NextRequest("http://localhost/api/v1/connectors/discord/webhook", {
      method: "POST",
      headers: { "x-signature-timestamp": "1700000000" },
      body: PING_BODY,
    });
    const res = await POST(request);
    expect(res.status).toBe(401);
  });

  it("401s on a tampered body (signature computed over a different body)", async () => {
    const timestamp = "1700000000";
    const signature = sign(timestamp, PING_BODY);
    const request = new NextRequest("http://localhost/api/v1/connectors/discord/webhook", {
      method: "POST",
      headers: {
        "x-signature-ed25519": signature,
        "x-signature-timestamp": timestamp,
      },
      body: JSON.stringify({ id: "int-1", type: 2, tampered: true }),
    });
    const res = await POST(request);
    expect(res.status).toBe(401);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("401s on a signature from a different key entirely", async () => {
    const other = generateKeyPairSync("ed25519");
    const timestamp = "1700000000";
    const signature = cryptoSign(null, Buffer.from(timestamp + PING_BODY), other.privateKey).toString("hex");

    const res = await POST(req(PING_BODY, { signature, timestamp }));

    expect(res.status).toBe(401);
  });

  it("never enqueues when verification fails", async () => {
    delete process.env["DISCORD_PUBLIC_KEY"];
    const res = await POST(req(commandBody()));
    expect(res.status).toBe(401);
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/connectors/discord/webhook — PING handshake", () => {
  it("responds with { type: 1 } (PONG) to a PING", async () => {
    const res = await POST(req(PING_BODY));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 1 });
    expect(mockResolve).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/connectors/discord/webhook — parse", () => {
  it("400s on malformed JSON (after signature verification passes over the raw bytes)", async () => {
    const raw = "{not json";
    const timestamp = "1700000000";
    const signature = sign(timestamp, raw);
    const res = await POST(req(raw, { signature, timestamp }));

    expect(res.status).toBe(400);
  });

  it("400s on a well-formed but shapeless interaction (no id/type)", async () => {
    const raw = JSON.stringify({ foo: "bar" });
    const res = await POST(req(raw));

    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/connectors/discord/webhook — unhandled interaction types", () => {
  it("acks a MESSAGE_COMPONENT (type 3) minimally, without enqueuing", async () => {
    const raw = JSON.stringify({ id: "int-3", type: 3 });
    const res = await POST(req(raw));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe(4);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/connectors/discord/webhook — APPLICATION_COMMAND (a stranger DMing the bot)", () => {
  it("resolves identity and enqueues, anchoring on chatIdentityId for an unbound (intro) sender", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-1", workspaceId: null } as never,
      created: true,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: "row-1", deduped: false });

    const res = await POST(req(commandBody()));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe(4);
    expect(body.data.content).toMatch(/thinking/i);

    expect(mockResolve).toHaveBeenCalledWith({
      platform: "discord",
      platformUserId: "555",
      displayName: "Ada",
    });
    expect(mockEnqueue).toHaveBeenCalledWith({
      chatIdentityId: "chat-identity-1",
      channel: "discord",
      conversationKey: "998877",
      kind: "message",
      senderId: "555",
      senderDisplay: "Ada",
      providerMessageId: "998877:int-42",
      payload: {
        chatId: "998877",
        text: "hello jace",
        fromId: "555",
        fromUsername: "ada",
      },
    });
  });

  it("anchors on workspaceId (not chatIdentityId) for a bound identity", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-2", workspaceId: "ws-1" } as never,
      created: false,
      disposition: "bound",
    });
    mockEnqueue.mockResolvedValue({ id: "row-2", deduped: false });

    await POST(req(commandBody()));

    const enqueueArgs = mockEnqueue.mock.calls[0]?.[0];
    expect(enqueueArgs).toMatchObject({ workspaceId: "ws-1" });
    expect(enqueueArgs).not.toHaveProperty("chatIdentityId");
  });

  it("falls back to username when global_name is absent, and to the numeric id when both are absent", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-3", workspaceId: null } as never,
      created: true,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: "row-3", deduped: false });

    await POST(req(commandBody({ user: { id: "9", username: "ada_handle" } })));

    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "ada_handle" })
    );
  });

  it("resolves the invoking user from member.user for a guild-context interaction", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-4", workspaceId: null } as never,
      created: true,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: "row-4", deduped: false });

    await POST(
      req(
        commandBody({
          user: undefined,
          member: { user: { id: "777", username: "guildy" } },
        })
      )
    );

    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ platformUserId: "777", displayName: "guildy" })
    );
  });

  it("kicks the dispatcher fire-and-forget after a fresh enqueue", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-1", workspaceId: null } as never,
      created: true,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: "row-1", deduped: false });

    const res = await POST(req(commandBody()));

    expect(res.status).toBe(200);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it("never lets a dispatcher rejection surface into the route's response (fire-and-forget)", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-1", workspaceId: null } as never,
      created: true,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: "row-1", deduped: false });
    mockDispatch.mockRejectedValueOnce(new Error("drain blew up"));

    const res = await POST(req(commandBody()));

    expect(res.status).toBe(200);
  });

  it("acks politely without enqueuing when the command carries no text option", async () => {
    const res = await POST(req(commandBody({ data: { name: "jace", options: [] } })));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.flags).toBe(64);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
