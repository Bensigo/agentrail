// Pure, dependency-free core for posting an advisory PR review via the
// console (apps/console/app/api/v1/runner/pr-review, POST). No SDK, no network
// primitives of its own: the single HTTP call is an injected `transport` seam
// (real fetch with a timeout in the thin tool wrapper, a fake in tests), so
// every branch — success and every degraded outcome — is unit-testable without
// a live server.
//
// UNGATED, deliberately (was Jace's sixth console-gated write). Handing Jace a
// PR to review IS the instruction to comment on it — a second "may I post
// this?" round-trip bought nothing and, in practice, cost everything: the
// approval prompt is delivered on Telegram only
// (apps/console/app/api/v1/runner/approvals/route.ts's sendApprovalMessage),
// so on every other channel the request was recorded, never shown, and the
// tool sat polling until its 30-minute TTL expired. Observed in prod
// 2026-07-28: two `post_pr_review` approvals on a `discord` session, both
// still `pending`, review never posted, owner never prompted.
//
// What replaces the gate (BOTH still hold — the gate was never the thing
// keeping this safe):
//   1. ADVISORY BY CONSTRUCTION — the console hardcodes the GitHub review
//      `event` to "COMMENT" server-side, so nothing here can approve or
//      request changes on a PR.
//   2. SERVER-SCOPED TARGET — the console resolves the workspace from
//      `eveSessionId` through the jace_sessions ledger and requires `repo` to
//      be one the workspace has actually connected, so a model-chosen repo
//      cannot reach a repo this conversation doesn't already own.
// Plus the severity filter below, which is new: with no human reading the
// exact call, "only blockers and majors get posted" has to be ENFORCED here,
// not asked for in a prompt.
//
// Auth + config model: same as the sibling *.core.mjs modules — Jace resolves
// its own console endpoint + bearer from JACE_CONSOLE_BASE_URL /
// JACE_CONSOLE_TOKEN, never the runner's ~/.agentrail/credentials.json.
//
// `eveSessionId` is resolved by the tool wrapper from `ctx.session.id`. This
// is a ROOT tool (unlike the reviewer subagent's fetch_pr_diff), so
// `ctx.session.id` already IS the top-level session the jace_sessions ledger
// anchors — no `session.parent` indirection needed here, unlike
// fetch_pr_diff.core.mjs, which runs inside a declared subagent's own child
// session (see that module's doc-comment).
//
// `repo` / `prNumber` / `summary` / `comments` / `acCoverage` / `judgment`
// are model-supplied — the reviewer subagent's findings, per-AC coverage
// judgments, and structured judgment, relayed by root verbatim. Safe without
// a human in the loop for the two structural reasons in this file's header
// (advisory-only event, server-scoped repo), plus hardenUntrusted() below.
//
// hardenUntrusted() runs over `summary` and every comment `body` before they
// ever leave this module: the reviewer's findings — and its acCoverage and
// judgment judgments, both criterion/note text and evidence/basis — are
// shaped by reading UNTRUSTED diff content (root wiring's own rule — a
// hostile PR could try to seed a prompt-injection payload that rides all the
// way to a POSTED GITHUB COMMENT a human later reads), so this mirrors
// create_issue's own defense-in-depth backstop rather than trusting
// instructions.md alone. This matters MORE now than it did behind the gate —
// it is the only thing between a hostile diff and posted text, with no human
// reading the draft first. `acCoverage` and `judgment` are both rendered
// into `summary` (composeSummary, in runPostPrReview below) BEFORE that
// hardening runs, precisely so neither's text ever skips the sanitizer.
//
// Failure posture: every non-2xx status is mapped to a stable `reason` + a
// relayable `message` — the console's OWN honest error text when the body
// carries one (same reasoning as create_repo.core.mjs: a human already
// approved this specific call, so there is no anti-enumeration reason to
// hide which refusal happened), falling back to a generic per-reason message
// otherwise. Never throws, never retries (the console owns the GitHub-side
// 422-fold-and-retry internally).

import { hardenUntrusted } from "./sanitize-untrusted.core.mjs";

export const PR_REVIEW_PATH = "/api/v1/runner/pr-review";
export const PR_CHANGE_RECORD_PATH = "/api/v1/runner/change-record/pr";
export const REVIEW_JOB_POST_PATH_PREFIX = "/api/v1/runner/review-jobs";

// Backstops against context flooding, not content limits — mirrors
// sanitize-untrusted.core.mjs's FIELD_CAPS idiom for create_issue's fields.
export const SUMMARY_MAX_LEN = 8000;
export const COMMENT_BODY_MAX_LEN = 2000;

// The ONLY severities that become posted inline comments. The reviewer's own
// vocabulary is blocker | major | minor | nit (REVIEW_SEVERITIES in
// agent/subagents/reviewer/lib/reviewer.core.mjs) — a PR review that
// auto-posts should carry the things worth interrupting someone for and stay
// quiet about the rest, so minor and nit are dropped here rather than left to
// the model's discretion.
export const POSTABLE_SEVERITIES = ["blocker", "major"];

// Deterministic renderers for the reviewer's acCoverage — one line per AC,
// the status phrases fixed here (never model-supplied) so the posted text
// can't drift from the diff-honest vocabulary the reviewer's contract pins.
const AC_STATUS_RENDER = {
  addressed: (c) => `- ✅ ${c.criterion}${c.evidence ? ` — ${c.evidence}` : ""}`,
  not_in_diff: (c) => `- ❌ ${c.criterion} — not visibly addressed in this diff`,
  unclear: (c) => `- ❓ ${c.criterion} — can't tell from the diff`,
};

// Cap on evidence links rendered per AC entry (B2a §3). Mirrors the QA
// contract's own MAX_EVIDENCE_IMAGES (agent/subagents/qa/lib/qa.core.mjs),
// but is re-declared here rather than imported — this module stays
// dependency-free of the others by design (see the file header). Only the
// first MAX_RENDERED_EVIDENCE_LINKS raw entries are even considered, so a
// caller that ignores its own cap cannot force unbounded work here either.
const MAX_RENDERED_EVIDENCE_LINKS = 4;

