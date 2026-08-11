import { describe, expect, it } from "vitest";
import {
  criterionVisibleTextContainsSecret,
  criterionVisibleValueContainsSecret,
} from "./criterion-visible-secret-scan.js";

describe("criterion-visible secret-shape denial", () => {
  it.each([
    "authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "bearer abcdefghijklmnopqrstuvwxyz",
    "BEARER abcdefghijklmnopqrstuvwxyz",
    "authorization: supersecret",
    "authorization: \"supersecret\"",
    "authorization: \"supersecret\" before retrying",
    "Use authorization: \"supersecret\".",
    "token: supersecret",
    "api_key: supersecret",
    "token=abcdefghijk12345",
    "api_key=abcdefghijk12345",
    "prod key is AKIAIOSFODNN7EXAMPLE",
    "github_pat_abcdefghijklmnopqrstuvwxyz123456",
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
    "postgres://admin:hunter2secret@db.internal:5432/app",
    "-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----",
  ])("rejects credential-shaped text without returning the matched value", (value) => {
    expect(criterionVisibleTextContainsSecret(value)).toBe(true);
  });

  it.each([
    "Reset your password from the account settings page.",
    "The authorization step requires an owner.",
    "The token count is displayed in the footer.",
    "The API key field must remain empty.",
    "The exact-head endpoint returned HTTP 503.",
    "authorization: required before continuing",
    "token: generation happens after approval",
    "api_key: required for local testing",
    "Authorization: \"required\" by the owner",
  ])("keeps ordinary criterion and correction prose valid", (value) => {
    expect(criterionVisibleTextContainsSecret(value)).toBe(false);
  });

  it("scans nested keys, credential pairs, and values and fails closed for cycles", () => {
    expect(criterionVisibleValueContainsSecret({
      outcomes: [{ observed: "token=abcdefghijk12345" }],
    })).toBe(true);
    expect(criterionVisibleValueContainsSecret({
      "api_key=abcdefghijk12345": "masked",
    })).toBe(true);
    expect(criterionVisibleValueContainsSecret({ token: "abcdefghijk12345" })).toBe(true);
    expect(criterionVisibleValueContainsSecret({
      api_key: "The key is not available yet.",
    })).toBe(false);
    expect(criterionVisibleValueContainsSecret({ token: null, token_count: 12 })).toBe(false);
    expect(criterionVisibleValueContainsSecret({
      outcomes: [{ observed: "The expected text was not visible." }],
    })).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(criterionVisibleValueContainsSecret(cyclic)).toBe(true);
  });
});
