import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./slack-bot", () => ({
  sendSlackChannelMessage: vi.fn(),
}));

import { sendSlackChannelMessage } from "./slack-bot";
import { sendSystemSlackMessage } from "./slack-system-message";

const mockSend = vi.mocked(sendSlackChannelMessage);
const ORIGINAL_TOKEN = process.env["SLACK_BOT_TOKEN"];

beforeEach(() => {
  vi.clearAllMocks();
  process.env["SLACK_BOT_TOKEN"] = "xoxb-test";
  mockSend.mockResolvedValue({ ok: true });
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) {
    delete process.env["SLACK_BOT_TOKEN"];
  } else {
    process.env["SLACK_BOT_TOKEN"] = ORIGINAL_TOKEN;
  }
});

describe("sendSystemSlackMessage", () => {
  it("returns a typed failure when SLACK_BOT_TOKEN is unset", async () => {
    delete process.env["SLACK_BOT_TOKEN"];

    const result = await sendSystemSlackMessage("C123", "hi");

    expect(result).toEqual({ ok: false, error: "SLACK_BOT_TOKEN is not configured." });
    expect(mockSend).not.toHaveBeenCalled();
  });

  // Final whole-branch review, finding #1: this wrapper must forward a
  // caller-supplied thread id through to sendSlackChannelMessage so the
  // console's own system sends (workspace picker, /connect, pin
  // confirmation) land in the right thread instead of posting flat.
  it("forwards a thread id through to sendSlackChannelMessage", async () => {
    await sendSystemSlackMessage("C123", "hi", "1700000000.000100");

    expect(mockSend).toHaveBeenCalledWith("xoxb-test", "C123", "hi", "1700000000.000100");
  });

  it("passes no thread id through when none is given (a DM)", async () => {
    await sendSystemSlackMessage("D0PNCRP9N", "hi");

    expect(mockSend).toHaveBeenCalledWith("xoxb-test", "D0PNCRP9N", "hi", undefined);
  });
});