// Extra invisible/control/bidi code points sanitizeEvidenceUrl strips,
// beyond the plain C0/DEL range it already handles inline (see that
// function). Mirrors — rather than imports; this module stays
// dependency-free of the others, see the file header — hardenUntrusted's
// own INVISIBLES class in sanitize-untrusted.core.mjs, minus that class's
// C0/DEL ranges (0x00-0x08/0x0b-0x0c/0x0e-0x1f/0x7f-0x9f's DEL half), which
// sanitizeEvidenceUrl's own first pass already covers more broadly (it also
// strips \t/\n/\r, which hardenUntrusted deliberately preserves — no such
// exception belongs on a URL). So the URL sanitizer is never NARROWER than
// the prose one: none of these — soft hyphen, combining grapheme joiner,
// the Arabic letter mark, zero-width space/joiners, bidi embeddings/
// overrides (Trojan Source), the word-joiner block, variation selectors,
// ZWNBSP/BOM, interlinear annotation anchors, or the Unicode Tags block —
// has any more legitimate place in a URL than in a chat message.
//
// Expressed as plain numeric ranges + a linear scan, not a regex: several
// of these ranges are themselves astral (0xE0000+) or line-breaking
// (U+2028/2029 territory is adjacent to some of these blocks), so building
// this as a regex literal risks the exact raw-byte-in-source-file mistake
// LINE_BREAK_CHARS above was written to avoid. A codePointAt/linear-scan
// check has no such failure mode and needs no `u` flag or escape-sequence
// authoring at all.
const EXTRA_INVISIBLE_RANGES = [
  [0x80, 0x9f], // C1 controls
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
];

function isExtraInvisible(codePoint) {
  for (const [lo, hi] of EXTRA_INVISIBLE_RANGES) {
    if (codePoint >= lo && codePoint <= hi) return true;
  }
  return false;
}

/**
 * Sanitize one `evidence_images` URL before it is embedded in a markdown
 * link destination, `[text](HERE)`. Never throws; anything that doesn't
 * come out as a plausible http(s) URL is dropped ("" — the caller skips it)
 * rather than rendered.
 *
 * Two structural defenses, both required — the same class of attack this
 * module's own composeSummary security fix already documents for `summary`
 * (see that function's header comment on the `coverageRendered` gate),
 * arriving through a new field:
 *
 *   1. Every control character is stripped, deliberately INCLUDING \n and
 *      \r (0x0A / 0x0D) — unlike hardenUntrusted's stripInvisibles(), which
 *      explicitly PRESERVES those two ("handled as whitespace/newlines
 *      above, not deleted": correct for a chat-rendered prose body, wrong
 *      for a single-line URL token, which is why this function does not
 *      reuse that one). A raw newline here would split what composeSummary
 *      treats as ONE rendered AC line into two — and if the injected second
 *      "line" were crafted to start with "AC coverage: ", it would be
 *      indistinguishable, by composeSummary's own text-prefix check, from
 *      the genuine, code-generated count line that
 *      composeSummaryWithCoverage's hard guarantee protects from
 *      truncation. With no newline able to reach the rendered block, no new
 *      line can ever be forged by this field — closed off structurally,
 *      not merely by the gate's own correctness. The same pass also drops
 *      every EXTRA_INVISIBLE_RANGES code point (C1 controls, bidi
 *      overrides, zero-width smuggling, ...) for parity with
 *      hardenUntrusted's own INVISIBLES sweep — see that constant's comment.
 *   2. The scheme is restricted to http(s) (dropping anything else, e.g. a
 *      `javascript:` URL), and characters that could break out of — or open
 *      a second — `(...)` destination on the SAME line (parens, backslash,
 *      angle brackets, residual whitespace) are percent-encoded rather than
 *      passed through raw.
 * @param {unknown} url
 * @returns {string}
 */
