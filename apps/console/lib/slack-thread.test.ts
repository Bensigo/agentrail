import { describe, expect, it } from "vitest";
import { resolveSlackThread } from "./slack-thread";

describe("resolveSlackThread", () => {
  it("roots a new thread at the user's own message in a channel", () => {
    expect(
      resolveSlackThread({ channel: "C123", ts: "1700000000.000100" })
    ).toEqual({
      conversationKey: "C123:1700000000.000100",
      threadTs: "1700000000.000100",
    });
  });

  it("continues an existing thread on its root ts, not the reply ts", () => {
    expect(
      resolveSlackThread({
        channel: "C123",
        ts: "1700000009.000900",
        thread_ts: "1700000000.000100",
      })
    ).toEqual({
      conversationKey: "C123:1700000000.000100",
      threadTs: "1700000000.000100",
    });
  });

  it("leaves a DM unthreaded and keyed on the channel", () => {
    expect(
      resolveSlackThread({
        channel: "D999",
        ts: "1700000000.000100",
        channel_type: "im",
      })
    ).toEqual({ conversationKey: "D999" });
  });

  it("keeps a DM keyed on the channel even inside a thread", () => {
    expect(
      resolveSlackThread({
        channel: "D999",
        ts: "1700000009.000900",
        thread_ts: "1700000000.000100",
        channel_type: "im",
      })
    ).toEqual({ conversationKey: "D999" });
  });

  it("falls back to the channel when ts is missing entirely", () => {
    expect(resolveSlackThread({ channel: "C123" })).toEqual({
      conversationKey: "C123",
    });
  });

  it("treats a blank thread_ts as absent", () => {
    expect(
      resolveSlackThread({ channel: "C123", ts: "1700000000.000100", thread_ts: "  " })
    ).toEqual({
      conversationKey: "C123:1700000000.000100",
      threadTs: "1700000000.000100",
    });
  });
});
