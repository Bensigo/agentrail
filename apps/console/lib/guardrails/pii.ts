/**
 * Layer 1 of Jace's input guardrails — deterministic PII detection and
 * cleansing (spec: docs/superpowers/specs/2026-07-28-jace-input-guardrails-design.md,
 * "Layer 1 — PII detection and cleansing").
 *
 * WHY CHECKSUMS ARE MANDATORY: a bare 16-digit run is an order number, an
 * invoice number, a phone number with the punctuation stripped — a card
 * number is the only thing on that list with a checksum. Luhn (cards), mod-97
 * (IBAN) and the ABA routing checksum are what separate "looks like a
 * card/IBAN/routing number" from "IS one," so every detector below applies its
 * checksum before ever producing a Finding. Skipping that step turns this
 * module into a false-positive machine that corrupts ordinary chat messages
 * (see "Posture: redact and continue" in the spec — a false positive here
 * silently mangles a legitimate user message).
 *
 * WHY OFFSETS, NEVER RAW TEXT: `Finding` (./types.ts) deliberately carries no
 * matched text — these findings flow into the `guardrail_events` audit row,
 * and persisting the PII we just redacted would defeat the guardrail.
 *
 * Pure, dependency-free, synchronous. No network, no DB, no filesystem, no
 * imports beyond `./types.js` — this must be testable without any stub.
 */

import type { Finding } from "./types";

// ---------------------------------------------------------------------------
// normalizeForScreening
// ---------------------------------------------------------------------------

// Ported from `apps/jace/agent/lib/sanitize-untrusted.core.mjs`'s `INVISIBLES`
// class (that module's own header explains why: these code points are
// themselves invisible or control characters, so they cannot be written as
// literal characters in a regex/string literal without risking the very
// smuggling they exist to close — they are built from numeric code-point
// ranges instead, keeping this source file pure ASCII and every targeted
// range auditable by its hex value).
//
// We port ONLY the INVISIBLES ranges, not `sanitize-untrusted`'s
// EXOTIC_SPACES / LINE_SEPARATORS collapsing — those exist there to make
// *rendered* output tidy. Here we are screening inbound text for PII, not
// rendering it, so ordinary whitespace and newlines must survive untouched
// (an attacker cannot hide a card digit inside a space or a newline the way
// they can inside a zero-width joiner).
function classFromRanges(ranges: Array<[number, number]>): RegExp {
  const body = ranges
    .map(([lo, hi]) => {
      const a = "\\u{" + lo.toString(16) + "}";
      return lo === hi ? a : a + "-\\u{" + hi.toString(16) + "}";
    })
    .join("");
  return new RegExp("[" + body + "]", "gu");
}

const INVISIBLES = classFromRanges([
  [0x00, 0x08], // C0 controls (before TAB)
  [0x0b, 0x0c], // VT, FF
  [0x0e, 0x1f], // SO .. US (after CR)
  [0x7f, 0x9f], // DEL + C1 controls
  [0xad, 0xad], // soft hyphen
  [0x34f, 0x34f], // combining grapheme joiner
  [0x61c, 0x61c], // Arabic letter mark
  [0x200b, 0x200f], // zero-width space/joiners + LRM/RLM
  [0x202a, 0x202e], // bidi embeddings/overrides (Trojan Source)
  [0x2060, 0x206f], // word-joiner / invisible math / deprecated format
  [0xfe00, 0xfe0e], // variation selectors VS-1..VS-15 (FE0F/VS-16 kept for emoji)
  [0xfeff, 0xfeff], // ZWNBSP / BOM
  [0xfff9, 0xfffb], // interlinear annotation anchors
  [0xe0000, 0xe007f], // Unicode Tags block (invisible ASCII)
  [0xe0100, 0xe01ef], // variation selectors supplement VS-17..VS-256 (byte smuggling)
]);

/**
 * NFC-normalize + strip zero-width/invisible characters, so an attacker
 * cannot split a card number's digits past our regexes with an invisible
 * joiner. Exported so the orchestrator (`input-guardrails.ts`) can reuse the
 * exact same normalization the offsets below are computed against.
 */
export function normalizeForScreening(input: string): string {
  if (typeof input !== "string") return "";
  return input.normalize("NFC").replace(INVISIBLES, "");
}

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

// Luhn mod-10, digit-by-digit from the rightmost digit. `digits` must already
// be a pure 0-9 string (separators stripped by the caller).
function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48; // '0' === 48
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

