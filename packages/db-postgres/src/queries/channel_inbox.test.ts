import { describe, it, expect, vi } from "vitest";

// The db module is mocked so importing the query module is side-effect free;
// the retry-backoff decision under test is pure and never touches it.
vi.mock("../db.js", () => ({ db: {} }));

import {
  nextInboxStateAfterFailure,
  INBOX_MAX_ATTEMPTS,
  INBOX_BACKOFF_SECONDS,
} from "./channel_inbox.js";

/**
 * Bounded retry with backoff (spec §4): a channel_inbox row that fails
 * processing is requeued with a delay drawn from INBOX_BACKOFF_SECONDS, up to
 * INBOX_MAX_ATTEMPTS attempts. The MAX'th failure goes straight to `dead` —
 * no further backoff — so a permanently-broken message can't loop forever
 * occupying a worker slot (and can't retry indefinitely against a downstream
 * outage). This is the single unit-tested decision point for the retry
 * policy; `failChannelMessage` is a thin DB wrapper around it.
 */
describe("nextInboxStateAfterFailure (bounded retry with backoff)", () => {
  it("requeues after the 1st failure using the first backoff step (30s)", () => {
    const result = nextInboxStateAfterFailure(1);
    expect(result).toEqual({
      state: "queued",
      delaySeconds: INBOX_BACKOFF_SECONDS[0],
    });
    expect(result.delaySeconds).toBe(30);
  });

  it("requeues after the 2nd failure using the second backoff step (120s)", () => {
    const result = nextInboxStateAfterFailure(2);
    expect(result).toEqual({
      state: "queued",
      delaySeconds: INBOX_BACKOFF_SECONDS[1],
    });
    expect(result.delaySeconds).toBe(120);
  });

  it("goes dead at INBOX_MAX_ATTEMPTS — no further retry", () => {
    expect(INBOX_MAX_ATTEMPTS).toBe(3);
    const result = nextInboxStateAfterFailure(3);
    expect(result).toEqual({ state: "dead", delaySeconds: 0 });
  });

  it("stays dead past INBOX_MAX_ATTEMPTS (defensive — attempts should never overshoot)", () => {
    const result = nextInboxStateAfterFailure(4);
    expect(result).toEqual({ state: "dead", delaySeconds: 0 });
  });
});
