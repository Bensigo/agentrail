import { describe, expect, it } from "vitest";
import {
  EMPTY_STATE_COPY,
  buildSavingsUrl,
  formatEstimateMarker,
  formatSavingsUsd,
  resolveSavingsState,
} from "./savings-panel-helpers";

describe("savings panel helpers", () => {
  describe("buildSavingsUrl", () => {
    it("builds the savings URL with time_from when timeRange is set", () => {
      const url = buildSavingsUrl({
        workspaceId: "ws-1",
        origin: "http://localhost",
        timeRange: "24h",
        now: new Date("2026-06-13T10:00:00.000Z"),
      });

      expect(url).toBe(
        "http://localhost/api/v1/workspaces/ws-1/costs/savings?time_from=2026-06-12T10%3A00%3A00.000Z"
      );
    });

    it("builds the savings URL without time_from when timeRange is empty", () => {
      const url = buildSavingsUrl({
        workspaceId: "ws-1",
        origin: "http://localhost",
        timeRange: "",
      });

      expect(url).toBe(
        "http://localhost/api/v1/workspaces/ws-1/costs/savings"
      );
    });
  });

  describe("formatSavingsUsd", () => {
    it("prefixes with ~ when estimateFlag is true", () => {
      expect(formatSavingsUsd(12.345, true)).toBe("~$12.35");
    });

    it("omits ~ prefix when estimateFlag is false", () => {
      expect(formatSavingsUsd(5.0, false)).toBe("$5.00");
    });

    it("formats zero dollars with estimate flag", () => {
      expect(formatSavingsUsd(0, true)).toBe("~$0.00");
    });
  });

  describe("formatEstimateMarker", () => {
    it("formats model and rate as readable marker", () => {
      expect(formatEstimateMarker("claude-sonnet-4-5", 3.0)).toBe(
        "claude-sonnet-4-5 @ $3.00/Mtok"
      );
    });

    it("formats rate with two decimal places", () => {
      expect(formatEstimateMarker("claude-haiku-4-5", 0.8)).toBe(
        "claude-haiku-4-5 @ $0.80/Mtok"
      );
    });
  });

  describe("resolveSavingsState", () => {
    it("returns 'loading' while loading", () => {
      expect(
        resolveSavingsState({ loading: true, error: null, savings: null })
      ).toBe("loading");
    });

    it("returns 'error' when not loading and error is present", () => {
      expect(
        resolveSavingsState({
          loading: false,
          error: "HTTP 500",
          savings: null,
        })
      ).toBe("error");
    });

    it("returns 'empty' when savings is null", () => {
      expect(
        resolveSavingsState({ loading: false, error: null, savings: null })
      ).toBe("empty");
    });

    it("returns 'empty' when tokensSaved is 0", () => {
      expect(
        resolveSavingsState({
          loading: false,
          error: null,
          savings: {
            tokensSaved: 0,
            dollarsSaved: 0,
            model: "claude-sonnet-4-5",
            ratePerMtok: 3.0,
            estimateFlag: true,
          },
        })
      ).toBe("empty");
    });

    it("returns 'data' when savings has non-zero tokensSaved", () => {
      expect(
        resolveSavingsState({
          loading: false,
          error: null,
          savings: {
            tokensSaved: 50000,
            dollarsSaved: 0.15,
            model: "claude-sonnet-4-5",
            ratePerMtok: 3.0,
            estimateFlag: true,
          },
        })
      ).toBe("data");
    });
  });

  describe("EMPTY_STATE_COPY", () => {
    it("has explicit empty state message", () => {
      expect(EMPTY_STATE_COPY).toBe(
        "No context-pack telemetry for the selected period"
      );
    });
  });
});
