// Chat-turn intent classifier for #1339 (per-intent chat model routing).
//
// Pure, dependency-free, mirrors #1338's classifyTaskType keyword-heuristic
// shape (apps/console/lib/alignment/classifier.ts): no ML, no network, a
// first-guess v1 that root's routing policy (instructions.md) and the
// smalltalk subagent's description enforce in parallel — this module is the
// single canonical definition of the "chit-chat" boundary so the prompt-side
// policy, this classifier, and #1339 PR②'s per-turn intent tagging can never
// silently drift into disagreeing category boundaries.
//
// ONLY two classes exist today: "chit-chat" (a new cheap-tier smalltalk
// subagent handles the reply) and "capable" (root handles it, unchanged from
// pre-#1339 behavior — this covers workspace-memory Q&A AND to-issues/
// gated-tool turns alike; the issue's brief named those as separate "mid"/
// "capable" tiers, but no mid-tier model exists anywhere in this repo yet,
// and inventing one is a product decision, not something to default
// silently — see #1339 PR① design notes). Collapsing them into one class is
// deliberately the SAFE direction: it can never mis-route a to-issues or
// gated-tool turn onto a cheaper tier by mistake.
//
// FAILS TOWARD CAPABLE (AC2): classify() returns "capable" for anything that
// is not confidently, unambiguously chit-chat. A message that merely
// CONTAINS a greeting word but also asks a real question, mentions the
// codebase/repo/issue, or runs long is "capable" — the classifier only
// approves the cheap path when the ENTIRE message reads as small talk.

/** ASSUMPTION: a chit-chat/ack turn is short. Long messages are never
 * classified chit-chat even if they open with a greeting word — see
 * CAPABLE_SIGNAL_KEYWORDS below, which catches most of those anyway, but the
 * length cap is a second, independent backstop. */
const MAX_CHITCHAT_LENGTH = 40;

/** ASSUMPTION: the message, once trimmed and lowercased, must be made up
 * ENTIRELY of separator characters and words drawn from this list to count
 * as chit-chat — a partial/substring match is not enough (see
 * containsOnlyChitchatWords below). Covers greetings, acks, thanks, and
 * sign-offs; deliberately small, not an exhaustive natural-language list. */
const CHITCHAT_WORDS = [
  "hi",
  "hey",
  "hello",
  "yo",
  "howdy",
  "morning",
  "afternoon",
  "evening",
  "good",
  "sup",
  "whats",
  "up",
  "there",
  "thanks",
  "thank",
  "you",
  "thx",
  "ty",
  "appreciated",
  "appreciate",
  "it",
  "ok",
  "okay",
  "k",
  "kk",
  "cool",
  "nice",
  "great",
  "awesome",
  "perfect",
  "sounds",
  "got",
  "will",
  "bye",
  "goodbye",
  "goodnight",
  "night",
  "later",
  "cheers",
  "yep",
  "yup",
  "yeah",
  "nope",
  "no",
  "yes",
  "haha",
  "lol",
];

/** ASSUMPTION: any of these appearing ANYWHERE (as a whole word/phrase, not a
 * substring — see {@link containsAnyKeyword}) forces "capable", even inside
 * an otherwise short/greeting-shaped message — a real question or a mention
 * of substantive work is never chit-chat, no matter how it's phrased.
 *
 * Code-review finding (verified, fixed): a plain `.includes()` substring scan
 * here previously made several {@link CHITCHAT_WORDS} entries permanently
 * unreachable dead code — `"howdy"` contains `"how"`, `"whats"` contains
 * `"what"`, `"appreciate"`/`"appreciated"` contain `"pr"` — so
 * `classifyIntent("howdy")` returned `"capable"` despite `"howdy"` being a
 * listed chit-chat word. Word-boundary matching (mirroring #1338's
 * `classifyTaskType`'s own `containsAnyKeyword`) fixes this: `"how"` no
 * longer matches inside `"howdy"`. */
const CAPABLE_SIGNAL_KEYWORDS = [
  "issue",
  "issues",
  "repo",
  "repository",
  "codebase",
  "code",
  "bug",
  "fix",
  "feature",
  "deploy",
  "pr",
  "pull request",
  "branch",
  "workspace",
  "memory",
  "run",
  "failed",
  "error",
  "why",
  "how",
  "what",
  "when",
  "where",
  "can you",
  "could you",
  "please",
  "help",
];

function normalize(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase();
}

/**
 * Whole-word/whole-phrase, case-caller's-responsibility match (the caller
 * already lowercases). Mirrors #1338's `classifyTaskType`'s own
 * `containsAnyKeyword` exactly, for the same reason: a naive substring
 * `.includes()` false-positives constantly (`"how"` inside `"howdy"`, `"what"`
 * inside `"whats"`, `"pr"` inside `"appreciate"`) — `\b...\b` anchors each
 * keyword to real word boundaries while still matching multi-word phrases
 * like `"pull request"` / `"can you"` as a whole.
 */
function containsAnyKeyword(haystack, keywords) {
  return keywords.some((keyword) => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`).test(haystack);
  });
}

function containsAnyCapableSignal(normalized) {
  // "?" is punctuation, not a word — \b boundaries don't apply to it the same
  // way, so it stays a plain substring check, separate from the word-boundary
  // keyword scan.
  if (normalized.includes("?")) return true;
  return containsAnyKeyword(normalized, CAPABLE_SIGNAL_KEYWORDS);
}

/** True only when EVERY word in the normalized text is a known chit-chat
 * word — one unrecognized word (e.g. "issue", a person's name, a real
 * question) fails the whole message out of chit-chat.
 *
 * Code-review finding (verified, fixed): treating every {@link
 * CHITCHAT_WORDS} entry as a free-floating token in one shared bag let
 * unrelated words combine into something that reads as a real confirmation
 * or directive, not small talk — `"yes"` + `"do"` + `"it"` (all
 * independently listed) passed as `"yes do it"` / `"ok do it"` / `"great, do
 * it"`, which plausibly answers a real question ("should I go ahead?") and
 * is not "confidently, unambiguously chit-chat" per this module's own AC2
 * contract. `"do"` — the common thread across every reported case, and
 * genuinely content-free on its own — is removed from the list entirely
 * rather than patched around; `"it"` stays (needed for the legitimate `"got
 * it"` ack) since `"it"` alone was never the reported failure mode. */
function containsOnlyChitchatWords(normalized) {
  const words = normalized.split(/[^a-z]+/).filter((w) => w.length > 0);
  if (words.length === 0) return false;
  return words.every((word) => CHITCHAT_WORDS.includes(word));
}

/**
 * Classify a chat turn's intent from its raw text. Deterministic,
 * case-insensitive, synchronous.
 *
 * @param {string} text
 * @returns {"chit-chat" | "capable"}
 */
export function classifyIntent(text) {
  const normalized = normalize(text);
  if (!normalized) return "capable";
  if (normalized.length > MAX_CHITCHAT_LENGTH) return "capable";
  if (containsAnyCapableSignal(normalized)) return "capable";
  if (!containsOnlyChitchatWords(normalized)) return "capable";
  return "chit-chat";
}
