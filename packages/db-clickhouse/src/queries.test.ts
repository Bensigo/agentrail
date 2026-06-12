import { describe, it, expect } from "vitest";
import { deriveSnapshotEventId } from "./queries";

describe("deriveSnapshotEventId", () => {
  it("is deterministic for the same inputs", () => {
    const a = deriveSnapshotEventId("ws", "repo", "abc123", "2026-06-12T00:00:00.000Z");
    const b = deriveSnapshotEventId("ws", "repo", "abc123", "2026-06-12T00:00:00.000Z");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });

  it("differs when any field differs", () => {
    const base = deriveSnapshotEventId("ws", "repo", "abc123", "2026-06-12T00:00:00.000Z");
    expect(deriveSnapshotEventId("ws", "repo", "abc123", "2026-06-12T00:00:01.000Z")).not.toBe(base);
    expect(deriveSnapshotEventId("ws", "repo2", "abc123", "2026-06-12T00:00:00.000Z")).not.toBe(base);
    expect(deriveSnapshotEventId("ws2", "repo", "abc123", "2026-06-12T00:00:00.000Z")).not.toBe(base);
    expect(deriveSnapshotEventId("ws", "repo", "def456", "2026-06-12T00:00:00.000Z")).not.toBe(base);
  });
});