function sanitizeEvidenceUrl(url) {
  if (typeof url !== "string") return "";
  let safe = "";
  for (const ch of url) {
    const code = ch.codePointAt(0);
    // strips \n \r \t + every other C0/DEL control byte, plus the wider
    // invisible/bidi sweep above.
    if (code < 0x20 || code === 0x7f || isExtraInvisible(code)) continue;
    safe += ch;
  }
  safe = safe.trim();
  if (!/^https?:\/\//i.test(safe)) return "";
  // Two different encoders for two different reasons:
  //   - `(` `)` `<` `>` `\` are always single-byte ASCII, so a hand-rolled
  //     two-hex-digit escape is exact — deliberately NOT encodeURIComponent
  //     for these, since it leaves `(` `)` `!` `*` `'` raw (JS's legacy
  //     RFC-2396 "unreserved" set), which is exactly wrong here: an
  //     unescaped `)` is what closes a markdown link destination early.
  //   - whitespace (`\s`) is different: it can be a MULTI-BYTE code point
  //     (U+2028, U+3000, ...), where the same single-%XX scheme would emit
  //     a malformed, non-two-hex-digit escape (e.g. "%2028" for U+2028 —
  //     not a valid percent-triplet at all). encodeURIComponent has no
  //     unreserved exception for whitespace, so it's used here instead and
  //     produces the correct multi-%XX UTF-8 byte sequence for any code
  //     point, astral or not.
  return safe.replace(/[()<>\\]|\s/g, (c) =>
    /\s/.test(c)
      ? encodeURIComponent(c)
      : `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/**
 * Render an AC entry's `evidence_images` as trailing markdown links, e.g.
 * " — [evidence 1](url) [evidence 2](url)". Deliberately plain links, never
 * `![]()` image embeds: these are short-lived signed GETs (B2a's
 * signedGetUrl; apps/console/lib/artifacts/store.ts clamps the interface's
 * literal 30-day default to SigV4's own hard 7-day ceiling for static
 * credentials — MAX_SIGV4_PRESIGN_TTL_SECONDS, that module's own doc-comment
 * has the full story), and a broken inline image reads as more damning than
 * a broken link once one expires — GitHub still shows the link text and a
 * human can tell at a glance it merely went stale, where a dead `<img>`
 * renders as a conspicuous broken-image icon.
 *
 * Only the first MAX_RENDERED_EVIDENCE_LINKS raw entries are even
 * considered; non-string entries and anything sanitizeEvidenceUrl rejects
 * are skipped rather than rendered as broken markdown, and the surviving
 * links are numbered in render order (never the original array index, so a
 * skipped entry never leaves a gap like "evidence 1 ... evidence 3"). Absent,
 * non-array, empty, or all-rejected input renders "" — the caller's line is
 * then byte-identical to a call that never knew about evidence_images.
 * @param {unknown} evidenceImages
 * @returns {string}
 */
function renderEvidenceLinks(evidenceImages) {
  if (!Array.isArray(evidenceImages) || evidenceImages.length === 0) return "";
  const links = [];
  for (const raw of evidenceImages.slice(0, MAX_RENDERED_EVIDENCE_LINKS)) {
    const safeUrl = sanitizeEvidenceUrl(raw);
    if (!safeUrl) continue;
    links.push(`[evidence ${links.length + 1}](${safeUrl})`);
  }
  return links.length ? ` — ${links.join(" ")}` : "";
}

// Backing character class for stripLineBreaks (below), built from numeric
// char codes rather than literal source characters: U+2028/U+2029 are
// themselves ECMAScript line terminators, so embedding them as raw bytes in
// this file's own source would be, at best, invisible and unreviewable by
// eye, and at worst a syntax error inside a regex literal (a raw,
// unescaped line terminator cannot appear inside one).
const LINE_BREAK_CHARS = new RegExp(
  "[\\x00-\\x1f\\x7f" + String.fromCharCode(0x2028) + String.fromCharCode(0x2029) + "]",
  "g",
);

/**
 * Collapse every line-breaking or control character in `s` to a single
 * ASCII space — never deletion, since "AC\ncoverage" must not become
 * "ACcoverage" and silently re-read as one glued word. Targets: C0 controls
 * (0x00-0x1F, which already covers \n/\r/\t) + DEL (0x7F) + the Unicode
 * LINE SEPARATOR / PARAGRAPH SEPARATOR (U+2028/U+2029) — the latter two are
 * NOT matched by `String.prototype.split("\n")`, but some renderers still
 * treat them as line breaks, so they're closed off here too rather than
 * relying on that one detail of one downstream consumer.
 *
 * Applied to `criterion` and `evidence` (see renderAcCoverage) — both
 * reviewer/QA-sourced, untrusted, diff-derived text per this module's own
 * header — before they are interpolated into AC_STATUS_RENDER's template
 * strings. Without this, an internal newline in either field could
 * impersonate a standalone forged line inside the rendered coverage block
 * (e.g. "AC coverage: 99/99 addressed..." or "**Judgment:** ...") directly
 * in the posted GitHub comment, on the EVERYDAY unfolded rendering path —
 * no pathological length engineering required, unlike the double-
 * pathological branch sanitizeEvidenceUrl's own newline-stripping guards
 * against for evidence_images. A self-stated AC (`issueNumber: null`,
 * sourced from the PR description rather than a linked issue) makes
 * `criterion` attacker-authored directly.
 * @param {string} s
 * @returns {string}
 */
function stripLineBreaks(s) {
  return s.replace(LINE_BREAK_CHARS, " ");
}

/**
 * Render the coverage checklist: issue-numbered groups ascending, then the
 * PR-description group (issueNumber: null) last, labeled as self-stated.
 * Malformed entries are skipped, never guessed at. Returns "" when there is
 * nothing renderable.
 *
 * `criterion` and `evidence` are run through stripLineBreaks (see its own
 * doc comment) before interpolation — this closes the count-line/judgment-
 * line forgery class off for these two untrusted fields, the same one
 * sanitizeEvidenceUrl closes for evidence_images below.
 *
 * When an entry carries a non-empty `evidence_images` array (QA's per-AC
 * screenshots, B2a §2 — folded into this same coverage by root before
 * calling post_pr_review; see instructions.md's "Relay acCoverage verbatim
 * too" rule), its rendered line gains trailing evidence links (see
 * renderEvidenceLinks). An entry with no `evidence_images` — absent, null,
 * or an empty array — renders byte-identically to before that field existed.
 * @param {unknown} acCoverage
 * @returns {string}
 */
export function renderAcCoverage(acCoverage) {
  if (!Array.isArray(acCoverage) || acCoverage.length === 0) return "";
  const groups = new Map();
  for (const entry of acCoverage) {
    if (!entry || typeof entry !== "object") continue;
    const render = AC_STATUS_RENDER[entry.status];
    if (!render) continue;
    if (typeof entry.criterion !== "string" || entry.criterion.trim().length === 0) continue;
    const key = typeof entry.issueNumber === "number" ? entry.issueNumber : null;
    if (!groups.has(key)) groups.set(key, []);
    const line = render({
      criterion: stripLineBreaks(entry.criterion.trim()),
      evidence: typeof entry.evidence === "string" ? stripLineBreaks(entry.evidence.trim()) : "",
    });
    groups.get(key).push(line + renderEvidenceLinks(entry.evidence_images));
  }
  if (groups.size === 0) return "";
  const issueNumbers = [...groups.keys()].filter((k) => k !== null).sort((a, b) => a - b);
  const parts = [];
  for (const n of issueNumbers) {
    parts.push(`**Acceptance criteria — issue #${n}:**\n${groups.get(n).join("\n")}`);
  }
  if (groups.has(null)) {
    parts.push(`**Acceptance criteria — from the PR description:**\n${groups.get(null).join("\n")}`);
  }
  return parts.join("\n\n");
}

/**
 * Count renderable entries per status — the fold line's numbers.
 * @param {unknown} acCoverage
 */
export function coverageCounts(acCoverage) {
  const counts = { total: 0, addressed: 0, not_in_diff: 0, unclear: 0 };
  if (!Array.isArray(acCoverage)) return counts;
  for (const entry of acCoverage) {
    if (!entry || typeof entry !== "object" || !AC_STATUS_RENDER[entry.status]) continue;
    if (typeof entry.criterion !== "string" || entry.criterion.trim().length === 0) continue;
    counts.total += 1;
    counts[entry.status] += 1;
  }
  return counts;
}

/**
 * Append the coverage block under the summary. If the composed text would
 * exceed SUMMARY_MAX_LEN (so hardenUntrusted would truncate mid-checklist),
 * fold the WHOLE block to a one-line count instead — a cut-off checklist
 * reads as a complete one, which is worse than a fold that says where the
 * detail lives.
 *
 * The count line itself is a HARD GUARANTEE, never best-effort: it is the
 * one signpost telling the reader the detail lives in chat, so a truncated
 * count line (e.g. "...1 not in d…") would be exactly the kind of corrupted,
 * confusing cut this fold exists to avoid — just relocated. If even
 * `base + countLine` would still blow SUMMARY_MAX_LEN (a pathological base
 * already sitting near the cap), the BASE cedes its own tail instead —
 * truncated with a trailing "…" so the count line always rides out whole
 * and the total never exceeds SUMMARY_MAX_LEN.
 * @param {string} summary
 * @param {unknown} acCoverage
 * @returns {string}
 */
export function composeSummaryWithCoverage(summary, acCoverage) {
  const base = String(summary ?? "");
  const block = renderAcCoverage(acCoverage);
  if (!block) return base;
  const composed = base.trim().length > 0 ? `${base}\n\n${block}` : block;
  if (composed.length <= SUMMARY_MAX_LEN) return composed;

  const c = coverageCounts(acCoverage);
  const countLine = `AC coverage: ${c.addressed}/${c.total} addressed, ${c.not_in_diff} not in diff, ${c.unclear} unclear — details in chat.`;
  const sep = base.trim().length > 0 ? "\n\n" : "";
  const fallback = `${base}${sep}${countLine}`;
  if (fallback.length <= SUMMARY_MAX_LEN) return fallback;

  // Pathological case: base alone already sits near SUMMARY_MAX_LEN, so even
  // the folded fallback blows the cap. Cede the BASE's tail, never the count
  // line's — the count line is the only reason this fold is legible at all.
  const budget = Math.max(0, SUMMARY_MAX_LEN - countLine.length - sep.length - 1);
  return `${base.slice(0, budget)}…${sep}${countLine}`;
}

// Task 6's judgment shape ({verdict, note, basis} × simplest/architecture/
// debt/hiddenRisks — see reviewer.core.mjs's JUDGMENT_FIELDS/JUDGMENT_VERDICTS/
// GROUNDED_VERDICTS), relayed by root verbatim and rendered here into one
// compact line. Deliberately not exported: these are rendering vocabulary
// private to this module, not part of its contract (only renderJudgmentLine
// and composeSummary are).
const JUDGMENT_LABELS = {
  simplest: "simplest", architecture: "architecture",
  debt: "debt", hiddenRisks: "hidden risks",
};
const JUDGMENT_VERDICT_TEXT = {
  yes: "yes", no: "no", cannot_judge: "can't judge",
  consistent: "consistent", violates: "violates",
  no_decision_found: "no decision found",
  none_found: "none found", introduces: "introduces", found: "found",
};
const NEGATIVE_JUDGMENT_VERDICTS = new Set(["no", "violates", "introduces", "found"]);
const JUDGMENT_NOTE_MAX = 200;

/**
 * One compact line; negative verdicts carry their note (capped) and basis
 * ids. `note` is run through stripLineBreaks (see its own doc comment)
 * before capping/interpolation, same as renderAcCoverage's criterion/
 * evidence: `note` is the reviewer's own free-text justification over
 * UNTRUSTED, diff-derived content (this module's own header), so an
 * internal newline could otherwise impersonate a standalone forged line
 * (e.g. "AC coverage: ..." or a second "**Judgment:**") in the posted
 * comment — the SAME forgery class, arriving through a third field.
 * `basis` is also run through it, defense-in-depth: the reviewer's own
 * validator constrains basis entries to `^i\d+$` before they ever reach
 * here, but that validation lives in a different module entirely
 * (reviewer.core.mjs) that this one has no way to verify actually ran —
 * belt-and-suspenders so a future change to that validator can't silently
 * reopen this.
 */
export function renderJudgmentLine(judgment) {
  if (judgment === null || typeof judgment !== "object" || Array.isArray(judgment)) return "";
  const parts = [];
  for (const field of ["simplest", "architecture", "debt", "hiddenRisks"]) {
    const j = judgment[field];
    if (!j || typeof j !== "object") continue;
    const verdict = JUDGMENT_VERDICT_TEXT[j.verdict];
    if (!verdict) continue;
    let part = `${JUDGMENT_LABELS[field]}: ${verdict}`;
    if (NEGATIVE_JUDGMENT_VERDICTS.has(j.verdict) && typeof j.note === "string" && j.note.trim()) {
      const note = stripLineBreaks(j.note.trim());
      const capped = note.length > JUDGMENT_NOTE_MAX ? `${note.slice(0, JUDGMENT_NOTE_MAX)}…` : note;
      const basis =
        Array.isArray(j.basis) && j.basis.length ? ` (${stripLineBreaks(j.basis.join(", "))})` : "";
      part += ` — ${capped}${basis}`;
    }
    parts.push(part);
  }
  return parts.length ? `**Judgment:** ${parts.join(" · ")}` : "";
}

/**
 * Full composition with a deterministic fold cascade under SUMMARY_MAX_LEN:
 *   1. summary + coverage block + judgment line
 *   2. coverage folds to its count line (existing composeSummaryWithCoverage math)
 *   3. judgment folds to "**Judgment:** 4 verdicts — details in chat."
 *   4. base cedes its tail (…) — the two folded lines survive whole.
 *
 * Step 4's trim targets the BASE only, never the two guaranteed lines. But
 * when composeSummaryWithCoverage itself already folded (step 2), "the base"
 * inside `withCoverage` is followed by the coverage count line, not raw
 * summary text — a blind slice of `withCoverage` could cut into that count
 * line's tail, exactly the corruption composeSummaryWithCoverage exists to
 * prevent, just reintroduced one layer up. So step 4 first checks whether
 * `withCoverage` ends with the count line (its last line starts with
 * "AC coverage: "); if so, it splits the count line off, trims only the
 * portion ahead of it, and reassembles base… + countLine + sep + shortLine.
 * This is the pathological-of-pathological case: both guaranteed lines (the
 * coverage count line and the short judgment line) must ride out whole.
 *
 * That count-line detection is TEXT-based (a literal prefix check), so it
 * must be gated on a STRUCTURAL fact — a coverage block was actually
 * rendered from real `acCoverage` input — never on the text prefix alone.
 * `summary` is model-drafted, attacker-steerable text: without the gate, a
 * summary whose own last line happens to start with "AC coverage: " would
 * be treated as the guaranteed count line and exempted from trimming, which
 * both breaks the SUMMARY_MAX_LEN guarantee (the spoofed "count line" has no
 * actual length bound) and lets the attacker silently evict the real
 * guaranteed line (the short judgment fallback) off the end into
 * hardenUntrusted's truncation. `coverageRendered` closes this off:
 *   - rendered + folded    -> withCoverage's last line IS the genuine count
 *     line (composeSummaryWithCoverage's own hard guarantee) — protect it.
 *   - rendered + unfolded  -> the block's own last entry is last, and every
 *     AC_STATUS_RENDER line starts with "- ✅ "/"- ❌ "/"- ❓ ", never
 *     "AC coverage: " — the prefix check is simply false here regardless.
 *   - nothing rendered     -> NOTHING in `withCoverage` is a guaranteed
 *     line; attacker-influenced summary text must never be granted
 *     count-line protection, so the gate short-circuits before the prefix
 *     check is even consulted, and the plain base-cedes-its-tail path below
 *     runs instead (protecting only the short judgment line, generically).
 */
export function composeSummary(summary, acCoverage, judgment) {
  const withCoverage = composeSummaryWithCoverage(summary, acCoverage);
  const coverageRendered = renderAcCoverage(acCoverage) !== "";
  const line = renderJudgmentLine(judgment);
  if (!line) return withCoverage;
  const sep = withCoverage.trim().length > 0 ? "\n\n" : "";
  const full = `${withCoverage}${sep}${line}`;
  if (full.length <= SUMMARY_MAX_LEN) return full;
  const shortLine = "**Judgment:** 4 verdicts — details in chat.";
  const shortFull = `${withCoverage}${sep}${shortLine}`;
  if (shortFull.length <= SUMMARY_MAX_LEN) return shortFull;

  // Double-pathological: even the folded judgment line doesn't fit alongside
  // withCoverage. If withCoverage already folded down to the coverage count
  // line (composeSummaryWithCoverage's own hard guarantee) — never merely
  // because the text looks like it did — that line is the LAST line of
  // withCoverage and must not be touched; only the base ahead of it may
  // cede its tail.
  const lines = withCoverage.split("\n");
  const lastLine = lines[lines.length - 1];
  if (coverageRendered && lastLine.startsWith("AC coverage: ")) {
    const countLine = lastLine;
    const head = withCoverage.slice(0, withCoverage.length - countLine.length);
    const innerSep = head.endsWith("\n\n") ? "\n\n" : "";
    const base = innerSep ? head.slice(0, -innerSep.length) : head;
    const budget = Math.max(
      0,
      SUMMARY_MAX_LEN - countLine.length - innerSep.length - sep.length - shortLine.length - 1,
    );
    return `${base.slice(0, budget)}…${innerSep}${countLine}${sep}${shortLine}`;
  }

  // No coverage block was actually rendered (or the check above didn't
  // match) — the short judgment line is the only guaranteed line left to
  // protect. Cede the base's tail generically: this keeps the total ≤
  // SUMMARY_MAX_LEN even for an unbounded or attacker-crafted summary,
  // because nothing here is exempted from the slice.
  const budget = Math.max(0, SUMMARY_MAX_LEN - shortLine.length - sep.length - 1);
  return `${withCoverage.slice(0, budget)}…${sep}${shortLine}`;
}

const REASON_MESSAGES = {
  config_missing: "the review couldn't be posted — Jace's console connection isn't configured",
  nothing_to_post:
    "nothing was posted — there were no blocker or major findings, and no summary to post on its own",
  bad_request: "the review couldn't be posted — the request was malformed",
  unauthorized: "the review couldn't be posted — the console rejected the request",
  not_found: "the review couldn't be posted — this PR or repo isn't reachable from this workspace",
  conflict: "the review couldn't be posted — the workspace or repo isn't fully connected yet",
  unprocessable: "the review couldn't be posted — GitHub rejected it as unprocessable",
  rate_limited: "the review couldn't be posted — GitHub's rate limit was hit, try again shortly",
  upstream_error: "the review couldn't be posted — GitHub or the console had an error",
  unreachable: "the review couldn't be posted — the console could not be reached",
  unexpected_status: "the review couldn't be posted — the console returned an unexpected response",
  bad_body: "the review couldn't be posted — the console's response could not be read",
};

/**
 * Resolve the console endpoint + bearer from the environment. Trims both,
 * strips a trailing slash from the base URL, and reports which var(s) are
 * missing. Deliberately duplicated verbatim from the sibling *.core.mjs
 * modules rather than shared: each core module here is pure and
 * dependency-free of the others by design.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ ok: true, baseUrl: string, token: string } | { ok: false, missing: string[] }}
 */
export function resolveConsoleConfig(env = {}) {
  const baseUrl = String(env.JACE_CONSOLE_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env.JACE_CONSOLE_TOKEN ?? "").trim();
  const missing = [];
  if (!baseUrl) missing.push("JACE_CONSOLE_BASE_URL");
  if (!token) missing.push("JACE_CONSOLE_TOKEN");
  if (missing.length) return { ok: false, missing };
  return { ok: true, baseUrl, token };
}

/**
 * Build the POST .../pr-review URL. Every field rides in the body, never
 * here — there is nothing to encode into the URL itself.
 * @param {string} baseUrl — already trimmed + de-slashed
 * @returns {string}
 */
export function buildPrReviewUrl(baseUrl) {
  return `${baseUrl}${PR_REVIEW_PATH}`;
}

export function buildReviewJobPostUrl(baseUrl, jobId) {
  return `${baseUrl}${REVIEW_JOB_POST_PATH_PREFIX}/${encodeURIComponent(jobId)}/post-review`;
}

export function buildPrChangeRecordUrl(baseUrl) {
  return `${baseUrl}${PR_CHANGE_RECORD_PATH}`;
}

function isRenderableStageEvidence(item) {
  return (
    item &&
    typeof item === "object" &&
    typeof item.stage === "string" &&
    item.stage.trim().length > 0 &&
    typeof item.label === "string" &&
    item.label.trim().length > 0
  );
}

function sanitizeChangeRecordUrl(url) {
  if (typeof url !== "string") return "";
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? sanitizeEvidenceUrl(trimmed) : "";
}

export function renderChangeRecordBlock(changeRecord) {
  if (!changeRecord || typeof changeRecord !== "object") return "";
  if (changeRecord.found !== true) return "";
  const record = changeRecord.record;
  if (!record || typeof record !== "object" || typeof record.id !== "string") return "";
  const workspaceId = typeof record.workspaceId === "string" ? record.workspaceId.trim() : "";
  const id = record.id.trim();
  if (!workspaceId || !id) return "";

  const baseUrl = sanitizeChangeRecordUrl(changeRecord.consoleBaseUrl);
  const path = `/dashboard/${encodeURIComponent(workspaceId)}/changes/${encodeURIComponent(id)}`;
  const link = baseUrl ? `${baseUrl}${path}` : path;
  const lines = ["**Change Record**", `- Record: [${id}](${link})`];
  const evidence = Array.isArray(changeRecord.stageEvidence)
    ? changeRecord.stageEvidence.filter(isRenderableStageEvidence).slice(0, 6)
    : [];
  if (evidence.length > 0) {
    for (const item of evidence) {
      const stage = stripLineBreaks(item.stage.trim());
      const label = stripLineBreaks(item.label.trim());
      const url = sanitizeChangeRecordUrl(item.url);
      lines.push(url ? `- ${stage}: [${label}](${url})` : `- ${stage}: ${label}`);
    }
  } else {
    lines.push("- Lifecycle evidence: not attached yet");
  }
  return lines.join("\n");
}

export function composeSummaryWithChangeRecord(summary, changeRecord) {
  const base = String(summary ?? "");
  const block = renderChangeRecordBlock(changeRecord);
  if (!block) return base;
  const sep = base.trim().length > 0 ? "\n\n" : "";
  const full = `${base}${sep}${block}`;
  if (full.length <= SUMMARY_MAX_LEN) return full;
  const budget = Math.max(0, SUMMARY_MAX_LEN - sep.length - block.length - 1);
  return `${base.slice(0, budget)}…${sep}${block}`;
}

async function fetchPrChangeRecord({ cfg, sessionId, repo, prNumber, transport }) {
  let res;
  try {
    res = await transport(buildPrChangeRecordUrl(cfg.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ eveSessionId: sessionId, repo, prNumber, ensure: true }),
    });
  } catch {
    return null;
  }
  const status = Number(res && res.status);
  if (!Number.isFinite(status) || status < 200 || status >= 300) return null;
  try {
    const body = await res.json();
    if (!body || typeof body !== "object" || body.found !== true) return null;
    return { ...body, consoleBaseUrl: cfg.baseUrl };
  } catch {
    return null;
  }
}

