import { describe, it, expect } from "vitest";
import { parseClickhouseUtc, computeHealth, repoHealth } from "./repo-health";

describe("parseClickhouseUtc", () => {
  it("treats a tz-less ClickHouse timestamp as UTC, not local", () => {
    // "2026-06-12 07:05:31.204" is UTC; must NOT be shifted by the local offset.
    const d = parseClickhouseUtc("2026-06-12 07:05:31.204");
    expect(d.toISOString()).toBe("2026-06-12T07:05:31.204Z");
  });

  it("respects an explicit timezone if present", () => {
    expect(parseClickhouseUtc("2026-06-12T07:05:31Z").toISOString()).toBe(
      "2026-06-12T07:05:31.000Z"
    );
  });

  it("passes through a Date unchanged", () => {
    const d = new Date("2026-06-12T07:05:31Z");
    expect(parseClickhouseUtc(d)).toBe(d);
  });
});

describe("computeHealth", () => {
  // The owner-report bug: ClickHouse being unconfigured/unreachable (so the
  // caller has no snapshot to pass) is not evidence of a critical repo — it's
  // "no telemetry", which is a DIFFERENT fact from "a real, old timestamp".
  it("null staleness → unknown, never critical (no telemetry ≠ a critical repo)", () => {
    expect(computeHealth(null)).toBe("unknown");
  });
  it("< 1h → healthy", () => {
    expect(computeHealth(0)).toBe("healthy");
    expect(computeHealth(3599)).toBe("healthy");
  });
  it("1h–24h → stale", () => {
    expect(computeHealth(3600)).toBe("stale");
    expect(computeHealth(86399)).toBe("stale");
  });
  // The genuine-staleness thresholds are untouched by the unknown-state fix:
  // a REAL timestamp that's actually old still grades critical, honestly.
  it(">= 24h with a REAL timestamp → still critical", () => {
    expect(computeHealth(86400)).toBe("critical");
    expect(computeHealth(1_000_000)).toBe("critical");
  });
});

describe("repoHealth", () => {
  const NOW = Date.parse("2026-06-12T07:10:00.000Z");

  it("no snapshot → unknown with null fields, never a false critical", () => {
    expect(repoHealth(null, NOW)).toEqual({
      last_indexed_at: null,
      staleness_seconds: null,
      health_status: "unknown",
    });
  });

  it("an undefined snapshot (same as null — optional lookup miss) → unknown too", () => {
    expect(repoHealth(undefined, NOW)).toEqual({
      last_indexed_at: null,
      staleness_seconds: null,
      health_status: "unknown",
    });
  });

  it("a fresh UTC snapshot is healthy (the bug: it used to read stale)", () => {
    // 4.5 minutes before NOW, expressed the way ClickHouse returns it.
    const snap = { indexed_at: "2026-06-12 07:05:31.204" } as never;
    const h = repoHealth(snap, NOW);
    expect(h.staleness_seconds).toBe(268); // ~4.5 min, NOT ~4h
    expect(h.health_status).toBe("healthy");
    expect(h.last_indexed_at).toBe("2026-06-12T07:05:31.204Z");
  });

  it("a genuinely old REAL snapshot still reads critical — the unknown fix doesn't soften real staleness", () => {
    // ~30h before NOW: a real, present timestamp, just old.
    const snap = { indexed_at: "2026-06-11 01:10:00.000" } as never;
    const h = repoHealth(snap, NOW);
    expect(h.health_status).toBe("critical");
    expect(h.last_indexed_at).not.toBeNull();
  });
});
