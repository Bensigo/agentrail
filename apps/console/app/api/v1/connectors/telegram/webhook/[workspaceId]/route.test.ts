import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getConnector: vi.fn(),
  getConnectorSecret: vi.fn(),
  listQueueEntries: vi.fn(),
}));
vi.mock("../../../../workspaces/[workspaceId]/connectors/secret/telegram", () => ({
  sendTelegramMessage: vi.fn(),
}));

import { POST } from "./route";
import {
  getConnector,
  getConnectorSecret,
  listQueueEntries,
} from "@agentrail/db-postgres";
import { sendTelegramMessage } from "../../../../workspaces/[workspaceId]/connectors/secret/telegram";

const mockGetConnector = vi.mocked(getConnector);
const mockGetSecret = vi.mocked(getConnectorSecret);
const mockListQueue = vi.mocked(listQueueEntries);
const mockSend = vi.mocked(sendTelegramMessage);

const WS = "ws-1";
const SECRET = "stored-webhook-secret";
const CHAT = "12345";

function connector(overrides: Record<string, unknown> = {}) {
  return {
    provider: "telegram" as const,
    enabled: true,
    config: {
      repos: [],
      triggerLabel: "x",
      pollIntervalSeconds: 60,
      chatId: CHAT,
      webhookSecret: SECRET,
    },
    hasSecret: true,
    updatedAt: null,
    ...overrides,
  };
}

function req(body: unknown, secretHeader?: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/connectors/telegram/webhook/${WS}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secretHeader !== undefined
          ? { "X-Telegram-Bot-Api-Secret-Token": secretHeader }
          : {}),
      },
      body: JSON.stringify(body),
    }
  );
}

const params = Promise.resolve({ workspaceId: WS });

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue({ ok: true });
  mockGetSecret.mockResolvedValue("bot-token");
  mockListQueue.mockResolvedValue([
    { id: "1", externalId: "o/r#101", title: "t", tier: 0, remainingBudget: 5, state: "running", updatedAt: "" },
  ]);
});

describe("telegram webhook route — auth", () => {
  it("ignores a request with NO secret header (no handler invoked)", async () => {
    mockGetConnector.mockResolvedValue(connector());
    const res = await POST(req({ message: { text: "/status", chat: { id: 12345 } } }), {
      params,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: "bad secret token" });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockListQueue).not.toHaveBeenCalled();
  });

  it("ignores a request with the WRONG secret header", async () => {
    mockGetConnector.mockResolvedValue(connector());
    const res = await POST(
      req({ message: { text: "/status", chat: { id: 12345 } } }, "wrong"),
      { params }
    );
    expect(res.status).toBe(200);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("ignores when telegram is not connected / no webhook secret stored", async () => {
    mockGetConnector.mockResolvedValue(null);
    const res = await POST(
      req({ message: { text: "/status", chat: { id: 12345 } } }, SECRET),
      { params }
    );
    expect(res.status).toBe(200);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("telegram webhook route — valid delivery", () => {
  it("a valid secret + /status from the connected chat sends a reply", async () => {
    mockGetConnector.mockResolvedValue(connector());
    const res = await POST(
      req({ message: { text: "/status", chat: { id: 12345 } } }, SECRET),
      { params }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replied: true });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const [, chatId, text] = mockSend.mock.calls[0];
    expect(chatId).toBe(CHAT);
    expect(text).toContain("running");
  });

  it("a valid secret from a DIFFERENT chat does not reply (no leak)", async () => {
    mockGetConnector.mockResolvedValue(connector());
    const res = await POST(
      req({ message: { text: "/status", chat: { id: 99999 } } }, SECRET),
      { params }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replied: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("a malformed body never 500s (AC5)", async () => {
    mockGetConnector.mockResolvedValue(connector());
    const bad = new NextRequest(
      `http://localhost/api/v1/connectors/telegram/webhook/${WS}`,
      {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET },
        body: "not json{",
      }
    );
    const res = await POST(bad, { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replied: false });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

// #1031: the secret-token compare is now constant-time (timingSafeEqual +
// length guard) instead of a plain `!==`. These lock in the three cases that
// matter for that compare: an exact match still processes the update, a
// same-length mismatch is ignored, and a DIFFERENT-length header must not
// throw (timingSafeEqual throws on unequal-length buffers unless guarded).
describe("telegram webhook route — constant-time secret compare (#1031)", () => {
  it("MATCH: an exact-secret delivery is authenticated and processed", async () => {
    mockGetConnector.mockResolvedValue(connector());
    const res = await POST(
      req({ message: { text: "/status", chat: { id: 12345 } } }, SECRET),
      { params }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replied: true });
    // Authenticated → the handler did real work (read the queue, sent a reply).
    expect(mockListQueue).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("MISMATCH (same length): a wrong secret of equal length is ignored", async () => {
    mockGetConnector.mockResolvedValue(connector());
    // Same byte length as SECRET, different content — exercises timingSafeEqual
    // returning false rather than the length guard short-circuiting.
    const sameLenWrong = "x".repeat(SECRET.length);
    expect(sameLenWrong.length).toBe(SECRET.length);
    const res = await POST(
      req({ message: { text: "/status", chat: { id: 12345 } } }, sameLenWrong),
      { params }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: "bad secret token" });
    expect(mockSend).not.toHaveBeenCalled();
    // Rejected at the auth gate — never reached the queue read.
    expect(mockListQueue).not.toHaveBeenCalled();
  });

  it("LENGTH MISMATCH: a shorter/longer secret is ignored, not thrown (200)", async () => {
    mockGetConnector.mockResolvedValue(connector());
    // Different length would make an unguarded timingSafeEqual throw; the length
    // guard must turn it into a plain non-match and still return 200.
    for (const wrong of ["short", `${SECRET}-and-then-some-extra`]) {
      vi.clearAllMocks();
      mockSend.mockResolvedValue({ ok: true });
      mockGetSecret.mockResolvedValue("bot-token");
      mockGetConnector.mockResolvedValue(connector());
      const res = await POST(
        req({ message: { text: "/status", chat: { id: 12345 } } }, wrong),
        { params }
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ignored: "bad secret token" });
      expect(mockSend).not.toHaveBeenCalled();
    }
  });
});