/**
 * Map an HTTP status to an outcome. 2xx -> ok; everything else -> a specific
 * degraded reason. No status triggers a retry from here — the console
 * already owns the one GitHub-side 422-fold-and-retry.
 * @param {number} status
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function classifyStatus(status) {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 400) return { ok: false, reason: "bad_request" };
  if (status === 401 || status === 403) return { ok: false, reason: "unauthorized" };
  if (status === 404) return { ok: false, reason: "not_found" };
  if (status === 409) return { ok: false, reason: "conflict" };
  if (status === 422) return { ok: false, reason: "unprocessable" };
  if (status === 429) return { ok: false, reason: "rate_limited" };
  if (status >= 500) return { ok: false, reason: "upstream_error" };
  return { ok: false, reason: "unexpected_status" };
}

/**
 * Build a structured failure result. Carries a stable `reason` + a
 * relayable `message` — never a raw error, a status code, or a bearer
 * token.
 * @param {string} reason
 * @param {string} [message]
 * @returns {{ ok: false, reason: string, message: string }}
 */
export function failure(reason, message) {
  return {
    ok: false,
    reason,
    message: message || REASON_MESSAGES[reason] || REASON_MESSAGES.unexpected_status,
  };
}

/**
 * Split model-supplied comments into the ones that may be posted (severity
 * blocker or major) and a count of the ones dropped. This is the control that
 * replaced the human approval gate, so it fails CLOSED: a comment whose
 * severity is missing, null, or not one of the reviewer's four known values is
 * DROPPED, never posted. An unlabelled comment is one we cannot prove belongs
 * on someone's PR, and the cost of dropping it (a finding the owner still sees
 * in chat) is far below the cost of posting it (public noise on a PR nobody
 * approved).
 *
 * Tolerant on shape, strict on meaning: severity is trimmed and lowercased
 * before matching, so "  BLOCKER " counts, but "critical" does not.
 *
 * @param {unknown} comments
 * @returns {{ postable: Array<{path?: unknown, line?: unknown, body?: unknown}>, dropped: number }}
 */
