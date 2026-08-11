import { describe, expect, it } from "vitest";
import {
  acceptanceOutcomeMetricsUrl,
  acceptanceOutcomeMetricsWindow,
  formatAcceptanceOutcomeDateRange,
} from "./acceptance-outcome-metrics-panel-helpers";

describe("acceptance outcome metrics panel helpers", () => {
  it("uses one fixed, explicit 30-day observation window", () => {
    expect(acceptanceOutcomeMetricsWindow(new Date("2026-08-05T12:00:00.000Z"))).toEqual({
      from: "2026-07-06T12:00:00.000Z",
      to: "2026-08-05T12:00:00.000Z",
      observedUntil: "2026-08-05T12:00:00.000Z",
    });
  });

  it("sends the window and immutable observation cutoff to the read route", () => {
    expect(acceptanceOutcomeMetricsUrl("ws-1", {
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
      observedUntil: "2026-08-02T00:00:00.000Z",
    })).toBe(
      "/api/v1/workspaces/ws-1/acceptance-outcome-metrics?from=2026-08-01T00%3A00%3A00.000Z&to=2026-08-02T00%3A00%3A00.000Z&observedUntil=2026-08-02T00%3A00%3A00.000Z"
    );
  });

  it("formats its stated observation window in UTC", () => {
    expect(formatAcceptanceOutcomeDateRange({
      from: "2026-07-06T00:00:00.000Z",
      to: "2026-08-05T00:00:00.000Z",
    })).toBe("Jul 6, 2026 – Aug 5, 2026");
  });
});
