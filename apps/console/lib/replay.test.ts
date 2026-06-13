import { describe, expect, it } from "vitest";
import type { AfkRunEventRecord } from "@agentrail/db-clickhouse";
import { buildReplayTimeline } from "./replay";

function row(overrides: Partial<AfkRunEventRecord> = {}): AfkRunEventRecord {
  return {
    run_id: "run-1",
    workspace_id: "ws-1",
    slot: 0,
    event_type: "READ",
    ts: "2026-06-13 10:00:00.000",
    payload_json: "{}",
    digest: "aaa",
    ...overrides,
  };
}

describe("buildReplayTimeline", () => {
  it("returns the empty response shape when no events exist", () => {
    expect(buildReplayTimeline([])).toEqual({
      events: [],
      highlights: {
        longest_stall_ms: null,
        longest_stall_slot: null,
        retry_loops: [],
        digest_mismatches: [],
      },
    });
  });

  it("computes stalls per slot and reports the longest stall", () => {
    const timeline = buildReplayTimeline([
      row({ slot: 0, event_type: "READ", ts: "2026-06-13 10:00:00.000" }),
      row({ slot: 1, event_type: "READ", ts: "2026-06-13 10:00:01.000" }),
      row({ slot: 0, event_type: "GREP", ts: "2026-06-13 10:00:05.000" }),
      row({ slot: 1, event_type: "GREP", ts: "2026-06-13 10:00:02.500" }),
    ]);

    expect(timeline.events.map((event) => event.stall_before_ms)).toEqual([
      null,
      null,
      1500,
      5000,
    ]);
    expect(timeline.highlights.longest_stall_ms).toBe(5000);
    expect(timeline.highlights.longest_stall_slot).toBe(0);
  });

  it("marks retries when the same event_type appeared earlier in the same slot", () => {
    const timeline = buildReplayTimeline([
      row({ slot: 0, event_type: "READ", ts: "2026-06-13T10:00:00.000Z" }),
      row({ slot: 1, event_type: "READ", ts: "2026-06-13T10:00:01.000Z" }),
      row({ slot: 0, event_type: "READ", ts: "2026-06-13T10:00:02.000Z" }),
    ]);

    expect(timeline.events.map((event) => event.is_retry)).toEqual([
      false,
      false,
      true,
    ]);
    expect(timeline.highlights.retry_loops).toEqual([
      { slot: 0, event_type: "READ", count: 2 },
    ]);
  });

  it("flags digest changes for non-mutating event types in the same slot", () => {
    const timeline = buildReplayTimeline([
      row({ slot: 0, event_type: "READ", digest: "aaa", ts: "2026-06-13T10:00:00.000Z" }),
      row({ slot: 0, event_type: "READ", digest: "bbb", ts: "2026-06-13T10:00:01.000Z" }),
      row({ slot: 0, event_type: "WRITE", digest: "ccc", ts: "2026-06-13T10:00:02.000Z" }),
    ]);

    expect(timeline.events.map((event) => event.is_digest_mismatch)).toEqual([
      false,
      true,
      false,
    ]);
    expect(timeline.highlights.digest_mismatches).toEqual([
      { ts: "2026-06-13T10:00:01.000Z", slot: 0 },
    ]);
  });
});