export function filterPostableComments(comments) {
  const list = Array.isArray(comments) ? comments : [];
  const postable = [];
  let dropped = 0;
  for (const c of list) {
    const severity = String((c && c.severity) ?? "")
      .trim()
      .toLowerCase();
    if (POSTABLE_SEVERITIES.includes(severity)) {
      postable.push(c);
    } else {
      dropped += 1;
    }
  }
  return { postable, dropped };
}

/**
 * Sanitize the model-supplied summary + comments through hardenUntrusted()
 * before they ever leave this module — the same backstop create_issue's
 * write path applies, since the reviewer's findings are shaped by untrusted
 * diff content.
 * @param {string} summary
 * @param {Array<{path?: unknown, line?: unknown, body?: unknown}>} comments
 * @returns {{ summary: string, comments: Array<{path: string, line: number, body: string}> }}
 */
export function sanitizeReviewInput(summary, comments) {
  const safeSummary = hardenUntrusted(summary ?? "", { maxLen: SUMMARY_MAX_LEN });
  const list = Array.isArray(comments) ? comments : [];
  const safeComments = list.map((c) => ({
    path: String((c && c.path) ?? "").trim(),
    line: Number(c && c.line),
    body: hardenUntrusted((c && c.body) ?? "", { maxLen: COMMENT_BODY_MAX_LEN }),
  }));
  return { summary: safeSummary, comments: safeComments };
}

