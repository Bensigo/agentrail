import { describe, it, expect, beforeEach, vi } from "vitest";

// The db module is mocked (matching the rest of this package's test suite —
// there is no live-Postgres testing here). `db.execute` is stubbed per test
// to return the raw (snake_case) rows Postgres would hand back, so these
// tests exercise the camelCase mapping and the true/false requeue contract
// rather than real SQL filtering.
const mockState = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock("../db.js", () => ({
  db: {
    execute: mockState.execute,
  },
}));

import {
  deadLettersForWorkspace,
  requeueDeadChannelMessage,
} from "./channel_inbox.js";

describe("deadLettersForWorkspace", () => {
  beforeEach(() => {
    mockState.execute.mockReset();
  });

  it("maps dead-lettered rows to camelCase", async () => {
    const createdAt = new Date("2026-07-01T00:00:00Z");
    mockState.execute.mockResolvedValueOnce([
      {
        id: "msg-1",
        channel: "telegram",
        conversation_key: "chat-1",
        kind: "message",
        attempts: 3,
        last_error: "boom",
        created_at: createdAt,
      },
    ]);

    const result = await deadLettersForWorkspace("ws-1");

    expect(mockState.execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        id: "msg-1",
        channel: "telegram",
        conversationKey: "chat-1",
        kind: "message",
        attempts: 3,
        lastError: "boom",
        createdAt,
      },
    ]);
  });

  it("returns an empty array when the workspace has no dead-lettered rows", async () => {
    mockState.execute.mockResolvedValueOnce([]);
    const result = await deadLettersForWorkspace("ws-empty");
    expect(result).toEqual([]);
  });
});

describe("requeueDeadChannelMessage", () => {
  beforeEach(() => {
    mockState.execute.mockReset();
  });

  it("returns true when a dead row is flipped to queued", async () => {
    mockState.execute.mockResolvedValueOnce([{ id: "msg-1" }]);

    const result = await requeueDeadChannelMessage("ws-1", "msg-1");

    expect(result).toBe(true);
    expect(mockState.execute).toHaveBeenCalledTimes(1);
  });

  it("returns false for a row that is not currently in state 'dead' (guarded UPDATE matches zero rows, untouched)", async () => {
    mockState.execute.mockResolvedValueOnce([]);

    const result = await requeueDeadChannelMessage("ws-1", "msg-not-dead");

    expect(result).toBe(false);
  });

  it("returns false when the id belongs to a different workspace", async () => {
    mockState.execute.mockResolvedValueOnce([]);

    const result = await requeueDeadChannelMessage("ws-wrong", "msg-1");

    expect(result).toBe(false);
  });
});
