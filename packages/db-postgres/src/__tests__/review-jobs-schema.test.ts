import { describe, expect, it } from "vitest";
import { reviewJobs } from "../schema/review_jobs.js";

/**
 * B2a §1 Task 3 — pure schema-declaration coverage for
 * `review_jobs.evidence_keys`, mirroring `runs-schema.test.ts`'s idiom
 * (assert against the schema OBJECT directly, no live-DB harness needed for
 * this half). This is the "schema" side of "schema↔SQL agreement": the
 * migration (0067_review_jobs_evidence_keys.sql) is hand-authored, not
 * `drizzle-kit generate`d from this file, so nothing enforces the two stay
 * in sync automatically — this test pins what the DRIZZLE side claims
 * (column name, nullability, no default, `jsonb` SQL type via
 * `getSQLType()`), and `review-jobs.integration.test.ts`'s own
 * `completeReviewJob` evidence_keys cases are the live-Postgres proof that
 * the hand-authored migration actually backs it with a real, compatible
 * column — together the two halves are the full agreement proof a mock
 * alone could never give (a mock would happily "accept" a column that was
 * never actually added).
 */
describe("review_jobs schema — evidence_keys (B2a §1 Task 3)", () => {
  it("declares evidence_keys nullable with no default", () => {
    expect(reviewJobs.evidenceKeys.name).toBe("evidence_keys");
    expect(reviewJobs.evidenceKeys.notNull).toBe(false);
    expect(reviewJobs.evidenceKeys.default).toBeUndefined();
  });

  it("declares evidence_keys as a jsonb SQL column — matches the migration's bare `jsonb` type exactly", () => {
    expect(reviewJobs.evidenceKeys.getSQLType()).toBe("jsonb");
  });
});
