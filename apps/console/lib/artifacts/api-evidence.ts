/** Redact an inspectable API proof payload before it can enter artifact storage. */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(authorization|token|secret|password|cookie|api[-_]?key|credential)/i;
const CREDENTIAL_TEXT = /\b(bearer|basic)\s+[^\s,;]+/gi;
const SENSITIVE_QUERY = /([?&](?:authorization|token|secret|password|cookie|api[-_]?key|apikey|credential)=[^&#\s]*)/gi;
const MAX_DEPTH = 12;

export class ApiEvidenceError extends Error {}

/**
 * Return a JSON-safe copy with credential-bearing fields and common credential
 * text redacted. Callers must supply structured evidence; unknown runtime
 * values and excessive nesting are rejected rather than stringified.
 */
export function redactApiEvidence(value: unknown): JsonValue {
  return redact(value, 0, false);
}

function redact(value: unknown, depth: number, sensitive: boolean): JsonValue {
  if (depth > MAX_DEPTH) throw new ApiEvidenceError("API evidence exceeds the maximum nesting depth");
  if (sensitive) return REDACTED;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ApiEvidenceError("API evidence numbers must be finite");
    return value;
  }
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, false));
  if (!isRecord(value)) throw new ApiEvidenceError("API evidence must be JSON-like structured data");
  const output: { [key: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(value)) output[key] = redact(item, depth + 1, SENSITIVE_KEY.test(key));
  return output;
}

function redactText(value: string): string {
  const redactedUrl = redactUrl(value);
  return redactedUrl
    .replace(CREDENTIAL_TEXT, "$1 " + REDACTED)
    .replace(SENSITIVE_QUERY, (_match, capture: string) => `${capture.slice(0, capture.indexOf("=") + 1)}${REDACTED}`);
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    let changed = Boolean(url.username || url.password);
    if (url.username) url.username = REDACTED;
    if (url.password) url.password = REDACTED;
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_KEY.test(key)) {
        url.searchParams.set(key, REDACTED);
        changed = true;
      }
    }
    return changed ? url.toString() : value;
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