// ABA routing checksum: (3*(d1+d4+d7) + 7*(d2+d5+d8) + (d3+d6+d9)) % 10 === 0.
function abaChecksumValid(nine: string): boolean {
  const d = (i: number) => nine.charCodeAt(i) - 48;
  const sum =
    3 * (d(0) + d(3) + d(6)) + 7 * (d(1) + d(4) + d(7)) + (d(2) + d(5) + d(8));
  return sum % 10 === 0;
}

// Structural SSN validity (SSA-published invalid ranges): area 000/666/900-999,
// group 00, serial 0000 have never been issued. This is not a checksum — SSNs
// don't have one — but rejecting the impossible ranges is most of what keeps
// a bare 9-digit run from being flagged as an SSN on sight.
function ssnStructurallyValid(nine: string): boolean {
  const area = nine.slice(0, 3);
  const group = nine.slice(3, 5);
  const serial = nine.slice(5, 9);
  if (area === "000" || area === "666") return false;
  if (Number(area) >= 900) return false;
  if (group === "00") return false;
  if (serial === "0000") return false;
  return true;
}

// ISO 13616 mod-97 check: move the first 4 characters to the end, map each
// letter to two digits (A=10..Z=35), and reduce the resulting digit string
// mod 97 incrementally (digit by digit) so we never build a giant Number or
// need BigInt. Valid IBANs reduce to exactly 1.
function ibanValid(rawCandidate: string): boolean {
  // Case-INSENSITIVE on purpose. ISO 13616 prints IBANs uppercase, but people
  // paste what their banking app showed them, and a lowercase paste is exactly
  // the case where the user most needs the redaction to fire. Upper-case once
  // here so the mod-97 letter mapping (A=10..Z=35) below stays simple.
  const candidate = rawCandidate.toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(candidate)) return false;
  const rearranged = candidate.slice(4) + candidate.slice(0, 4);
  let remainder = 0;
  for (let i = 0; i < rearranged.length; i++) {
    const code = rearranged.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      // '0'..'9'
      remainder = (remainder * 10 + (code - 48)) % 97;
    } else if (code >= 65 && code <= 90) {
      // 'A'..'Z' -> 10..35, fed in as two separate digits
      const val = code - 55;
      remainder = (remainder * 10 + Math.floor(val / 10)) % 97;
      remainder = (remainder * 10 + (val % 10)) % 97;
    } else {
      return false;
    }
  }
  return remainder === 1;
}

// ---------------------------------------------------------------------------
// Candidate collection
// ---------------------------------------------------------------------------

type PiiType = "card" | "iban" | "ssn" | "aba" | "sort_code";

interface Candidate {
  type: PiiType;
  start: number;
  end: number;
  reason: string;
}

// Fresh RegExp per call (never a shared module-level `g` regex) so no
// candidate accumulation leaks `lastIndex` state across calls — the same
// discipline `secret-scan.ts` is tested for ("stateless across calls").
function cardRe(): RegExp {
  // 13-19 digits, each optionally preceded by a single space or hyphen.
  // `(?<!\d)` / `(?!\d)` anchor the WHOLE match against digit-adjacency
  // (not each digit), which is what lets a longer contiguous run (a phone
  // number embedded in a URL, a 25-digit tracking id) fail to match at any
  // offset instead of yielding a truncated false positive.
  return /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;
}

function ibanRe(): RegExp {
  // `i` flag pairs with `ibanValid`'s own upper-casing — see the note there on
  // why a lowercase paste must still be caught.
  return /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/gi;
}

function ssnFormattedRe(): RegExp {
  return /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g;
}

function nineDigitRe(): RegExp {
  // Shared by both ABA and bare-SSN detection. The digit-adjacency guard is
  // exactly what the spec asks for: "only match [bare 9-digit runs] when NOT
  // adjacent to other digits."
  return /(?<!\d)\d{9}(?!\d)/g;
}

function sortCodeRe(): RegExp {
  // Hyphens are required by design — a bare 6-digit run is far too common
  // (dates, order suffixes) to match safely.
  return /(?<!\d)\d{2}-\d{2}-\d{2}(?!\d)/g;
}

