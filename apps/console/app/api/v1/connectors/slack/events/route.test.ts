import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "crypto";

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

const SIGNING_SECRET = "shhh-its-a-secret";
const ORIGINAL_SECRET_ENV = process.env["SLACK_SIGNING_SECRET"];

function sign(timestamp: string, rawBody: string, secret = SIGNING_SECRET): string {
  const basestring = `v0:${timestamp}:${rawBody}`;
  return `v0=${createHmac("sha256", secret).update(basestring).digest("hex")}`;
}

// Fixed "now" for every request in this file so signatures never go stale
// mid-suite; verifySlackSignature's real clock is exercised in slack-bot.test.ts.
const NOW = Math.floor(Date.now() / 1000);

function req(rawBody: string, opts: { signature?: string; timestamp?: string } = {}): NextRequest {
  const timestamp = opts.timestamp ?? String(NOW);
  const signature = opts.signature ?? sign(timestamp, rawBody);
  return new NextRequest("http://localhost/api/v1/connectors/slack/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": timestamp,
    },
    body: rawBody,
  });
}

const URL_VERIFICATION_BODY = JSON.stringify({
  token: "Jhj5dZrVaK7ZwHHjRyZWjbDl",
  challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
  type: "url_verification",
});

function messageEventBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    token: "tok",
    team_id: "T1",
    api_app_id: "A1",
    event: {
      type: "message",
      channel: "D0PNCRP9N",
      user: "U061F7AUR",
      text: "hello jace",
      ts: "1515449483.000078",
      channel_type: "im",
      ...((overrides.event as Record<string, unknown>) ?? {}),
    },
    type: "event_callback",
    event_id: "Ev0PV52K21",
    event_time: 1515449483,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDispatch.mockResolvedValue({ processed: 0, failed: 0 });
  process.env["SLACK_SIGNING_SECRET"] = SIGNING_SECRET;
});

afterEach(() => {
  if (ORIGINAL_SECRET_ENV === undefined) {
    delete process.env["SLACK_SIGNING_SECRET"];
  } else {
    process.env["SLACK_SIGNING_SECRET"] = ORIGINAL_SECRET_ENV;
  }
});

describe("POST /api/v1/connectors/slack/events — verify (fail closed)", () => {
  it("401s when SLACK_SIGNING_SECRET is unset, even with a well-formed signature header", async () => {
    delete process.env["SLACK_SIGNING_SECRET"];

    const res = await POST(req(URL_VERIFICATION_BODY));

    expect(res.status).toBe(401);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("401s when the signature header is missing entirely", async () => {
    const request = new NextRequest("http://localhost/api/v1/connectors/slack/events", {
      method: "POST",
      headers: { "x-slack-request-timestamp": String(NOW) },
      body: URL_VERIFICATION_BODY,
    });
    const res = await POST(request);
    expect(res.status).toBe(401);
  });

  it("401s on a tampered body", async () => {
    const timestamp = String(NOW);
    const signature = sign(timestamp, URL_VERIFICATION_BODY);
    const request = new NextRequest("http://localhost/api/v1/connectors/slack/events", {
      method: "POST",
      headers: { "x-slack-signature": signature, "x-slack-request-timestamp": timestamp },
      body: JSON.stringify({ type: "url_verification", challenge: "tampered" }),
    });
    const res = await POST(request);
    expect(res.status).toBe(401);
  });

  it("401s on a signature from the wrong signing secret", async () => {
    const timestamp = String(NOW);
    const signature = sign(timestamp, URL_VERIFICATION_BODY, "wrong-secret");

    const res = await POST(req(URL_VERIFICATION_BODY, { signature, timestamp }));

    expect(res.status).toBe(401);
  });

  it("never enqueues when verification fails", async () => {
    delete process.env["SLACK_SIGNING_SECRET"];
    const res = await POST(req(messageEventBody()));
    expect(res.status).toBe(401);
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/connectors/slack/events — url_verification challenge", () => {
  it("echoes the challenge back verbatim", async () => {
    const res = await POST(req(URL_VERIFICATION_BODY));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" });
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("400s when url_verification carries no challenge string", async () => {
    const raw = JSON.stringify({ type: "url_verification" });
    const res = await POST(req(raw));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/connectors/slack/events — parse", () => {
  it("400s on malformed JSON (after signature verification passes over the raw bytes)", async () => {
    const raw = "{not json";
    const timestamp = String(NOW);
    const signature = sign(timestamp, raw);
    const res = await POST(req(raw, { signature, timestamp }));

    expect(res.status).toBe(400);
  });

  it("400s on a well-formed but shapeless body (no type)", async () => {
    const res = await POST(req(JSON.stringify({ foo: "bar" })));
    expect(res.status).toBe(400);
  });

  it("acks (200, ignored) an event_callback type with no event.type == message, e.g. a future unhandled top-level type", async () => {
    const res = await POST(req(JSON.stringify({ type: "app_rate_limited" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
  });
});

describe("POST /api/v1/connectors/slack/events — bot-loop / noise guard", () => {
  it("ignores an event carrying bot_id (this bot's own post, or another bot's)", async () => {
    const res = await POST(req(messageEventBody({ event: { bot_id: "B123" } })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("ignores an event carrying any subtype (e.g. message_changed)", async () => {
    const res = await POST(req(messageEventBody({ event: { subtype: "message_changed" } })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("ignores a non-'message' event type (e.g. app_mention, out of scope for this door)", async () => {
    const res = await POST(req(messageEventBody({ event: { type: "app_mention" } })));
    expect(res.status).toBe(200);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("ignores a message with blank text", async () => {
    const res = await POST(req(messageEventBody({ event: { text: "   " } })));
    expect(res.status).toBe(200);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/connectors/slack/events — event_callback message (a stranger DMing the app)", () => {
  it("resolves identity and enqueues, anchoring on chatIdentityId for an unbound (intro) sender", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-1", workspaceId: null } as never,
      created: true,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: "row-1", deduped: false });

    const res = await POST(req(messageEventBody()));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(mockResolve).toHaveBeenCalledWith({
      platform: "slack",
      platformUserId: "U061F7AUR",
    });
    expect(mockEnqueue).toHaveBeenCalledWith({
      chatIdentityId: "chat-identity-1",
      channel: "slack",
      conversationKey: "D0PNCRP9N",
      kind: "message",
      senderId: "U061F7AUR",
      providerMessageId: "D0PNCRP9N:Ev0PV52K21",
      payload: {
        chatId: "D0PNCRP9N",
        text: "hello jace",
        fromId: "U061F7AUR",
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

    await POST(req(messageEventBody()));

    const enqueueArgs = mockEnqueue.mock.calls[0]?.[0];
    expect(enqueueArgs).toMatchObject({ workspaceId: "ws-1" });
    expect(enqueueArgs).not.toHaveProperty("chatIdentityId");
  });

  it("returns { ok: true, deduped: true } on a redelivered event_id, without erroring", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-1", workspaceId: null } as never,
      created: false,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: null, deduped: true });

    const res = await POST(req(messageEventBody()));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deduped: true });
  });

  it("kicks the dispatcher fire-and-forget after a fresh enqueue", async () => {
    mockResolve.mockResolvedValue({
      identity: { id: "chat-identity-1", workspaceId: null } as never,
      created: true,
      disposition: "intro",
    });
    mockEnqueue.mockResolvedValue({ id: "row-1", deduped: false });

    const res = await POST(req(messageEventBody()));

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

    const res = await POST(req(messageEventBody()));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
