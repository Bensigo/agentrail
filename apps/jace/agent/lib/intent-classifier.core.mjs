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
  "do",
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

/** ASSUMPTION: any of these appearing ANYWHERE forces "capable", even inside
 * an otherwise short/greeting-shaped message — a real question or a mention
 * of substantive work is never chit-chat, no matter how it's phrased. */
const CAPABLE_SIGNAL_KEYWORDS = [
  "?",
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

function containsAnyCapableSignal(normalized) {
  return CAPABLE_SIGNAL_KEYWORDS.some((signal) => normalized.includes(signal));
}

/** True only when EVERY word in the normalized text is a known chit-chat
 * word — one unrecognized word (e.g. "issue", a person's name, a real
 * question) fails the whole message out of chit-chat. */
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
