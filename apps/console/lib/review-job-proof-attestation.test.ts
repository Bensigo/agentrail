import { describe, expect, it } from "vitest";
import { parseCriterionResults } from "./review-job-proof-attestation";

const safeResult = {
  criterionId: "AC-1",
  state: "failed",
  expected: "The saved filter is visible.",
  observed: "The exact-head page returned an error.",
  evidenceRefs: ["review-ui-execution:ui-123"],
};

describe("criterion result parser secret boundary", () => {
  it.each([
    "authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "token=abcdefghijk12345",
    "api_key=abcdefghijk12345",
    "AKIAIOSFODNN7EXAMPLE",
    "github_pat_abcdefghijklmnopqrstuvwxyz123456",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
    "-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----",
  ])("rejects a secret-shaped outcome string", (observed) => {
    expect(parseCriterionResults([{ ...safeResult, observed }])).toBeNull();
  });

  it("rejects secret-shaped criterion ids, expected text, and evidence references", () => {
    expect(parseCriterionResults([{
      ...safeResult,
      criterionId: "token=abcdefghijk12345",
    }])).toBeNull();
    expect(parseCriterionResults([{
      ...safeResult,
      expected: "api_key=abcdefghijk12345",
    }])).toBeNull();
    expect(parseCriterionResults([{
      ...safeResult,
      evidenceRefs: ["authorization: abcdefghijk12345"],
    }])).toBeNull();
  });

  it("preserves ordinary credential-related observation prose", () => {
    expect(parseCriterionResults([{
      ...safeResult,
      observed: "The authorization step asked the user to reset their password.",
    }])).toEqual([{
      ...safeResult,
      observed: "The authorization step asked the user to reset their password.",
    }]);
  });
});
