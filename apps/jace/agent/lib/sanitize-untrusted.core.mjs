// Deterministic hardener for model-drafted strings that may carry
// researcher-derived (untrusted web) content, applied at Jace's side-effecting
// render seams (issue #1124).
//
// WHY HERE, AND ONLY HERE: the researcher's brief reaches Jace as a MODEL-READ
// tool result — Eve lowers a task-mode subagent's structured output straight
// into the parent's tool stream, and Eve hooks are observe-only, so there is no
// Jace-authored code seam between the child emitting the brief and the parent
// reading it. The parent then blends that brief into whatever it drafts. The
// first place Jace code touches the blended text again is the parent's OWN
// side-effecting tools (create_issue's write path, the channel send path).
// That is the enforceable chokepoint, and this module is its core. It mirrors
// Eve's own guidance: "Filter, minimize, and redact tool outputs before
// returning them" (tools/overview) and "strings rendered into a surface should
// be escaped for that surface" (security-model).
//
// SURGICAL, not scorched-earth. The rendered body is legitimate markdown that
// Jace authored (links, code spans, emphasis, headings) with untrusted text
// woven in — so we must remove only what is *never* legitimate:
//   - invisible / bidi / control / unicode-tag smuggling (hidden channels),
//   - dangerous, non-navigable URL schemes (javascript:, data:, ...),
//   - mass-ping tokens (@everyone / @here / @channel / @all),
//   - runaway length (context flooding),
// while leaving ordinary punctuation and markdown untouched.
//
// HONEST BOUNDARY: deterministic string hardening cannot neutralize a
// plausible-looking https phishing link, nor natural-language instruction
// injection ("ignore your instructions..."). Those residuals are addressed by
// the researcher's trust-posture instructions (treat fetched content as data,
// not commands), not by this code.
//
// Pure, dependency-free .mjs (no SDK, no I/O). The character classes target
// code points that are themselves invisible or are line terminators, so they
// CANNOT be written as literal characters in a regex/string literal. They are
// built here from numeric code-point ranges so the source stays pure ASCII and
// every targeted range is auditable by its hex value.

// Generous per-field ceilings for the create_issue write path. These are
// backstops against context flooding, not content limits — real fields sit far
// below them; anything larger is defensively truncated with an ellipsis.
export const FIELD_CAPS = Object.freeze({
  title: 300,
  parent: 300,
  requiredContext: 8000,
  whatToBuild: 8000,
  acceptanceCriterion: 1000,
  verification: 4000,
});

// Default cap when a caller does not pass one.
const DEFAULT_MAX_LEN = 8000;

// Horizontal ellipsis (U+2026) appended when capText truncates.
const ELLIPSIS = String.fromCodePoint(0x2026);

// Fullwidth commercial at (U+FF20): visually recognizable, inert as a mention.
const FULLWIDTH_AT = String.fromCodePoint(0xff20);

// Build a global+unicode character-class RegExp from [lo, hi] code-point ranges
// (inclusive). Emits pure-ASCII \u{...} escapes so no invisible byte ever lives
// in this source file.
function classFromRanges(ranges) {
  const body = ranges
    .map(([lo, hi]) => {
      const a = "\\u{" + lo.toString(16) + "}";
      if (lo === hi) return a;
      return a + "-\\u{" + hi.toString(16) + "}";
    })
    .join("");
  return new RegExp("[" + body + "]", "gu");
}

// Unicode LINE SEPARATOR (2028) / PARAGRAPH SEPARATOR (2029), normalized to LF.
const LINE_SEPARATORS = classFromRanges([[0x2028, 0x2029]]);

// Unicode whitespace collapsed to a plain ASCII space: TAB, NBSP, Ogham space,
// the en/em quad family, narrow/medium math spaces, ideographic space.
// (Ordinary U+0020 is already fine and is left untouched.)
const EXOTIC_SPACES = classFromRanges([
  [0x09, 0x09], // TAB
  [0xa0, 0xa0], // NBSP
  [0x1680, 0x1680], // Ogham space mark
  [0x2000, 0x200a], // en quad .. hair space
  [0x202f, 0x202f], // narrow no-break space
  [0x205f, 0x205f], // medium mathematical space
  [0x3000, 0x3000], // ideographic space
]);

