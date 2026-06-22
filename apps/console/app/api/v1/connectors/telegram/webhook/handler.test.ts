import { describe, it, expect } from "vitest";
import { decideReply, type QueueSnapshotEntry } from "./handler";

const CHAT = "12345";

const snapshot: QueueSnapshotEntry[] = [
  { externalId: "o/r#101", state: "running" },
  { externalId: "o/r#102", state: "queued" },
  { externalId: "o/r#103", state: "queued" },
  { externalId: "o/r#104", state: "escalated-to-human" },
  { externalId: "o/r#105", state: "green" }, // terminal, not counted in active buckets
];

function update(text: string | undefined, chatId: unknown = Number(CHAT)) {
  return { message: { text, chat: { id: chatId } } };
}

describe("decideReply — status", () => {
  it("/status returns the queue snapshot counts and issue numbers", () => {
    const reply = decideReply(update("/status"), CHAT, snapshot);
    expect(reply).not.toBeNull();
    expect(reply).toContain("1 running");
    expect(reply).toContain("2 queued");
    expect(reply).toContain("1 escalated");
    expect(reply).toContain("#101");
    expect(reply).toContain("#102");
    expect(reply).toContain("#104");
  });

  it("a plain 'status' (no slash) also returns the snapshot", () => {
    expect(decideReply(update("status"), CHAT, snapshot)).toContain("running");
  });

  it("a natural-language status question returns the snapshot", () => {
    expect(decideReply(update("what's the status?"), CHAT, snapshot)).toContain(
      "queued"
    );
  });

  it("/status with no active work says the queue is empty", () => {
    const reply = decideReply(update("/status"), CHAT, []);
    expect(reply).toContain("0 running");
    expect(reply).toContain("Nothing in the queue");
  });
});

describe("decideReply — help (AC4)", () => {
  it("unrecognized text returns a help message listing what it answers", () => {
    const reply = decideReply(update("hello bot"), CHAT, snapshot);
    expect(reply).toMatch(/\/status/);
  });

  it("a non-text message from the right chat returns help, not silence", () => {
    const reply = decideReply(update(undefined), CHAT, snapshot);
    expect(reply).toMatch(/\/status/);
  });
});

describe("decideReply — chat-id authorization (AC3)", () => {
  it("returns null when the incoming chat id != the connected chat id", () => {
    expect(decideReply(update("/status", 99999), CHAT, snapshot)).toBeNull();
  });

  it("matches when ids differ by type (numeric update vs string config)", () => {
    expect(decideReply(update("/status", 12345), "12345", snapshot)).not.toBeNull();
  });

  it("returns null when the connector has no configured chat id", () => {
    expect(decideReply(update("/status"), undefined, snapshot)).toBeNull();
    expect(decideReply(update("/status"), null, snapshot)).toBeNull();
  });
});

describe("decideReply — malformed / empty (AC5)", () => {
  it("returns null and does not throw on null/undefined update", () => {
    expect(decideReply(null, CHAT, snapshot)).toBeNull();
    expect(decideReply(undefined, CHAT, snapshot)).toBeNull();
  });

  it("returns null on an update with no message", () => {
    expect(decideReply({} as never, CHAT, snapshot)).toBeNull();
  });

  it("returns null when the message has no chat id", () => {
    expect(
      decideReply({ message: { text: "/status" } } as never, CHAT, snapshot)
    ).toBeNull();
  });
});
