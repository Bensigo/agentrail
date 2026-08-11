import { describe, it, expect } from "vitest";
import {
  containsSecretShapedValue,
  scanForSecrets,
  summarizeFindings,
  REDACTION_PLACEHOLDER,
} from "./secret-scan";

describe("scanForSecrets", () => {
  it("marks ordinary prose as clean", () => {
    const res = scanForSecrets(
      "We decided to use Eve for Jace; prefer names over IDs in the UI."
    );
    expect(res.clean).toBe(true);
    expect(res.findings).toHaveLength(0);
    expect(res.redacted).toContain("Eve");
  });

  it("does not flag a plain sentence containing the word password", () => {
    const res = scanForSecrets("Reset your password from the account settings page.");
    expect(res.clean).toBe(true);
  });

  it("detects an AWS access key id", () => {
    const res = scanForSecrets("prod key is AKIAIOSFODNN7EXAMPLE, rotate it");
    expect(res.clean).toBe(false);
    expect(res.findings.map((f) => f.kind)).toContain("aws_access_key_id");
    expect(res.redacted).toContain(REDACTION_PLACEHOLDER);
    expect(res.redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("detects a GitHub personal access token", () => {
    const res = scanForSecrets("token ghp_abcdef0123456789ABCDEFabcdef01234567 works");
    expect(res.clean).toBe(false);
    expect(res.findings.map((f) => f.kind)).toContain("github_token");
    expect(res.redacted).not.toContain("ghp_abcdef0123456789");
  });

  it("detects a Slack token", () => {
    // Assembled from fragments at runtime so this synthetic fixture is not a
    // contiguous secret-shaped literal in source (GitHub push protection flags
    // Slack's token format even for fakes). The scanner still sees the full
    // string at call time.
    const slackToken = ["xoxb", "123456789012", "abcdefghijklmnopqrstuvwx"].join("-");
    const res = scanForSecrets(slackToken);
    expect(res.clean).toBe(false);
    expect(res.findings.map((f) => f.kind)).toContain("slack_token");
  });

  it("detects an Anthropic API key", () => {
    const res = scanForSecrets("ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345");
    expect(res.clean).toBe(false);
    const kinds = res.findings.map((f) => f.kind);
    expect(kinds).toContain("anthropic_key");
  });

  it("detects a PEM private key block", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEabc123\nDEFxyz==\n-----END RSA PRIVATE KEY-----";
    const res = scanForSecrets(`here is the key\n${pem}\nkeep it safe`);
    expect(res.clean).toBe(false);
    expect(res.findings.map((f) => f.kind)).toContain("private_key_block");
    expect(res.redacted).not.toContain("MIIEabc123");
    // Surrounding prose survives redaction.
    expect(res.redacted).toContain("here is the key");
    expect(res.redacted).toContain("keep it safe");
  });

  it("detects a JWT", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N";
    const res = scanForSecrets(`session=${jwt}`);
    expect(res.clean).toBe(false);
    expect(res.findings.map((f) => f.kind)).toContain("jwt");
  });

  it("detects a connection string with an inline password", () => {
    const res = scanForSecrets(
      "DATABASE_URL=postgres://admin:hunter2secret@db.internal:5432/app"
    );
    expect(res.clean).toBe(false);
    expect(res.findings.map((f) => f.kind)).toContain("connection_string_password");
    expect(res.redacted).not.toContain("hunter2secret");
  });

  it("detects a bearer authorization token", () => {
    const res = scanForSecrets("call it with Bearer abcdefghijklmnopqrstuvwxyz012345");
    expect(res.clean).toBe(false);
    expect(res.findings.map((f) => f.kind)).toContain("bearer_token");
  });

  it("detects a generic assigned secret", () => {
    const res = scanForSecrets('client_secret = "s3cr3t-value-here-9x8y"');
    expect(res.clean).toBe(false);
    expect(res.findings.map((f) => f.kind)).toContain("generic_assigned_secret");
    expect(res.redacted).not.toContain("s3cr3t-value-here-9x8y");
  });

  it.each([
    "authorization: supersecret",
    "authorization: \"supersecret\"",
    "authorization: \"supersecret\" before retrying",
    "Use authorization: \"supersecret\".",
    "token: supersecret",
    "api_key: supersecret",
    "token=abcdefghijk12345",
    "api_key=abcdefghijk12345",
  ])("detects colon/equal credential assignments", (value) => {
    const res = scanForSecrets(value);
    expect(res.clean).toBe(false);
    expect(res.findings.map((finding) => finding.kind)).toContain("generic_assigned_secret");
  });

  it.each([
    "Bearer abcdefghijklmnopqrstuvwxyz",
    "bearer abcdefghijklmnopqrstuvwxyz",
    "BEARER abcdefghijklmnopqrstuvwxyz",
  ])("detects standalone Bearer credentials without case drift", (value) => {
    expect(scanForSecrets(value).findings.map((finding) => finding.kind))
      .toContain("bearer_token");
  });

  it("detects additional common provider prefixes", () => {
    const providerValues = [
      ["sk", "live", "abcdefghijklmnopqrstuvwx"].join("_"),
      ["glpat", "abcdefghijklmnopqrstuvwx"].join("-"),
      ["npm", "abcdefghijklmnopqrstuvwx"].join("_"),
    ];
    expect(providerValues.map((value) => scanForSecrets(value).clean)).toEqual([false, false, false]);
  });

  it("keeps ordinary credential-related prose clean", () => {
    expect(scanForSecrets("The authorization step requires an owner.").clean).toBe(true);
    expect(scanForSecrets("Reset your password from the account settings page.").clean).toBe(true);
    expect(scanForSecrets("The token count is displayed in the footer.").clean).toBe(true);
    expect(scanForSecrets("authorization: required before continuing").clean).toBe(true);
    expect(scanForSecrets("token: generation happens after approval").clean).toBe(true);
    expect(scanForSecrets("api_key: required for local testing").clean).toBe(true);
    expect(scanForSecrets("Authorization: \"required\" by the owner").clean).toBe(true);
  });

  it("scans nested envelope keys, credential pairs, and values and fails closed for cycles", () => {
    expect(containsSecretShapedValue({ outcomes: [{ observed: "token=abcdefghijk12345" }] }))
      .toBe(true);
    expect(containsSecretShapedValue({ "api_key=abcdefghijk12345": "masked" })).toBe(true);
    expect(containsSecretShapedValue({ token: "abcdefghijk12345" })).toBe(true);
    expect(containsSecretShapedValue({ api_key: "The key is not available yet." })).toBe(false);
    expect(containsSecretShapedValue({ token: null, token_count: 12 })).toBe(false);
    expect(containsSecretShapedValue({ outcomes: [{ observed: "The expected text was absent." }] }))
      .toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(containsSecretShapedValue(cyclic)).toBe(true);
  });

  it("collects multiple findings from one blob", () => {
    const res = scanForSecrets(
      "AKIAIOSFODNN7EXAMPLE and ghp_abcdef0123456789ABCDEFabcdef01234567"
    );
    expect(res.clean).toBe(false);
    expect(res.findings.length).toBeGreaterThanOrEqual(2);
  });

  it("is stateless across calls (no leaked regex lastIndex)", () => {
    const secret = "prod key is AKIAIOSFODNN7EXAMPLE";
    const first = scanForSecrets(secret);
    const second = scanForSecrets(secret);
    expect(first.clean).toBe(false);
    expect(second.clean).toBe(false);
    expect(second.findings).toHaveLength(first.findings.length);
  });
});

describe("summarizeFindings", () => {
  it("summarizes kinds without leaking the secret value", () => {
    const res = scanForSecrets(
      "AKIAIOSFODNN7EXAMPLE and ghp_abcdef0123456789ABCDEFabcdef01234567"
    );
    const summary = summarizeFindings(res.findings);
    expect(summary).toContain("aws_access_key_id");
    expect(summary).toContain("github_token");
    // The reason string must never carry the raw secret.
    expect(summary).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(summary).not.toContain("ghp_abcdef");
  });
});
