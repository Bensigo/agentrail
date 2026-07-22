import { describe, expect, it } from "vitest";
import { mergeChatMessages, highestSeq, type ChatMessage } from "./chat-helpers";

function msg(seq: number, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `m-${seq}`,
    seq,
    role: "user",
    text: `message ${seq}`,
    created_at: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    ...overrides,
  };
}

describe("mergeChatMessages", () => {
  it("appends new messages after existing ones, sorted ascending by seq", () => {
    const existing = [msg(1), msg(2)];
    const incoming = [msg(3), msg(4)];
    expect(mergeChatMessages(existing, incoming).map((m) => m.seq)).toEqual([1, 2, 3, 4]);
  });

  it("de-duplicates by seq — a re-sent message never appears twice", () => {
    const existing = [msg(1), msg(2)];
    const incoming = [msg(2), msg(3)];
    const result = mergeChatMessages(existing, incoming);
    expect(result.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it("a re-sent seq keeps the INCOMING copy (in case content ever legitimately differs)", () => {
    const existing = [msg(1, { text: "stale" })];
    const incoming = [msg(1, { text: "fresh" })];
    expect(mergeChatMessages(existing, incoming)[0]?.text).toBe("fresh");
  });

  it("handles an empty incoming list (no-op poll)", () => {
    const existing = [msg(1), msg(2)];
    expect(mergeChatMessages(existing, [])).toEqual(existing);
  });

  it("handles an empty existing list (first load)", () => {
    const incoming = [msg(1), msg(2)];
    expect(mergeChatMessages([], incoming).map((m) => m.seq)).toEqual([1, 2]);
  });

  it("out-of-order incoming still sorts correctly", () => {
    const result = mergeChatMessages([], [msg(3), msg(1), msg(2)]);
    expect(result.map((m) => m.seq)).toEqual([1, 2, 3]);
  });
});

describe("highestSeq", () => {
  it("returns the max seq across the list", () => {
    expect(highestSeq([msg(1), msg(5), msg(3)])).toBe(5);
  });

  it("returns 0 for an empty list — the fresh-thread cursor", () => {
    expect(highestSeq([])).toBe(0);
  });
});
