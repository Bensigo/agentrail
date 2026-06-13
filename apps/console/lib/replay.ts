/**
 * Pure replay timeline analysis helper.
 *
 * Computes per-event stall durations, retry detection, and digest-mismatch
 * flagging from raw afk_run_events rows. No I/O — safe to unit-test without
 * a live ClickHouse connection.
 */
import type { AfkRunEventRow } from "@agentrail/db-clickhouse";

export interface ReplayEvent {
  ts: string;
  slot: number;
  event_type: string;
  payload_json: string;
  digest: string;
  /** Gap (ms) since previous event in the same slot; null for the first event in a slot. */
  stall_before_ms: number | null;
  /** True when the same event_type appeared earlier in the same slot. */
  is_retry: boolean;
  /** True when kind == 'action', event_type is non-mutating, and digest differs from the previous same-slot event. */
  is_digest_mismatch: boolean;
}

export interface ReplayTimelineResponse {
  events: ReplayEvent[];
  highlights: {
    longest_stall_ms: number | null;
    longest_stall_slot: number | null;
    retry_loops: { slot: number; event_type: string; count: number }[];
    digest_mismatches: { ts: string; slot: number }[];
  };
}

/**
 * Tool event_types for which a digest change is expected (mutations to the
 * working tree). Events NOT in this set and with kind == 'action' are flagged
 * as digest mismatches when their digest differs from the previous same-slot event.
 */
const MUTATING_EVENT_TYPES = new Set([
  "Edit",
  "MultiEdit",
  "Write",
  "Bash",
  "NotebookEdit",
  "edit",
  "write",
  "bash",
  "multiedit",
]);

function parseTs(ts: string): number {
  if (!ts || ts.trim() === "") return 0;
  // Normalize ClickHouse space-separated format to ISO 8601 if needed.
  const normalized =
    ts.includes("T") || /[zZ]|[+-]\d{2}:?\d{2}$/.test(ts)
      ? ts
      : ts.replace(" ", "T") + "Z";
  const ms = new Date(normalized).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function normalizeTs(ts: string): string {
  if (!ts || ts.trim() === "") return ts;
  if (ts.includes("T")) return ts;
  const iso = ts.replace(" ", "T") + "Z";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString();
}

/**
 * Build a typed ReplayTimelineResponse from raw afk_run_events rows.
 * Input rows must already be sorted ts ASC, slot ASC (as returned by getAfkRunEvents).
 */
export function buildReplayTimeline(rows: AfkRunEventRow[]): ReplayTimelineResponse {
  if (rows.length === 0) {
    return {
      events: [],
      highlights: {
        longest_stall_ms: null,
        longest_stall_slot: null,
        retry_loops: [],
        digest_mismatches: [],
      },
    };
  }

  // Ensure deterministic order even if caller passes unsorted input.
  const sorted = [...rows].sort((a, b) => {
    const diff = parseTs(a.ts) - parseTs(b.ts);
    return diff !== 0 ? diff : a.slot - b.slot;
  });

  // Per-slot state.
  const slotLastTs = new Map<number, number>();
  const slotSeenTypes = new Map<number, Map<string, number>>();
  const slotLastDigest = new Map<number, string>();

  const events: ReplayEvent[] = [];

  for (const row of sorted) {
    const { slot, event_type, kind, digest } = row;
    const tsMs = parseTs(row.ts);

    // Stall: gap since previous event in same slot.
    const prevTs = slotLastTs.get(slot);
    const stall_before_ms = prevTs !== undefined ? tsMs - prevTs : null;

    // Retry: same event_type already seen in this slot.
    const typeMap = slotSeenTypes.get(slot) ?? new Map<string, number>();
    const prevCount = typeMap.get(event_type) ?? 0;
    const is_retry = prevCount > 0;

    // Digest mismatch: action event, non-mutating type, digest changed vs prev same-slot.
    const prevDigest = slotLastDigest.get(slot);
    const is_digest_mismatch =
      kind === "action" &&
      !MUTATING_EVENT_TYPES.has(event_type) &&
      prevDigest !== undefined &&
      digest !== prevDigest;

    events.push({
      ts: normalizeTs(row.ts),
      slot,
      event_type,
      payload_json: row.payload_json,
      digest,
      stall_before_ms,
      is_retry,
      is_digest_mismatch,
    });

    // Advance per-slot state.
    slotLastTs.set(slot, tsMs);
    typeMap.set(event_type, prevCount + 1);
    slotSeenTypes.set(slot, typeMap);
    slotLastDigest.set(slot, digest);
  }

  // Highlights.
  let longest_stall_ms: number | null = null;
  let longest_stall_slot: number | null = null;
  for (const ev of events) {
    if (ev.stall_before_ms !== null) {
      if (longest_stall_ms === null || ev.stall_before_ms > longest_stall_ms) {
        longest_stall_ms = ev.stall_before_ms;
        longest_stall_slot = ev.slot;
      }
    }
  }

  // Retry loops: every (slot, event_type) pair that appeared more than once.
  const retryLoops: { slot: number; event_type: string; count: number }[] = [];
  for (const [slot, typeMap] of slotSeenTypes) {
    for (const [et, count] of typeMap) {
      if (count > 1) {
        retryLoops.push({ slot, event_type: et, count });
      }
    }
  }
  retryLoops.sort((a, b) => a.slot - b.slot || a.event_type.localeCompare(b.event_type));

  const digest_mismatches = events
    .filter((e) => e.is_digest_mismatch)
    .map((e) => ({ ts: e.ts, slot: e.slot }));

  return {
    events,
    highlights: {
      longest_stall_ms,
      longest_stall_slot,
      retry_loops: retryLoops,
      digest_mismatches,
    },
  };
}
