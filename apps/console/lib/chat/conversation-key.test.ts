import { describe, it, expect } from "vitest";
import { consoleConversationKey, CONSOLE_CHAT_THREAD_N } from "./conversation-key";

describe("consoleConversationKey", () => {
  it("builds console:<userId>:1 by default (single persistent thread per member)", () => {
    expect(consoleConversationKey("user-42")).toBe("console:user-42:1");
    expect(CONSOLE_CHAT_THREAD_N).toBe(1);
  });

  it("accepts an explicit n for a future multi-thread UI", () => {
    expect(consoleConversationKey("user-42", 2)).toBe("console:user-42:2");
  });

  it("two different users never collide", () => {
    expect(consoleConversationKey("user-a")).not.toBe(consoleConversationKey("user-b"));
  });
});
