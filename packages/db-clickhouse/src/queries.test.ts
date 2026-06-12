import { describe, it, expect } from "vitest";
import { deriveSnapshotEventId, deriveContextPackId } from "./queries";

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

describe("deriveContextPackId", () => {
  it("is deterministic for the same inputs", () => {
    const a = deriveContextPackId("ws", "run-1", "2026-06-12T00:00:00.000Z");
    const b = deriveContextPackId("ws", "run-1", "2026-06-12T00:00:00.000Z");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });

  it("differs when any field differs", () => {
    const base = deriveContextPackId("ws", "run-1", "2026-06-12T00:00:00.000Z");
    expect(deriveContextPackId("ws", "run-1", "2026-06-12T00:00:01.000Z")).not.toBe(base);
    expect(deriveContextPackId("ws", "run-2", "2026-06-12T00:00:00.000Z")).not.toBe(base);
    expect(deriveContextPackId("ws2", "run-1", "2026-06-12T00:00:00.000Z")).not.toBe(base);
  });
});
