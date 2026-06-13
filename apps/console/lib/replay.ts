import type { AfkRunEventRecord } from "@agentrail/db-clickhouse";

export interface ReplayEvent {
  ts: string;
  slot: number;
  event_type: string;
  payload_json: string;
  digest: string;
  stall_before_ms: number | null;
  is_retry: boolean;
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

const MUTATING_EVENT_TYPES = new Set([
  "apply_patch",
  "bash",
  "edit",
  "multi_edit",
  "multiedit",
  "notebook_edit",
  "notebookedit",
  "patch",
  "write",
]);

const NON_ACTION_EVENT_TYPES = new Set([
  "state",
  "status",
  "heartbeat",
  "digest",
]);

function eventTime(ts: string): number {
  const raw = ts.trim();
  if (!raw) return 0;
  const normalized =
    raw.includes("T") || /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)
      ? raw
      : `${raw.replace(" ", "T")}Z`;
  const parsed = new Date(normalized).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function normalizeTs(ts: string): string {
  const raw = ts.trim();
  if (!raw) return ts;
  const normalized =
    raw.includes("T") || /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)
      ? raw
      : `${raw.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? ts : parsed.toISOString();
}

function canFlagDigestMismatch(eventType: string): boolean {
  const normalized = eventType.trim().toLowerCase();
  return (
    normalized !== "" &&
    !NON_ACTION_EVENT_TYPES.has(normalized) &&
    !MUTATING_EVENT_TYPES.has(normalized)
  );
}

function emptyTimeline(): ReplayTimelineResponse {
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

export function buildReplayTimeline(rows: AfkRunEventRecord[]): ReplayTimelineResponse {
  if (rows.length === 0) return emptyTimeline();

  const sorted = [...rows].sort((a, b) => {
    const diff = eventTime(a.ts) - eventTime(b.ts);
    return diff !== 0 ? diff : a.slot - b.slot;
  });

  const lastTsBySlot = new Map<number, number>();
  const lastDigestBySlot = new Map<number, string>();
  const eventTypeCountsBySlot = new Map<number, Map<string, number>>();
  const events: ReplayEvent[] = [];

  for (const row of sorted) {
    const tsMs = eventTime(row.ts);
    const previousTs = lastTsBySlot.get(row.slot);
    const previousDigest = lastDigestBySlot.get(row.slot);
    const typeCounts = eventTypeCountsBySlot.get(row.slot) ?? new Map<string, number>();
    const previousTypeCount = typeCounts.get(row.event_type) ?? 0;
    const stallBeforeMs = previousTs === undefined ? null : Math.max(0, tsMs - previousTs);
    const isDigestMismatch =
      previousDigest !== undefined &&
      row.digest !== previousDigest &&
      canFlagDigestMismatch(row.event_type);

    events.push({
      ts: normalizeTs(row.ts),
      slot: row.slot,
      event_type: row.event_type,
      payload_json: row.payload_json,
      digest: row.digest,
      stall_before_ms: stallBeforeMs,
      is_retry: previousTypeCount > 0,
      is_digest_mismatch: isDigestMismatch,
    });

    typeCounts.set(row.event_type, previousTypeCount + 1);
    eventTypeCountsBySlot.set(row.slot, typeCounts);
    lastTsBySlot.set(row.slot, tsMs);
    lastDigestBySlot.set(row.slot, row.digest);
  }

  let longestStallMs: number | null = null;
  let longestStallSlot: number | null = null;
  for (const event of events) {
    if (event.stall_before_ms === null) continue;
    if (longestStallMs === null || event.stall_before_ms > longestStallMs) {
      longestStallMs = event.stall_before_ms;
      longestStallSlot = event.slot;
    }
  }

  const retryLoops: { slot: number; event_type: string; count: number }[] = [];
  for (const [slot, typeCounts] of eventTypeCountsBySlot) {
    for (const [eventType, count] of typeCounts) {
      if (count > 1) retryLoops.push({ slot, event_type: eventType, count });
    }
  }
  retryLoops.sort((a, b) => a.slot - b.slot || a.event_type.localeCompare(b.event_type));

  return {
    events,
    highlights: {
      longest_stall_ms: longestStallMs,
      longest_stall_slot: longestStallSlot,
      retry_loops: retryLoops,
      digest_mismatches: events
        .filter((event) => event.is_digest_mismatch)
        .map((event) => ({ ts: event.ts, slot: event.slot })),
    },
  };
}
