/**
 * Conservative secret-shape denial for criterion and correction custody.
 *
 * This mirrors the semantic coverage of Console's `scanForSecrets` without
 * introducing a DB -> Console dependency. It only matches credential-shaped
 * values (provider formats, bearer/JWT/private-key material, connection-string
 * credentials, or explicit credential assignments); ordinary words such as
 * "password" or "authorization" remain valid prose.
 */
const CREDENTIAL_FIELD_NAME = /^(?:api[_-]?key|secret[_-]?key|access[_-]?token|api[_-]?token|auth[_-]?token|authorization|client[_-]?secret|password|passwd|secret|token)$/iu;
const COMPACT_CREDENTIAL_VALUE = /^[A-Za-z0-9._~+/=-]{8,}$/u;

const SECRET_SHAPES: readonly RegExp[] = [
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/u,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\baws.{0,20}(?:secret|access).{0,20}[=:]\s*['"]?[A-Za-z0-9/+]{40}['"]?/iu,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/u,
  /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/u,
  /\bglpat-[0-9A-Za-z_-]{20,}\b/u,
  /\bnpm_[0-9A-Za-z]{20,}\b/u,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/u,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/iu,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/iu,
  /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|api[_-]?token|auth[_-]?token|authorization|client[_-]?secret|password|passwd|secret|token)\b\s*=\s*(?:["'][A-Za-z0-9._~+/=-]{8,}["']|[A-Za-z0-9._~+/=-]{8,})(?=$|[\s,;)}\]])/imu,
  /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|api[_-]?token|auth[_-]?token|authorization|client[_-]?secret|password|passwd|secret|token)\b\s*:\s*(?:["'][A-Za-z0-9._~+/=-]{10,}["'](?=$|[\s,;.!?)}\]])|["'][A-Za-z0-9._~+/=-]{8,9}["'](?=$|[,;)}\]])|[A-Za-z0-9._~+/=-]{8,}(?=$|[,;)}\]]))/imu,
];

export function criterionVisibleTextContainsSecret(value: string): boolean {
  return SECRET_SHAPES.some((pattern) => pattern.test(value));
}

/** Fail closed for cyclic or excessively deep untrusted JSON-like values. */
export function criterionVisibleValueContainsSecret(value: unknown): boolean {
  const ancestors = new WeakSet<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (typeof item === "string") return criterionVisibleTextContainsSecret(item);
    if (item === null || typeof item !== "object") return false;
    if (depth > 16 || ancestors.has(item)) return true;
    ancestors.add(item);
    try {
      return Array.isArray(item)
        ? item.some((nested) => visit(nested, depth + 1))
        : Object.entries(item).some(([key, nested]) =>
          criterionVisibleTextContainsSecret(key)
          || (CREDENTIAL_FIELD_NAME.test(key)
            && typeof nested === "string"
            && nested === nested.trim()
            && COMPACT_CREDENTIAL_VALUE.test(nested))
          || visit(nested, depth + 1));
    } finally {
      ancestors.delete(item);
    }
  };
  return visit(value, 0);
}