const REVIEW_JOB_CRITERION_STATES = new Set([
  "proven",
  "failed",
  "not_proven",
  "not_testable",
]);
const REVIEW_JOB_VERDICTS = new Set([
  "proven",
  "failed",
  "not_proven",
  "not_testable",
]);

/** Project the headless review attestation onto the exact server wire shape. */
export function projectReviewJobAttestation(value) {
  if (!value || typeof value !== "object") return null;
  const jobId = String(value.jobId ?? "").trim();
  const verdict = String(value.verdict ?? "").trim();
  const summaryLine = String(value.summaryLine ?? "").trim();
  if (
    !jobId ||
    !REVIEW_JOB_VERDICTS.has(verdict) ||
    !summaryLine ||
    !Array.isArray(value.criterionResults)
  ) {
    return null;
  }
  const ids = new Set();
  const criterionResults = [];
  for (const raw of value.criterionResults) {
    if (!raw || typeof raw !== "object") return null;
    const criterionId = String(raw.criterionId ?? "").trim();
    const expected = String(raw.expected ?? "").trim();
    const observed = String(raw.observed ?? "").trim();
    const state = raw.state;
    if (
      !criterionId ||
      ids.has(criterionId) ||
      !expected ||
      !observed ||
      !REVIEW_JOB_CRITERION_STATES.has(state) ||
      !Array.isArray(raw.evidenceRefs) ||
      raw.evidenceRefs.some((reference) => typeof reference !== "string" || !reference.trim()) ||
      (state !== "not_testable" && raw.evidenceRefs.length === 0)
    ) {
      return null;
    }
    ids.add(criterionId);
    criterionResults.push({
      criterionId,
      state,
      expected,
      observed,
      evidenceRefs: raw.evidenceRefs.map((reference) => reference.trim()),
    });
  }
  if (criterionResults.length === 0) return null;
  let evidenceKeys;
  if (value.evidenceKeys !== undefined) {
    if (
      !Array.isArray(value.evidenceKeys) ||
      value.evidenceKeys.some((key) => typeof key !== "string" || !key.trim())
    ) {
      return null;
    }
    evidenceKeys = value.evidenceKeys.map((key) => key.trim());
  }
  return {
    jobId,
    criterionResults,
    verdict,
    summaryLine,
    ...(evidenceKeys === undefined ? {} : { evidenceKeys }),
  };
}

