/**
 * Write-side secret scan / deny-list for memory-item ingest (issue #1032).
 *
 * Memory content is advisory text that later gets injected verbatim into agent
 * prompts (see CONTEXT.md). That makes it a data-exfiltration surface: if a
 * credential-shaped string is ever persisted as a "memory", it can be surfaced
 * back out through a prompt to any run in the workspace. This module rejects or
 * redacts credential-shaped content at the ingest boundary, BEFORE it can reach
 * storage — the earliest and only place we control the write.
 *
 * Detection is pattern-based (a deny-list), not a guarantee. It is deliberately
 * biased toward false positives over false negatives: for secrets, a spurious
 * rejection is cheap, a leaked credential is not. Callers get structured
 * findings and a redacted copy so they can choose reject-vs-redact policy.
 */

export type SecretKind =
  | "aws_access_key_id"
  | "aws_secret_access_key"
  | "private_key_block"
  | "github_token"
  | "slack_token"
  | "google_api_key"
  | "openai_key"
  | "anthropic_key"
  | "jwt"
  | "bearer_token"
  | "connection_string_password"
  | "generic_assigned_secret";

export interface SecretFinding {
  kind: SecretKind;
  /** The matched substring (never logged in full — for callers to inspect/redact). */
  match: string;
  /** Human-readable reason recorded with the rejection/redaction. */
  reason: string;
}

interface Rule {
  kind: SecretKind;
  pattern: RegExp;
  reason: string;
}

// The placeholder that replaces a detected secret span in redacted output.
export const REDACTION_PLACEHOLDER = "[REDACTED_SECRET]";

/**
 * Deny-list of credential-shaped patterns. Order does not matter — every rule is
 * evaluated. Patterns are intentionally specific enough to avoid nuking ordinary
 * prose (e.g. we require the AWS-secret rule to sit next to an aws/secret hint),
 * while the generic assignment rule catches `password = "…"` style leaks.
 *
 * All patterns are global+multiline so a single content blob with several
 * secrets yields several findings.
 */
const RULES: Rule[] = [
  {
    kind: "private_key_block",
    // -----BEGIN ... PRIVATE KEY-----
    pattern: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g,
    reason: "PEM private key block",
  },
  {
    kind: "aws_access_key_id",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    reason: "AWS access key id",
  },
  {
    kind: "aws_secret_access_key",
    // 40-char base64-ish secret sitting next to an aws/secret hint.
    pattern:
      /\baws.{0,20}(?:secret|access).{0,20}[=:]\s*['"]?[A-Za-z0-9/+]{40}['"]?/gi,
    reason: "AWS secret access key",
  },
  {
    kind: "github_token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
    reason: "GitHub token",
  },
  {
    kind: "slack_token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    reason: "Slack token",
  },
  {
    kind: "google_api_key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    reason: "Google API key",
  },
  {
    kind: "openai_key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    reason: "OpenAI-style secret key",
  },
  {
    kind: "anthropic_key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    reason: "Anthropic API key",
  },
  {
    kind: "jwt",
    // header.payload.signature — three base64url segments.
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    reason: "JSON Web Token",
  },
  {
    kind: "connection_string_password",
    // scheme://user:password@host — capture the credentials segment.
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/gi,
    reason: "connection string with inline password",
  },
  {
    kind: "bearer_token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
    reason: "bearer authorization token",
  },
  {
    kind: "generic_assigned_secret",
    // key/token/secret/password/api_key = "at least 8 non-space chars"
    pattern:
      /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)\b\s*[=:]\s*['"]?[^\s'"]{8,}['"]?/gi,
    reason: "assigned credential value",
  },
];

/**
 * Scan a single content string for credential-shaped substrings.
 *
 * @returns `clean` (no findings), the `redacted` copy with every detected span
 *          replaced by {@link REDACTION_PLACEHOLDER}, and the list of `findings`.
 */
export function scanForSecrets(content: string): {
  clean: boolean;
  redacted: string;
  findings: SecretFinding[];
} {
  const findings: SecretFinding[] = [];
  let redacted = content;

  for (const rule of RULES) {
    // Reset lastIndex defensively (global regexes are stateful).
    rule.pattern.lastIndex = 0;
    const matches = content.match(rule.pattern);
    if (!matches) continue;
    for (const match of matches) {
      findings.push({ kind: rule.kind, match, reason: rule.reason });
    }
    redacted = redacted.replace(rule.pattern, REDACTION_PLACEHOLDER);
  }

  return { clean: findings.length === 0, redacted, findings };
}

/**
 * Build a compact, non-sensitive reason string from findings for logging /
 * recording with a rejection. Never includes the matched secret value itself —
 * only the kinds detected — so the reason itself can't leak the credential.
 */
export function summarizeFindings(findings: SecretFinding[]): string {
  const kinds = Array.from(new Set(findings.map((f) => f.kind)));
  return `blocked ${findings.length} secret-shaped value(s): ${kinds.join(", ")}`;
}