// Order matters here only for readability/priority in ties (see
// `resolveOverlaps` below): card is collected before aba/ssn so that, on a
// tied start position, a longer card match outranks a shorter aba/ssn match
// nested at the same offset (e.g. a card number that happens to contain an
// isolated 9-digit run next to a single separator).
function collectCandidates(normalized: string): Candidate[] {
  const candidates: Candidate[] = [];

  for (const m of normalized.matchAll(cardRe())) {
    const raw = m[0];
    const digits = raw.replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      candidates.push({
        type: "card",
        start: m.index!,
        end: m.index! + raw.length,
        reason: "Luhn-valid payment card number",
      });
    }
  }

  for (const m of normalized.matchAll(ibanRe())) {
    const raw = m[0];
    if (ibanValid(raw)) {
      candidates.push({
        type: "iban",
        start: m.index!,
        end: m.index! + raw.length,
        reason: "mod-97-valid IBAN",
      });
    }
  }

  for (const m of normalized.matchAll(ssnFormattedRe())) {
    const digits = m[0].replace(/-/g, "");
    if (ssnStructurallyValid(digits)) {
      candidates.push({
        type: "ssn",
        start: m.index!,
        end: m.index! + m[0].length,
        reason: "US Social Security number",
      });
    }
  }

  for (const m of normalized.matchAll(nineDigitRe())) {
    if (abaChecksumValid(m[0])) {
      candidates.push({
        type: "aba",
        start: m.index!,
        end: m.index! + 9,
        reason: "checksum-valid ABA routing number",
      });
    }
  }

  for (const m of normalized.matchAll(nineDigitRe())) {
    if (ssnStructurallyValid(m[0])) {
      candidates.push({
        type: "ssn",
        start: m.index!,
        end: m.index! + 9,
        reason: "US Social Security number",
      });
    }
  }

  for (const m of normalized.matchAll(sortCodeRe())) {
    candidates.push({
      type: "sort_code",
      start: m.index!,
      end: m.index! + m[0].length,
      reason: "UK bank sort code",
    });
  }

  return candidates;
}

// Greedy interval selection: sort by (start asc, length desc) so that at any
// tied or overlapping position the longer — and, failing that, the earlier —
// match wins, then walk left to right keeping only matches that don't overlap
// an already-accepted one. `Array.prototype.sort` is stable, so candidates
// collected earlier by `collectCandidates` (card before iban before
// aba/ssn/sort_code) win ties where start AND length are both equal.
function resolveOverlaps(candidates: Candidate[]): Candidate[] {
  const sorted = [...candidates].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - b.start - (a.end - a.start);
  });
  const accepted: Candidate[] = [];
  let lastEnd = -Infinity;
  for (const c of sorted) {
    if (c.start >= lastEnd) {
      accepted.push(c);
      lastEnd = c.end;
    }
  }
  return accepted;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect only — never mutates. Offsets are `[start, end)` code-unit ranges
 * into `normalizeForScreening(text)`, NOT the raw input, so a caller that
 * wants to redact by offset must redact against that same normalized string.
 */
export function detectPii(text: string): Finding[] {
  if (typeof text !== "string") return [];
  const normalized = normalizeForScreening(text);
  const accepted = resolveOverlaps(collectCandidates(normalized)).sort(
    (a, b) => a.start - b.start
  );
  return accepted.map((c) => ({
    category: "pii" as const,
    type: c.type,
    reason: c.reason,
    detector: "deterministic" as const,
    offsets: [[c.start, c.end]] as Array<[number, number]>,
  }));
}

/**
 * Detect and cleanse. Normalizes `text` first (see `normalizeForScreening`),
 * then replaces every accepted match with `[redacted:<type>]`. `findings`
 * offsets refer to the pre-redaction normalized text, matching `detectPii`.
 */
export function redactPii(text: string): { text: string; findings: Finding[] } {
  if (typeof text !== "string") return { text: "", findings: [] };
  const normalized = normalizeForScreening(text);
  const accepted = resolveOverlaps(collectCandidates(normalized)).sort(
    (a, b) => a.start - b.start
  );

  let out = "";
  let cursor = 0;
  for (const c of accepted) {
    out += normalized.slice(cursor, c.start);
    out += `[redacted:${c.type}]`;
    cursor = c.end;
  }
  out += normalized.slice(cursor);

  const findings: Finding[] = accepted.map((c) => ({
    category: "pii" as const,
    type: c.type,
    reason: c.reason,
    detector: "deterministic" as const,
    offsets: [[c.start, c.end]] as Array<[number, number]>,
  }));

  return { text: out, findings };
}
