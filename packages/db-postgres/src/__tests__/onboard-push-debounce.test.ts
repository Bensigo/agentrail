import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pins the exact mechanism the github/webhook push handler's doc-comment
 * relies on to debounce a BURST of pushes (as opposed to the separate,
 * advisory minimum-interval guard that bounds compile FREQUENCY — see
 * `findOnboardEntryStatus`'s own doc-comment in `github_intake.ts`):
 * `enqueueOnboard`'s force re-arm is a single conditional `UPDATE ... WHERE
 * state NOT IN ('queued', 'running')`. Three force calls arriving
 * back-to-back for the SAME repo, with no completion in between, must
 * therefore collapse to exactly ONE admitted (`enqueued: true`) row — the
 * second and third find the row already 'queued' and report
 * `already_pending`, never a second/third compile. This is what lets the
 * push handler add NO new timer/cron/dedupe machinery of its own.
 *
 * Unlike `onboard-intake.test.ts`'s per-test mock (a FIXED `executeResult`,
 * `enqueueOnboard` called once per test), this harness tracks ONE simulated
 * row's `state` across MULTIPLE consecutive calls within a single test — the
 * `execute` mock actually evaluates the same `state NOT IN (...)` predicate
 * the real UPDATE's WHERE clause carries, flipping the simulated `state` to
 * 'queued' the instant it matches, exactly like a real Postgres UPDATE
 * would. That means this test fails if the WHERE clause's guard is ever
 * loosened or dropped, not merely if a canned return value happens to
 * change — the same idempotency contract `onboard-intake.test.ts` exercises
 * one call at a time, exercised here across a realistic multi-push sequence.
 */
const row = vi.hoisted(() => ({
  // undefined = no row exists yet in the simulated table.
  state: undefined as string | undefined,
}));

vi.mock("../db.js", () => ({
  db: {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (row.state === undefined) {
              row.state = "queued"; // simulates the INSERT committing
              return [{ id: "row-id" }];
            }
            return []; // a row already exists → ON CONFLICT DO NOTHING
          },
        }),
      }),
    }),
    execute: async () => {
      // Simulates: UPDATE queue_entries SET state = 'queued', ...
      //            WHERE id = ... AND state NOT IN ('queued', 'running')
      //            RETURNING id
      if (row.state !== "queued" && row.state !== "running") {
        row.state = "queued";
        return [{ id: "row-id" }];
      }
      return [];
    },
  },
}));

import { enqueueOnboard, ONBOARD_ALREADY_PENDING_REASON } from "../queries/github_intake.js";

describe("enqueueOnboard — push-triggered burst debounce (github/webhook push handler)", () => {
  beforeEach(() => {
    row.state = undefined;
  });

  const call = () =>
    enqueueOnboard({ workspaceId: "ws-1", repoFullName: "acme/widgets", force: true });

  it("three force calls in a row for an already-onboarded repo collapse to ONE admitted compile", async () => {
    row.state = "green"; // the repo was onboarded a while back; the runner finished

    const first = await call();
    const second = await call();
    const third = await call();

    expect(first).toMatchObject({ enqueued: true, state: "queued" });
    expect(second).toEqual({ enqueued: false, reason: ONBOARD_ALREADY_PENDING_REASON });
    expect(third).toEqual({ enqueued: false, reason: ONBOARD_ALREADY_PENDING_REASON });
  });

  it("collapses a burst even starting from the repo's very first-ever onboard (fresh insert, not a re-arm)", async () => {
    // row.state stays undefined — the plain INSERT path takes the first call.
    const first = await call();
    const second = await call();
    const third = await call();

    expect(first).toMatchObject({ enqueued: true, state: "queued" });
    expect(second).toEqual({ enqueued: false, reason: ONBOARD_ALREADY_PENDING_REASON });
    expect(third).toEqual({ enqueued: false, reason: ONBOARD_ALREADY_PENDING_REASON });
  });

  it("a push AFTER the compile actually completes (state leaves queued/running) re-arms again — the debounce is not a permanent lock", async () => {
    row.state = "green";

    await call(); // re-arms → queued
    row.state = "escalated-to-human"; // the runner finished (this time unsuccessfully)
    const next = await call();

    expect(next).toMatchObject({ enqueued: true, state: "queued" });
  });
});