/**
 * Post an advisory PR review for the conversation identified by
 * `eveSessionId`. Returns `{ ok: true, reviewUrl, summary,
 * inlineCommentsPosted, foldedComments }` on success, or a structured
 * `{ ok: false, reason, message }` otherwise — never throws, never retries
 * (single attempt; the console owns the GitHub-side 422 retry internally).
 *
 *   1. unset console config              -> failure("config_missing")
 *   2. blank eveSessionId/repo, or a
 *      non-positive-integer prNumber     -> failure("bad_request")
 *   3. nothing left after the severity
 *      filter AND a blank summary        -> failure("nothing_to_post")
 *   4. transport throws                  -> failure("unreachable")
 *   5. non-2xx status                    -> failure(<mapped reason>,
 *                                            <console's own error message,
 *                                            when present>)
 *   6. non-JSON / malformed 2xx body     -> failure("bad_body")
 *   7. success                           -> { ok: true, reviewUrl, summary,
 *                                            inlineCommentsPosted,
 *                                            foldedComments, droppedComments }
 *
 * `acCoverage` (default null): the reviewer's per-AC coverage judgments,
 * relayed by root verbatim — reviewer-relayed, untrusted-derived input, same
 * provenance as `summary`/`comments` (see the module header). Rendered into
 * `summary` by `composeSummary` BEFORE this function's call to
 * `sanitizeReviewInput` hardens it, so it is never posted unhardened.
 * Omitted or null leaves the posted body byte-identical to a call that never
 * knew about coverage at all. An entry may additionally carry
 * `evidence_images` (B2a §3) — QA's per-AC screenshots, folded into this
 * same array by root for behavioral ACs — which `renderAcCoverage` renders
 * as trailing, sanitized markdown links on that entry's line; entries
 * without it are unaffected.
 *
 * `judgment` (default null): Task 6's structured judgment ({verdict, note,
 * basis} × simplest/architecture/debt/hiddenRisks), relayed by root
 * verbatim — same untrusted-derived provenance as `summary`/`acCoverage`.
 * Rendered into `summary` by `composeSummary` (which folds in `acCoverage`
 * too) BEFORE `sanitizeReviewInput` hardens it, so it is never posted
 * unhardened either. Omitted or null leaves the posted body byte-identical
 * to a call that never knew about judgment at all.
 *
 * @param {{ eveSessionId: string, repo: string, prNumber: number,
 *           summary: string, comments: Array<{path: string, line: number, body: string}>,
 *           acCoverage?: unknown,
 *           judgment?: unknown,
 *           reviewJob?: unknown,
 *           env?: Record<string, string|undefined>,
 *           transport: (url: string, init: { method: string, headers: Record<string,string>, body: string }) =>
 *             Promise<{ status: number, json: () => Promise<unknown> }>,
 *           changeRecordTransport?: null | ((url: string, init: { method: string, headers: Record<string,string>, body: string }) =>
 *             Promise<{ status: number, json: () => Promise<unknown> }>) }} args
 */
