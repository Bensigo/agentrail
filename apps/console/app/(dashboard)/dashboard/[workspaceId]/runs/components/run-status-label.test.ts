/**
 * Pure-label test — issue #1232 AC3.
 *
 * Run status (queued|running|success|failed) is a different enum from the
 * queue-state vocabulary in `apps/console/lib/work-vocabulary.ts`
 * (queued|parked|running|green|escalated-to-human|blocked). This file pins
 * that `runStatusLabel` only relabels the run-status enum in plain English —
 * it must never invent a queue-state mapping.
 */
import { describe, it, expect } from "vitest";
import { runStatusLabel } from "./run-status-label";

describe("runStatusLabel", () => {
  it("labels queued as Queued", () => {
    expect(runStatusLabel("queued")).toBe("Queued");
  });

  it("labels running as Running", () => {
    expect(runStatusLabel("running")).toBe("Running");
  });

  it("labels success as Succeeded", () => {
    expect(runStatusLabel("success")).toBe("Succeeded");
  });

  it("labels failed as Failed", () => {
    expect(runStatusLabel("failed")).toBe("Failed");
  });

  it("falls back to the raw string for an unknown status (total function)", () => {
    expect(runStatusLabel("weird")).toBe("weird");
  });

  it("never maps into queue-state vocabulary (different enum, #1232)", () => {
    expect(runStatusLabel("success")).not.toBe("Shipped");
    expect(runStatusLabel("failed")).not.toBe("Needs you");
    expect(runStatusLabel("queued")).not.toBe("Assigned");
  });
});
