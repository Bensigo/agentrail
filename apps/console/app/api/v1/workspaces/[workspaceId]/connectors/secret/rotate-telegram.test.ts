import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@agentrail/db-postgres", () => ({
  getConnector: vi.fn(),
  getConnectorSecret: vi.fn(),
  upsertConnector: vi.fn(),
}));
vi.mock("./telegram", () => ({
  setTelegramWebhook: vi.fn(),
}));

import { rotateTelegramWebhookSecret } from "./rotate-telegram";
import {
  getConnector,
  getConnectorSecret,
  upsertConnector,
} from "@agentrail/db-postgres";
import { setTelegramWebhook } from "./telegram";

const mockGetConnector = vi.mocked(getConnector);
const mockGetSecret = vi.mocked(getConnectorSecret);
const mockUpsert = vi.mocked(upsertConnector);
const mockSetWebhook = vi.mocked(setTelegramWebhook);

const WS = "ws-1";
const OLD_SECRET = "old-webhook-secret";

function connector(overrides: Record<string, unknown> = {}) {
  return {
    provider: "telegram" as const,
    enabled: true,
    config: {
      repos: [],
      triggerLabel: "x",
      pollIntervalSeconds: 60,
      chatId: "12345",
      webhookSecret: OLD_SECRET,
    },
    hasSecret: true,
    updatedAt: null,
    ...overrides,
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  process.env["AGENTRAIL_SERVER_BASE_URL"] = "https://agentrail.example.com";
  mockGetConnector.mockResolvedValue(connector());
  mockGetSecret.mockResolvedValue("bot-token");
  mockSetWebhook.mockResolvedValue({ ok: true });
  mockUpsert.mockResolvedValue(undefined as never);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("rotateTelegramWebhookSecret (#1031)", () => {
  it("generates a fresh secret, re-registers the webhook, and persists it", async () => {
    const res = await rotateTelegramWebhookSecret(WS);
    expect(res).toEqual({ ok: true, secretRotated: true });

    // Re-registered via the same connect-time machinery, at the same URL shape.
    expect(mockSetWebhook).toHaveBeenCalledTimes(1);
    const [token, url, secretToken] = mockSetWebhook.mock.calls[0];
    expect(token).toBe("bot-token");
    expect(url).toBe(
      `https://agentrail.example.com/api/v1/connectors/telegram/webhook/${WS}`
    );
    // The new secret is a fresh 32-byte hex nonce, NOT the old one.
    expect(secretToken).toMatch(/^[0-9a-f]{64}$/);
    expect(secretToken).not.toBe(OLD_SECRET);

    // Persisted the SAME new secret that was registered, and only that key.
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const [wsArg, providerArg, update] = mockUpsert.mock.calls[0];
    expect(wsArg).toBe(WS);
    expect(providerArg).toBe("telegram");
    expect(update).toEqual({ config: { webhookSecret: secretToken } });
  });

  it("re-registers BEFORE persisting (order: setWebhook then upsert)", async () => {
    const order: string[] = [];
    mockSetWebhook.mockImplementation(async () => {
      order.push("setWebhook");
      return { ok: true };
    });
    mockUpsert.mockImplementation(async () => {
      order.push("upsert");
      return undefined as never;
    });
    await rotateTelegramWebhookSecret(WS);
    expect(order).toEqual(["setWebhook", "upsert"]);
  });

  it("does NOT persist when re-registration fails (old secret survives)", async () => {
    mockSetWebhook.mockResolvedValue({ ok: false, error: "Telegram rejected it" });
    const res = await rotateTelegramWebhookSecret(WS);
    expect(res).toEqual({ ok: false, error: "Telegram rejected it" });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("fails cleanly when telegram is not connected", async () => {
    mockGetConnector.mockResolvedValue(null);
    const res = await rotateTelegramWebhookSecret(WS);
    expect(res.ok).toBe(false);
    expect(mockSetWebhook).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("fails cleanly when the connector is disabled", async () => {
    mockGetConnector.mockResolvedValue(connector({ enabled: false }));
    const res = await rotateTelegramWebhookSecret(WS);
    expect(res.ok).toBe(false);
    expect(mockSetWebhook).not.toHaveBeenCalled();
  });

  it("fails cleanly when the bot token is missing", async () => {
    mockGetSecret.mockResolvedValue(null);
    const res = await rotateTelegramWebhookSecret(WS);
    expect(res.ok).toBe(false);
    expect(mockSetWebhook).not.toHaveBeenCalled();
  });

  it("fails cleanly (nothing to rotate) when no public base URL is set", async () => {
    delete process.env["AGENTRAIL_SERVER_BASE_URL"];
    delete process.env["NEXTAUTH_URL"];
    delete process.env["VERCEL_URL"];
    const res = await rotateTelegramWebhookSecret(WS);
    expect(res.ok).toBe(false);
    expect(mockSetWebhook).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("never throws — a thrown dependency is caught as a typed failure", async () => {
    mockSetWebhook.mockRejectedValue(new Error("boom"));
    const res = await rotateTelegramWebhookSecret(WS);
    expect(res.ok).toBe(false);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
