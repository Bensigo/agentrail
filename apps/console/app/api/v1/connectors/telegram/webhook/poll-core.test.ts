import { describe, it, expect, vi } from "vitest";
import { processPollBatch, type PollUpdate } from "./poll-core";
import type { QueueSnapshotEntry } from "./handler";

const CHAT = "12345";

const snapshot: QueueSnapshotEntry[] = [
  { externalId: "o/r#101", state: "running" },
  { externalId: "o/r#102", state: "queued" },
  { externalId: "o/r#104", state: "escalated-to-human" },
];

function upd(update_id: number, text: string | undefined, chatId: unknown = Number(CHAT)): PollUpdate {
  return { update_id, message: { text, chat: { id: chatId } } };
}

describe("processPollBatch — authorized /status (reuses decideReply)", () => {
  it("replies with the queue snapshot for an authorized /status", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const res = await processPollBatch({
      updates: [upd(10, "/status")],
      chatId: CHAT,
      snapshot,
      send,
    });
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0][0] as string;
    // The exact status text comes from decideReply — confirm we forwarded it.
    expect(sent).toContain("1 running");
    expect(sent).toContain("#101");
    expect(res.replied).toBe(1);
    expect(res.processed).toBe(1);
  });
});

describe("processPollBatch — unauthorized chat (no second auth path)", () => {
  it("sends nothing when the chat id does not match the connector chatId", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const res = await processPollBatch({
      updates: [upd(20, "/status", 99999)],
      chatId: CHAT,
      snapshot,
      send,
    });
    expect(send).not.toHaveBeenCalled();
    expect(res.replied).toBe(0);
    // Still advances the cursor so the unauthorized update isn't reprocessed.
    expect(res.processed).toBe(1);
    expect(res.offset).toBe(21);
  });

  it("sends nothing when the connector has no configured chatId", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const res = await processPollBatch({
      updates: [upd(30, "/status")],
      chatId: undefined,
      snapshot,
      send,
    });
    expect(send).not.toHaveBeenCalled();
    expect(res.replied).toBe(0);
  });
});

describe("processPollBatch — offset advancement", () => {
  it("advances the offset past the highest processed update_id", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const res = await processPollBatch({
      updates: [upd(40, "/status"), upd(41, "hi"), upd(42, "/status")],
      chatId: CHAT,
      snapshot,
      offset: 40,
      send,
    });
    expect(res.offset).toBe(43);
    expect(res.processed).toBe(3);
    // /status x2 reply, "hi" gets a help reply too (decideReply replies to help).
    expect(res.replied).toBe(3);
  });

  it("keeps the incoming offset when the batch is empty", async () => {
    const send = vi.fn();
    const res = await processPollBatch({
      updates: [],
      chatId: CHAT,
      snapshot,
      offset: 99,
      send,
    });
    expect(res.offset).toBe(99);
    expect(res.processed).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("never moves the offset backwards", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const res = await processPollBatch({
      // a stale/lower update_id than the current offset
      updates: [upd(5, "/status")],
      chatId: CHAT,
      snapshot,
      offset: 100,
      send,
    });
    expect(res.offset).toBe(100);
  });
});

describe("processPollBatch — malformed update is swallowed (no throw)", () => {
  it("does not throw and replies nothing for a malformed update", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const bad = { update_id: 50 } as PollUpdate; // no message
    const res = await processPollBatch({
      updates: [bad],
      chatId: CHAT,
      snapshot,
      send,
    });
    expect(send).not.toHaveBeenCalled();
    expect(res.replied).toBe(0);
    // It still advances past the malformed update so the loop doesn't wedge.
    expect(res.offset).toBe(51);
  });

  it("skips an update with a non-numeric update_id without touching the offset", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const bad = { update_id: "nope" } as unknown as PollUpdate;
    const res = await processPollBatch({
      updates: [bad],
      chatId: CHAT,
      snapshot,
      offset: 7,
      send,
    });
    expect(res.processed).toBe(0);
    expect(res.offset).toBe(7);
  });

  it("a send failure does not abort the batch or lose the cursor", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("telegram down"))
      .mockResolvedValue(undefined);
    const res = await processPollBatch({
      updates: [upd(60, "/status"), upd(61, "/status")],
      chatId: CHAT,
      snapshot,
      send,
    });
    // Both attempted; the throw on the first was swallowed.
    expect(send).toHaveBeenCalledTimes(2);
    expect(res.offset).toBe(62);
    expect(res.processed).toBe(2);
  });
});
