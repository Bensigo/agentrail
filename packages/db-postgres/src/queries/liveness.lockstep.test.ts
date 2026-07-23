import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * #1388 AC4 — the console reclaim window is single-sourced with the Python
 * runtime. `agentrail/runner/liveness_config.json` is the ONE declaration of the
 * liveness/execution timings; Python reads it directly, and THIS test reads the
 * very same file and fails if the TypeScript constants used by
 * `reconcileStaleRuns` have drifted from it. So the reclaim window can never
 * wander away from the interval the fleet worker actually pings at, nor from the
 * execution ceiling the wall-clock fallback must stay above.
 */
import {
  LIVENESS_INTERVAL_SECONDS,
  LIVENESS_STALENESS_SECONDS,
  STALE_RUN_MINUTES,
} from "./runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// queries -> src -> db-postgres -> packages -> repo root
const CONFIG_PATH = resolve(
  __dirname,
  "../../../../agentrail/runner/liveness_config.json"
);

const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as {
  liveness_interval_seconds: number;
  liveness_staleness_seconds: number;
  execution_ceiling_seconds: number;
  wallclock_fallback_seconds: number;
};

describe("liveness config lockstep (#1388 AC4)", () => {
  it("TS constants match agentrail/runner/liveness_config.json exactly", () => {
    expect(LIVENESS_INTERVAL_SECONDS).toBe(cfg.liveness_interval_seconds);
    expect(LIVENESS_STALENESS_SECONDS).toBe(cfg.liveness_staleness_seconds);
    // STALE_RUN_MINUTES is the wall-clock fallback, expressed in minutes.
    expect(STALE_RUN_MINUTES * 60).toBe(cfg.wallclock_fallback_seconds);
  });

  it("the config enforces the orderings the feature relies on (AC2 + AC4)", () => {
    // A healthy pinging run is never reclaimed: staleness window > ping interval.
    expect(cfg.liveness_interval_seconds).toBeLessThan(
      cfg.liveness_staleness_seconds
    );
    // Many pings happen across one run.
    expect(cfg.liveness_interval_seconds).toBeLessThan(
      cfg.execution_ceiling_seconds
    );
    // AC4: the wall-clock fallback must exceed the execution ceiling so a
    // legitimately long NON-pinging run is never reaped mid-flight.
    expect(cfg.wallclock_fallback_seconds).toBeGreaterThan(
      cfg.execution_ceiling_seconds
    );
  });
});
