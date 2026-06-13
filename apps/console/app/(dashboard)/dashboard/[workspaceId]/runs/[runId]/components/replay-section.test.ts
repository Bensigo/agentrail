import { describe, expect, it } from "vitest";
import {
  formatReplayDuration,
  replayDotColor,
} from "./replay-section-helpers";

describe("ReplaySection helpers", () => {
  it("formats replay durations for milliseconds, seconds, and minutes", () => {
    expect(formatReplayDuration(499)).toBe("499ms");
    expect(formatReplayDuration(1500)).toBe("1.5s");
    expect(formatReplayDuration(65_000)).toBe("1m 5s");
  });

  it("uses red for digest mismatches before retry orange", () => {
    expect(replayDotColor({ is_digest_mismatch: true, is_retry: true })).toBe(
      "var(--red-09)"
    );
    expect(replayDotColor({ is_digest_mismatch: false, is_retry: true })).toBe(
      "var(--orange-09)"
    );
    expect(replayDotColor({ is_digest_mismatch: false, is_retry: false })).toBe(
      "var(--green-09)"
    );
  });
});
