import { describe, expect, it } from "vitest";
import { resolveSlackThread } from "./slack-thread";

describe("resolveSlackThread", () => {
  it("roots a new thread at the user's own message in a channel, team-scoped", () => {
    expect(
      resolveSlackThread({ channel: "C123", ts: "1700000000.000100" }, "T1")
    ).toStrictEqual({
      conversationKey: "T1:C123:1700000000.000100",
      threadTs: "1700000000.000100",
    });
  });

  it("continues an existing thread on its root ts, not the reply ts", () => {
    expect(
      resolveSlackThread(
        {
          channel: "C123",
          ts: "1700000009.000900",
          thread_ts: "1700000000.000100",
        },
        "T1"
      )
    ).toStrictEqual({
      conversationKey: "T1:C123:1700000000.000100",
      threadTs: "1700000000.000100",
    });
  });

  // Final whole-branch review, finding #2: an unscoped conversationKey lets a
  // colliding channel/thread id from a DIFFERENT team ride that team's
  // existing pin — this proves the same channel/thread id from two different
  // teams never produces the same key.
  it("the SAME channel/thread id from two DIFFERENT teams yields DIFFERENT conversationKeys", () => {
    const teamA = resolveSlackThread({ channel: "C123", ts: "1700000000.000100" }, "T111");
    const teamB = resolveSlackThread({ channel: "C123", ts: "1700000000.000100" }, "T222");

    expect(teamA.conversationKey).not.toBe(teamB.conversationKey);
    expect(teamA.conversationKey).toBe("T111:C123:1700000000.000100");
    expect(teamB.conversationKey).toBe("T222:C123:1700000000.000100");
  });

  it("leaves a DM unthreaded but still team-scopes the channel key", () => {
    const result = resolveSlackThread(
      {
        channel: "D999",
        ts: "1700000000.000100",
        channel_type: "im",
      },
      "T1"
    );
    expect(result).toStrictEqual({ conversationKey: "T1:D999" });
    expect(result).not.toHaveProperty("threadTs");
  });

  it("a DM's channel id colliding across two teams still yields different keys", () => {
    const teamA = resolveSlackThread({ channel: "D999", channel_type: "im" }, "T111");
    const teamB = resolveSlackThread({ channel: "D999", channel_type: "im" }, "T222");
    expect(teamA.conversationKey).not.toBe(teamB.conversationKey);
  });

  it("keeps a DM keyed on the channel even inside a thread", () => {
    const result = resolveSlackThread(
      {
        channel: "D999",
        ts: "1700000009.000900",
        thread_ts: "1700000000.000100",
        channel_type: "im",
      },
      "T1"
    );
    expect(result).toStrictEqual({ conversationKey: "T1:D999" });
    expect(result).not.toHaveProperty("threadTs");
  });

  it("falls back to the team-scoped channel when ts is missing entirely", () => {
    const result = resolveSlackThread({ channel: "C123" }, "T1");
    expect(result).toStrictEqual({
      conversationKey: "T1:C123",
    });
    expect(result).not.toHaveProperty("threadTs");
  });

  it("treats a blank thread_ts as absent", () => {
    expect(
      resolveSlackThread({ channel: "C123", ts: "1700000000.000100", thread_ts: "  " }, "T1")
    ).toStrictEqual({
      conversationKey: "T1:C123:1700000000.000100",
      threadTs: "1700000000.000100",
    });
  });
});
