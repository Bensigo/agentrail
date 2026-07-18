import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../app/api/v1/workspaces/[workspaceId]/connectors/secret/telegram", () => ({
  sendTelegramMessage: vi.fn(),
}));

import {
  sendSystemTelegramMessage,
  buildWorkspaceChoiceMessage,
  buildPinConfirmationMessage,
} from "./telegram-system-message";
import { sendTelegramMessage } from "../app/api/v1/workspaces/[workspaceId]/connectors/secret/telegram";

const mockSend = vi.mocked(sendTelegramMessage);
const ORIGINAL_TOKEN = process.env["TELEGRAM_BOT_TOKEN"];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) {
    delete process.env["TELEGRAM_BOT_TOKEN"];
  } else {
    process.env["TELEGRAM_BOT_TOKEN"] = ORIGINAL_TOKEN;
  }
});

describe("sendSystemTelegramMessage", () => {
  it("sends via the shared sendTelegramMessage helper using TELEGRAM_BOT_TOKEN", async () => {
    process.env["TELEGRAM_BOT_TOKEN"] = "bot-token-abc";
    mockSend.mockResolvedValue({ ok: true });

    const result = await sendSystemTelegramMessage("-100123", "hello");

    expect(result).toEqual({ ok: true });
    expect(mockSend).toHaveBeenCalledWith("bot-token-abc", "-100123", "hello");
  });

  it("returns a typed failure and never calls sendTelegramMessage when TELEGRAM_BOT_TOKEN is unset", async () => {
    delete process.env["TELEGRAM_BOT_TOKEN"];

    const result = await sendSystemTelegramMessage("-100123", "hello");

    expect(result).toEqual({
      ok: false,
      error: "TELEGRAM_BOT_TOKEN is not configured.",
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("propagates a send failure from the shared helper unchanged", async () => {
    process.env["TELEGRAM_BOT_TOKEN"] = "bot-token-abc";
    mockSend.mockResolvedValue({ ok: false, error: "Couldn't reach Telegram to send the message — try again." });

    const result = await sendSystemTelegramMessage("-100123", "hello");

    expect(result).toEqual({ ok: false, error: "Couldn't reach Telegram to send the message — try again." });
  });
});

describe("buildWorkspaceChoiceMessage", () => {
  it("numbers the options and asks for a reply by number or name", () => {
    const msg = buildWorkspaceChoiceMessage([
      { name: "Acme Corp" },
      { name: "Personal" },
    ]);

    expect(msg).toBe(
      [
        "You're in 2 workspaces. Which one is this about?",
        "1. Acme Corp",
        "2. Personal",
        "Reply with a number or the name.",
      ].join("\n"),
    );
  });

  it("renders a single-option list correctly (still asks, no markdown)", () => {
    const msg = buildWorkspaceChoiceMessage([{ name: "Only Workspace" }]);
    expect(msg).toBe(
      [
        "You're in 1 workspaces. Which one is this about?",
        "1. Only Workspace",
        "Reply with a number or the name.",
      ].join("\n"),
    );
    expect(msg).not.toMatch(/[*_`[\]]/);
  });
});

describe("buildPinConfirmationMessage", () => {
  it("names the workspace in a single line, plain text", () => {
    const msg = buildPinConfirmationMessage("Acme Corp");
    expect(msg.split("\n")).toHaveLength(1);
    expect(msg).toMatch(/Acme Corp/);
    expect(msg).not.toMatch(/[*_`[\]]/);
  });
});