export async function runPostPrReview({
  eveSessionId,
  repo,
  prNumber,
  summary,
  comments,
  acCoverage = null,
  judgment = null,
  reviewJob = null,
  env = {},
  transport,
  changeRecordTransport = null,
}) {
  const cfg = resolveConsoleConfig(env);
  if (!cfg.ok) return failure("config_missing");

  const sessionId = String(eveSessionId ?? "").trim();
  const repoTrimmed = String(repo ?? "").trim();
  const prNum = Number(prNumber);
  if (!sessionId || !repoTrimmed || !Number.isInteger(prNum) || prNum <= 0) {
    return failure("bad_request");
  }

  // Severity filter FIRST, then sanitize: only what we're actually posting
  // needs hardening, and sanitizeReviewInput's own output shape
  // ({path, line, body}) is what drops `severity` before it reaches the
  // console — it is an internal control, not part of that contract. The
  // acCoverage checklist and the judgment line both join the summary HERE,
  // via composeSummary, before sanitizeReviewInput's hardenUntrusted() call,
  // so their text (untrusted-derived, same as summary/comments) rides the
  // same sanitizer as everything else rather than reaching GitHub unhardened.
  const { postable, dropped } = filterPostableComments(comments);
  const changeRecord =
    typeof changeRecordTransport === "function"
      ? await fetchPrChangeRecord({
          cfg,
          sessionId,
          repo: repoTrimmed,
          prNumber: prNum,
          transport: changeRecordTransport,
        })
      : null;
  const composed = composeSummaryWithChangeRecord(
    composeSummary(summary, acCoverage, judgment),
    changeRecord,
  );
  const safe = sanitizeReviewInput(composed, postable);

  const reviewJobAttestation =
    reviewJob === null || reviewJob === undefined
      ? null
      : projectReviewJobAttestation(reviewJob);
  if (reviewJob !== null && reviewJob !== undefined && !reviewJobAttestation) {
    return failure("bad_request");
  }

  // Nothing worth posting and nothing to say: report it honestly rather than
  // spending a call the console would 400 anyway.
  if (safe.summary.trim().length === 0 && safe.comments.length === 0) {
    return failure("nothing_to_post");
  }

  const url = reviewJobAttestation
    ? buildReviewJobPostUrl(cfg.baseUrl, reviewJobAttestation.jobId)
    : buildPrReviewUrl(cfg.baseUrl);
  const requestBody = reviewJobAttestation
    ? {
        eveSessionId: sessionId,
        summary: safe.summary,
        comments: safe.comments,
        criterionResults: reviewJobAttestation.criterionResults,
        verdict: reviewJobAttestation.verdict,
        summaryLine: reviewJobAttestation.summaryLine,
        ...(reviewJobAttestation.evidenceKeys === undefined
          ? {}
          : { evidenceKeys: reviewJobAttestation.evidenceKeys }),
      }
    : {
        eveSessionId: sessionId,
        repo: repoTrimmed,
        prNumber: prNum,
        summary: safe.summary,
        comments: safe.comments,
      };

  let res;
  try {
    res = await transport(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(requestBody),
    });
  } catch {
    // Network error / DNS / timeout — a single failed attempt, reported not retried.
    return failure("unreachable");
  }

  const status = Number(res && res.status);
  const cls = classifyStatus(status);
  if (!cls.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
      return failure(cls.reason);
    }
    const consoleMessage =
      body && typeof body === "object" && typeof body.error === "string" && body.error
        ? body.error
        : undefined;
    return failure(cls.reason, consoleMessage);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return failure("bad_body");
  }

  const reviewUrl =
    body &&
    typeof body === "object" &&
    typeof body.reviewUrl === "string" &&
    body.reviewUrl.trim()
      ? body.reviewUrl.trim()
      : null;
  if (!body || typeof body !== "object" || body.posted !== true || !reviewUrl) {
    return failure("bad_body");
  }

  return {
    ok: true,
    reviewUrl,
    summary: typeof body.summary === "string" ? body.summary : safe.summary,
    inlineCommentsPosted:
      typeof body.inlineCommentsPosted === "number" ? body.inlineCommentsPosted : 0,
    foldedComments: Array.isArray(body.foldedComments) ? body.foldedComments : [],
    // How many findings were withheld for being below `major`, so root can say
    // so plainly in chat instead of implying the whole review landed.
    droppedComments: dropped,
  };
}