// Invisible / format / control code points with no legitimate place in a
// drafted issue or message. Deleting these closes the classic smuggling
// channels. TAB (09), LF (0A) and CR (0D) are deliberately excluded — they are
// handled as whitespace/newlines above, not deleted.
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
  [0xfeff, 0xfeff], // ZWNBSP / BOM
  [0xfff9, 0xfffb], // interlinear annotation anchors
  [0xe0000, 0xe007f], // Unicode Tags block (invisible ASCII)
]);

// URL schemes that either execute or reference local/opaque data and are never
// something a drafted brief should navigate to. Matched only when followed by a
// non-space (i.e. an actual `scheme:target`, not the prose word "data:").
const DANGEROUS_SCHEMES = /\b(javascript|data|vbscript|file|blob):(?=\S)/gi;

// Mass-notification tokens, matched only when not preceded by a word-ish char
// (so ordinary @handles and email local-parts are preserved).
const MASS_MENTIONS = /(^|[^0-9A-Za-z_])@(everyone|here|channel|all)\b/gi;

/**
 * Remove hidden channels and normalize whitespace, preserving visible content.
 * @param {unknown} input
 * @returns {string}
 */
export function stripInvisibles(input) {
  if (typeof input !== "string") return "";
  return input
    // Normalize every newline flavor (CRLF, CR, LS, PS) to LF first.
    .replace(/\r\n?/g, "\n")
    .replace(LINE_SEPARATORS, "\n")
    // Collapse exotic whitespace to a plain space.
    .replace(EXOTIC_SPACES, " ")
    // Delete invisibles / controls / smuggling code points.
    .replace(INVISIBLES, "");
}

/**
 * Defang dangerous, non-navigable URL schemes by inserting a bracket so the
 * link is no longer clickable/parseable as that scheme, e.g.
 * `javascript:x` -> `javascript[:]x`. http/https/mailto are left intact.
 * @param {unknown} input
 * @returns {string}
 */
export function defangDangerousSchemes(input) {
  if (typeof input !== "string") return "";
  return input.replace(DANGEROUS_SCHEMES, "$1[:]");
}

/**
 * Defang mass-ping tokens by swapping the leading `@` for a fullwidth `＠`
 * (U+FF20) — visually recognizable, but inert on every chat surface. Ordinary
 * @handles and email local-parts are preserved.
 * @param {unknown} input
 * @returns {string}
 */
export function defangMassMentions(input) {
  if (typeof input !== "string") return "";
  return input.replace(MASS_MENTIONS, "$1" + FULLWIDTH_AT + "$2");
}

/**
 * Truncate to a maximum number of Unicode code points (not UTF-16 units), so a
 * surrogate pair is never split, appending an ellipsis when it cuts.
 * @param {unknown} input
 * @param {number} maxCodePoints
 * @returns {string}
 */
export function capText(input, maxCodePoints) {
  if (typeof input !== "string") return "";
  const cps = Array.from(input);
  if (cps.length <= maxCodePoints) return input;
  return cps.slice(0, maxCodePoints).join("") + ELLIPSIS;
}

// Collapse 3+ consecutive newlines to a blank-line separator and trim ends.
function collapseBlankLines(s) {
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The single entry point wired into render seams. Applies, in order:
 * NFC normalize -> strip invisibles/controls -> defang dangerous schemes ->
 * defang mass mentions -> collapse blank lines/trim -> cap length. Non-string
 * input yields "".
 * @param {unknown} input
 * @param {{ maxLen?: number }} [opts]
 * @returns {string}
 */
export function hardenUntrusted(input, opts = {}) {
  if (typeof input !== "string") return "";
  const maxLen = opts.maxLen ?? DEFAULT_MAX_LEN;
  let s = input.normalize("NFC");
  s = stripInvisibles(s);
  s = defangDangerousSchemes(s);
  s = defangMassMentions(s);
  s = collapseBlankLines(s);
  s = capText(s, maxLen);
  return s;
}
