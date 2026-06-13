import { describe, it, expect } from "vitest";
import { buildReplayTimeline } from "./replay";
import type { AfkRunEventRow } from "@agentrail/db-clickhouse";

function makeRow(overrides: Partial<AfkRunEventRow> & { ts: string }): AfkRunEventRow {
  return {
    run_id: "run-1",
    workspace_id: "ws-1",
    slot: 0,
    event_type: "Read",
    payload_json: "{}",
    digest: "abc",
    kind: "action",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC2: empty input → empty shape with null highlights
// ---------------------------------------------------------------------------
describe("AC2: empty input", () => {
  it("returns empty events and null highlights for zero rows", () => {
    const result = buildReplayTimeline([]);
    expect(result.events).toHaveLength(0);
    expect(result.highlights.longest_stall_ms).toBeNull();
    expect(result.highlights.longest_stall_slot).toBeNull();
    expect(result.highlights.retry_loops).toHaveLength(0);
    expect(result.highlights.digest_mismatches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC3: longest_stall_ms / longest_stall_slot match the max gap in events
// ---------------------------------------------------------------------------
describe("AC3: longest stall detection", () => {
  it("detects the longest gap between consecutive events in the same slot", () => {
    const rows: AfkRunEventRow[] = [
      makeRow({ slot: 0, event_type: "Read",  ts: "2026-06-13T10:00:00.000Z" }),
      makeRow({ slot: 0, event_type: "Glob",  ts: "2026-06-13T10:00:01.000Z" }), // 1 s gap
      makeRow({ slot: 0, event_type: "Grep",  ts: "2026-06-13T10:00:06.000Z" }), // 5 s gap ← max
      makeRow({ slot: 1, event_type: "Read",  ts: "2026-06-13T10:00:00.500Z" }), // different slot
    ];
    const result = buildReplayTimeline(rows);

    expect(result.highlights.longest_stall_ms).toBe(5000);
    expect(result.highlights.longest_stall_slot).toBe(0);
  });

  it("first event in each slot has stall_before_ms null", () => {
    const rows: AfkRunEventRow[] = [
      makeRow({ slot: 0, event_type: "Read", ts: "2026-06-13T10:00:00.000Z" }),
      makeRow({ slot: 1, event_type: "Read", ts: "2026-06-13T10:00:01.000Z" }),
    ];
    const result = buildReplayTimeline(rows);
    expect(result.events[0].stall_before_ms).toBeNull();
    expect(result.events[1].stall_before_ms).toBeNull();
  });

  it("second event in a slot carries the correct stall_before_ms", () => {
    const rows: AfkRunEventRow[] = [
      makeRow({ slot: 0, event_type: "Read", ts: "2026-06-13T10:00:00.000Z" }),
      makeRow({ slot: 0, event_type: "Glob", ts: "2026-06-13T10:00:02.500Z" }),
    ];
    const result = buildReplayTimeline(rows);
    expect(result.events[1].stall_before_ms).toBe(2500);
  });

  it("returns null stalls when there is only one event total", () => {
    const result = buildReplayTimeline([
      makeRow({ slot: 0, event_type: "Read", ts: "2026-06-13T10:00:00.000Z" }),
    ]);
    expect(result.highlights.longest_stall_ms).toBeNull();
    expect(result.highlights.longest_stall_slot).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC4: is_retry — same event_type earlier in the same slot
// ---------------------------------------------------------------------------
describe("AC4: retry detection", () => {
  it("marks the second occurrence of an event_type in a slot as is_retry", () => {
    const rows: AfkRunEventRow[] = [
      makeRow({ slot: 1, event_type: "Read", ts: "2026-06-13T10:00:00.000Z" }),
      makeRow({ slot: 1, event_type: "Read", ts: "2026-06-13T10:00:01.000Z" }), // retry
      makeRow({ slot: 1, event_type: "Read", ts: "2026-06-13T10:00:02.000Z" }), // retry
    ];
    const result = buildReplayTimeline(rows);
    expect(result.events[0].is_retry).toBe(false);
    expect(result.events[1].is_retry).toBe(true);
    expect(result.events[2].is_retry).toBe(true);
  });

  it("does not mark events in different slots as retries", () => {
    const rows: AfkRunEventRow[] = [
      makeRow({ slot: 0, event_type: "Read", ts: "2026-06-13T10:00:00.000Z" }),
      makeRow({ slot: 1, event_type: "Read", ts: "2026-06-13T10:00:01.000Z" }),
    ];
    const result = buildReplayTimeline(rows);
    expect(result.events[0].is_retry).toBe(false);
    expect(result.events[1].is_retry).toBe(false);
  });

  it("reports retry_loops in highlights for repeated event_types in a slot", () => {
    const rows: AfkRunEventRow[] = [
      makeRow({ slot: 1, event_type: "Read", ts: "2026-06-13T10:00:00.000Z" }),
      makeRow({ slot: 1, event_type: "Read", ts: "2026-06-13T10:00:01.000Z" }),
      makeRow({ slot: 1, event_type: "Read", ts: "2026-06-13T10:00:02.000Z" }),
    ];
    const result = buildReplayTimeline(rows);
    expect(result.highlights.retry_loops).toEqual([
      { slot: 1, event_type: "Read", count: 3 },
    ]);
  });

  it("does not include non-repeated event_types in retry_loops", () => {
    const rows: AfkRunEventRow[] = [
      makeRow({ slot: 0, event_type: "Read",  ts: "2026-06-13T10:00:00.000Z" }),
      makeRow({ slot: 0, event_type: "Glob",  ts: "2026-06-13T10:00:01.000Z" }),
    ];
    const result = buildReplayTimeline(rows);
    expect(result.highlights.retry_loops).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Digest mismatch detection
// ---------------------------------------------------------------------------
describe("digest mismatch detection", () => {
  it("flags a non-mutating action event whose digest differs from the previous same-slot event", () => {
    const rows: AfkRunEventRow[] = [
      makeRow({ slot: 0, event_type: "Read", kind: "action", digest: "aaa", ts: "2026-06-13T10:00:00.000Z" }),
      makeRow({ slot: 0, event_type: "Read", kind: "action", digest: "bbb", ts: "2026-06-13T10:00:01.000Z" }),
    ];
    const result = buildReplayTimeline(rows);
    expect(result.events[0].is_digest_mismatch).toBe(false); // no previous → no mismatch
    expect(result.events[1].is_digest_mismatch).toBe(true);
    expect(result.highlights.digest_mismatches).toHaveLength(1);
  });

  it("does not flag a mutating event (Edit) even when digest changes", () => {
    const rows: AfkRunEventRow[] = [
      makeRow({ slot: 0, event_type: "Read", kind: "action", digest: "aaa", ts: "2026-06-13T10:00:00.000Z" }),
      makeRow({ slot: 0, event_type: "Edit", kind: "action", digest: "bbb", ts: "2026-06-13T10:00:01.000Z" }),
    ];
    const result = buildReplayTimeline(rows);
    expect(result.events[1].is_digest_mismatch).toBe(false);
  });

  it("does not flag events where digest is unchanged", () => {
    const rows: AfkRunEventRow[] = [
      makeRow({ slot: 0, event_type: "Read", kind: "action", digest: "aaa", ts: "2026-06-13T10:00:00.000Z" }),
      makeRow({ slot: 0, event_type: "Read", kind: "action", digest: "aaa", ts: "2026-06-13T10:00:01.000Z" }),
    ];
    const result = buildReplayTimeline(rows);
    expect(result.events[1].is_digest_mismatch).toBe(false);
  });

  it("does not flag non-action events (kind != 'action')", () => {
    const rows: AfkRunEventRow[] = [
      makeRow({ slot: 0, event_type: "Read", kind: "init",   digest: "aaa", ts: "2026-06-13T10:00:00.000Z" }),
      makeRow({ slot: 0, event_type: "Read", kind: "init",   digest: "bbb", ts: "2026-06-13T10:00:01.000Z" }),
    ];
    const result = buildReplayTimeline(rows);
    expect(result.events[1].is_digest_mismatch).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario: mixed stall + retry (mirrors manual verification in the issue)
// ---------------------------------------------------------------------------
describe("combined scenario: stall + retry in same run", () => {
  it("detects a ~5s stall and a retry loop for slot 1", () => {
    const base = "2026-06-13T10:00:00.000Z";
    const t = (offsetMs: number) =>
      new Date(new Date(base).getTime() + offsetMs).toISOString();

    const rows: AfkRunEventRow[] = [
      // Slot 0 — normal flow
      makeRow({ slot: 0, event_type: "Read",   ts: t(0) }),
      makeRow({ slot: 0, event_type: "Glob",   ts: t(500) }),
      // Slot 1 — retry loop
      makeRow({ slot: 1, event_type: "Grep",   ts: t(1000) }),
      makeRow({ slot: 1, event_type: "Grep",   ts: t(1100) }), // retry
      // Slot 0 again — deliberate ~5s stall
      makeRow({ slot: 0, event_type: "Bash",   ts: t(5500) }), // 5000 ms after t(500)
    ];

    const result = buildReplayTimeline(rows);

    expect(result.highlights.longest_stall_ms).toBe(5000);
    expect(result.highlights.longest_stall_slot).toBe(0);

    const slot1Loop = result.highlights.retry_loops.find((r) => r.slot === 1);
    expect(slot1Loop).toBeDefined();
    expect(slot1Loop?.event_type).toBe("Grep");
    expect(slot1Loop?.count).toBe(2);
  });
});
