import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  TELEMETRY_HEALTH_SIGNALS,
  TelemetryHealthError,
  TelemetryHealthSkeleton,
  TelemetryHealthTable,
  type TelemetryHealthSignal,
} from "./telemetry-health-section";

const rows: TelemetryHealthSignal[] = TELEMETRY_HEALTH_SIGNALS.map((signal) => ({
  signal,
  present: signal !== "cost_event",
  missing_since:
    signal === "cost_event" ? "2026-06-13T05:00:00.000Z" : null,
}));

describe("TelemetryHealthSection presentation", () => {
  it("renders the fixed eight telemetry signals with present and missing states", () => {
    const html = renderToStaticMarkup(
      createElement(TelemetryHealthTable, { rows })
    );

    expect((html.match(/data-signal=/g) ?? [])).toHaveLength(8);
    for (const signal of TELEMETRY_HEALTH_SIGNALS) {
      expect(html).toContain(signal);
    }
    expect(html).toContain("Present");
    expect(html).toContain("Missing");
    expect(html).toContain("2026-06-13T05:00:00.000Z");
    expect(html).toContain("#29a383");
    expect(html).toContain("#e5484d");
    expect(html).toContain("font-mono text-xs");
  });

  it("renders eight loading skeleton rows", () => {
    const html = renderToStaticMarkup(createElement(TelemetryHealthSkeleton));

    expect((html.match(/data-skeleton-row=/g) ?? [])).toHaveLength(8);
  });

  it("renders the non-fatal unavailable state", () => {
    const html = renderToStaticMarkup(createElement(TelemetryHealthError));

    expect(html).toContain("Telemetry health unavailable");
  });
});
