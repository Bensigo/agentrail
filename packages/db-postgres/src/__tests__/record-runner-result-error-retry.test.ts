/**
 * Acceptance test for issue #890 — error-result retry logic.
 *
 * WHY THIS IS RED BEFORE THE FIX:
 *   `recordRunnerResult({ status: "error" })` currently routes through the
 *   drizzle builder chain calling `db.update().set({ state: 'blocked' })`,
 *   never invoking `db.execute`.  This test expects `db.execute` to be called
 *   with raw SQL that atomically increments `error_attempts` and branches via
 *   CASE between re-queuing (< 5 attempts) and escalating-to-human (≥ 5).
 *   That contract does not exist yet, so the first `toHaveBeenCalled()` assertion
 *   immediately fails — making the test genuinely red before any implementation.
 *
 * Covered acceptance criteria (issue #890):
 *   AC1 – error result re-queues the entry (state='queued') while < 5 attempts,
 *          NOT going straight to 'blocked'.
 *   AC2 – after 5 consecutive errors the entry moves to 'escalated-to-human'
 *          (hard ceiling, no infinite loop).
 *   AC3 – error_attempts count is persisted and incremented on the queue entry.
 *
 * AC4 (last error reason preserved) and AC5 (green/red unchanged) are covered
 * by the existing test suite and the green/red paths in this same function; they
 * are not duplicated here so this single test stays focused on the AC1–AC3 contract.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  db: {
    execute: vi.fn(),
    update: vi.fn(),
  },
}));

import { db } from "../db.js";
import { recordRunnerResult } from "../queries/runner.js";

const mockDb = vi.mocked(db);

/**
 * Recursively render a drizzle `sql` template-tag object to a plain string so
 * we can assert on the query text without a live database.
 * Mirrors the helper in runner-stats.test.ts.
 */
function sqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const maybeValue = (value as { value?: unknown }).value;
  if (Array.isArray(maybeValue)) return maybeValue.map(sqlText).join("");
  const queryChunks = (value as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(queryChunks)) return queryChunks.map(sqlText).join("");
  return "";
}

/** Minimal drizzle builder chain for `db.update(...)` call sites. */
function makeDrizzleChain() {
  const chain: Record<string, unknown> = {};
  for (const m of ["set", "where", "returning"]) {
    chain[m] = vi.fn(() => chain);
  }
  // .returning() must resolve to an array (the queue_entries or runs UPDATE result).
  (chain.returning as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  return chain;
}

describe("recordRunnerResult — issue-890 error retry (AC1–AC3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Wire up db.update with a usable chain; needed for the `runs` status-mirror
    // call that follows the queue_entries state transition regardless of status.
    const chain = makeDrizzleChain();
    mockDb.update = vi.fn(() => chain as ReturnType<typeof db.update>);
  });

  it(
    "AC1–AC3: error result must call db.execute with SQL that increments " +
      "error_attempts and branches via CASE between 'queued' (retry) and " +
      "'escalated-to-human' (hard cap of 5) — never setting state='blocked'",
    async () => {
      // db.execute simulates a successful UPDATE returning one matched row.
      mockDb.execute = vi.fn(
        async () => [{ id: "q1" }]
      ) as unknown as typeof db.execute;

      await recordRunnerResult({ id: "q1", workspaceId: "ws-1", status: "error" });

      const execFn = mockDb.execute as unknown as ReturnType<typeof vi.fn>;

      // ── AC1 + AC3 ────────────────────────────────────────────────────────────
      // The implementation must route through db.execute (raw SQL with CASE logic)
      // rather than unconditionally writing state='blocked' via db.update.
      expect(
        execFn,
        "AC1/AC3: error must call db.execute for atomic retry logic, not only db.update"
      ).toHaveBeenCalled();

      const query = sqlText(execFn.mock.calls[0]?.[0]);

      // AC3: error_attempts must be present and incremented atomically in the SQL.
      expect(query, "AC3: SQL must reference the error_attempts column").toMatch(
        /error_attempts/i
      );
      expect(query, "AC3: SQL must increment error_attempts by 1").toMatch(
        /error_attempts\s*\+\s*1/i
      );

      // AC1: 'blocked' must NOT appear as an unconditional state assignment.
      expect(
        query,
        "AC1: must not set state='blocked' unconditionally — error must retry before blocking"
      ).not.toMatch(/=\s*'blocked'/);

      // AC1: 'queued' must appear as the re-queue outcome (attempts below cap).
      expect(query, "AC1: SQL must include 'queued' as the retry state").toMatch(
        /'queued'/
      );

      // ── AC2 ──────────────────────────────────────────────────────────────────
      // 'escalated-to-human' must appear as the terminal outcome at the cap.
      expect(
        query,
        "AC2: SQL must include 'escalated-to-human' as the terminal state at cap"
      ).toMatch(/'escalated-to-human'/);

      // The branch must be expressed as a CASE expression (mirrors the red path).
      expect(
        query,
        "AC2: SQL must use a CASE expression to branch between retry and terminal"
      ).toMatch(/CASE/i);

      // The hard cap of 5 must be encoded: threshold is either stored-count >= 5
      // or stored-count > 4 — the literal 4 or 5 must appear in the CASE clause.
      expect(
        query,
        "AC2: hard cap of 5 attempts must be encoded in the CASE threshold (literal 4 or 5)"
      ).toMatch(/\b[45]\b/);
    }
  );
});
