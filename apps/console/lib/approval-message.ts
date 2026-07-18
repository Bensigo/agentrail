/**
 * Rich approval-message rendering (issue #1273) — turns a gated tool's
 * ACTUAL input into the text an approver reads, replacing Eve's stock HITL
 * renderer (which shows only "Approve tool call: `<name>`" + Yes/No on
 * Telegram, no input at all — see `apps/jace/agent/tools/create_repo.ts`'s
 * doc-comment). Pure and channel-agnostic: no fetch, no db, no Telegram Bot
 * API shapes — those live in the `connectors/secret/telegram.ts` sender.
 *
 * Every renderer here is defensive against malformed `toolInput` (a
 * "gated tool" contract violation, or a future tool this file doesn't know
 * about yet — see the generic fallback) and sanitizes untrusted string
 * fields before they reach a chat message:
 *
 *  - Newlines (and lone carriage returns) are flattened to spaces so a
 *    crafted field can never fake extra message lines or overwrite prior
 *    text via a bare CR.
 *  - Zero-width and bidi-override/isolate characters are stripped — the
 *    "Trojan Source" class of visual-spoofing trick (CVE-2021-42574-style),
 *    e.g. a right-to-left override making a field display in reversed/
 *    reordered text.
 *  - Each field is length-capped independently, and the fully composed
 *    message is hard-truncated (with an explicit note — never silent) to
 *    Telegram's real 4096-character `sendMessage` limit.
 *
 * Telegram's `sendMessage` is called with no `parse_mode` (see
 * `connectors/secret/telegram.ts`), so this text is never Markdown/HTML
 * -interpreted by Telegram itself — the sanitizing above is about visual
 * spoofing and message-structure integrity, not markup injection.
 */

/** Telegram's real per-message character cap (Bot API `sendMessage`). */
export const TELEGRAM_TEXT_LIMIT = 4096;

const TRUNCATION_NOTE = "\n\n[truncated - over Telegram's message limit]";

/** Hard backstop: never let composed text exceed Telegram's real limit. Always announces truncation, never silent. */
function hardTruncate(text: string): string {
  if (text.length <= TELEGRAM_TEXT_LIMIT) return text;
  const budget = Math.max(0, TELEGRAM_TEXT_LIMIT - TRUNCATION_NOTE.length);
  return text.slice(0, budget) + TRUNCATION_NOTE;
}

/**
 * Build a `[...]` character-class RegExp from NUMERIC code points via
 * `String.fromCharCode`, rather than writing the characters literally in a
 * regex — deliberately, so this source file's own bytes never contain a raw
 * invisible/control/bidi-override character (the exact "Trojan Source"
 * hazard this sanitizer defends against; embedding one directly here would
 * just relocate the hazard into this file's own diffs).
 */
function charClassFrom(codePoints: readonly number[]): RegExp {
  const chars = codePoints.map((cp) => String.fromCharCode(cp)).join("");
  return new RegExp(`[${chars}]`, "g");
}

// Zero-width space, ZWNJ, ZWJ, BOM/ZW-no-break-space, and the bidi
// format/isolate controls (LRE, RLE, PDF, LRO, RLO, LRI, RLI, FSI, PDI).
const INVISIBLE_OR_BIDI = charClassFrom([
  0x200b, 0x200c, 0x200d, 0xfeff, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2066, 0x2067, 0x2068, 0x2069,
]);

// C0 control characters (0x00-0x1F, 0x7F) other than CR/LF (0x0D/0x0A),
// which are flattened separately below (sanitizeField).
const OTHER_CONTROL_CHARS = charClassFrom([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0b, 0x0c,
  0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19,
  0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x7f,
]);

/** `JSON.stringify`, defensively (a circular structure must never crash a render). */
function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Sanitize a single untrusted field for display: coerce to a string
 * (non-strings are JSON-stringified — used by the generic fallback), strip
 * invisible/bidi-spoofing and other control characters, flatten CR/LF to a
 * space each (a LONE \r with no \n is still a line-start overwrite trick in
 * many terminal/chat renderers, so both are flattened individually rather
 * than only the \r\n/\n pair), trim, and cap to `maxLen` with an ellipsis
 * marker. Never throws.
 */
function sanitizeField(value: unknown, maxLen: number): string {
  const raw =
    typeof value === "string"
      ? value
      : value === null || value === undefined
        ? ""
        : safeJsonStringify(value);
  const cleaned = raw
    .replace(INVISIBLE_OR_BIDI, "")
    .replace(OTHER_CONTROL_CHARS, "")
    .replace(/[\r\n]/g, " ")
    .trim();
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}...` : cleaned;
}

function renderCreateIssue(input: Record<string, unknown>): string {
  const title = sanitizeField(input["title"], 200) || "(untitled)";
  const rawCriteria = input["acceptanceCriteria"];
  const criteria = Array.isArray(rawCriteria)
    ? rawCriteria.map((item) => sanitizeField(item, 300))
    : [];

  const lines = ["Approve creating this issue?", "", `Title: ${title}`];
  if (criteria.length > 0) {
    lines.push("", "Acceptance criteria:");
    for (const item of criteria) lines.push(`- ${item}`);
  }
  return hardTruncate(lines.join("\n"));
}

function renderCreateWorkspace(input: Record<string, unknown>): string {
  const name = sanitizeField(input["name"], 80) || "(unnamed)";
  return hardTruncate(`Approve creating workspace "${name}"?`);
}

function renderCreateRepo(input: Record<string, unknown>): string {
  const name = sanitizeField(input["name"], 100) || "(unnamed)";
  // create_repo.ts: `private` is optional and omitted defaults to private —
  // so anything other than the literal `false` renders as private.
  const isPrivate = input["private"] !== false;
  return hardTruncate(
    `Approve creating repo "${name}" (${isPrivate ? "private" : "public"})?`
  );
}

/**
 * Cap on how many `toolInput` keys the generic fallback renders. `hardTruncate`
 * alone isn't enough protection against a wide/adversarial object (hundreds
 * of keys): its note only fires once the FULL composed text is already over
 * Telegram's limit, so a moderately-sized wall of short fields could still
 * bury the actually useful bit (toolName, the first few real fields) under
 * key noise well before hardTruncate ever kicks in.
 */
const GENERIC_FALLBACK_MAX_KEYS = 12;

/** Unknown tool: toolName + compact key:value lines, so PR ② never blocks on shipping a new gated tool before this file learns to render it. */
function renderGenericFallback(
  toolName: string,
  input: Record<string, unknown>
): string {
  const lines = [`Approve tool call: ${sanitizeField(toolName, 100)}`];
  const entries = Object.entries(input);
  const shown = entries.slice(0, GENERIC_FALLBACK_MAX_KEYS);
  for (const [key, value] of shown) {
    lines.push(`${sanitizeField(key, 60)}: ${sanitizeField(value, 200)}`);
  }
  const omitted = entries.length - shown.length;
  if (omitted > 0) {
    lines.push(`...and ${omitted} more`);
  }
  return hardTruncate(lines.join("\n"));
}

/**
 * Render the approve/deny message text for a gated tool call. Dispatches on
 * `toolName`; any tool this file doesn't specifically know about renders via
 * the generic fallback rather than failing closed.
 */
export function renderApprovalMessage(
  toolName: string,
  toolInput: Record<string, unknown>
): string {
  switch (toolName) {
    case "create_issue":
      return renderCreateIssue(toolInput);
    case "create_workspace":
      return renderCreateWorkspace(toolInput);
    case "create_repo":
      return renderCreateRepo(toolInput);
    default:
      return renderGenericFallback(toolName, toolInput);
  }
}
