// Pure, dependency-free helpers for BACKLOG GROOMING (issue #1291) — the
// signal computations behind Jace's `backlog-triage` skill. These are the ONLY
// scoring-adjacent code in this feature: the actual ORDERING and the reasoned
// rationale live in the skill's prose (skills/backlog-triage/SKILL.md), where
// the model weighs these signals per the human's ask. What lives here is only
// the mechanical, unit-testable arithmetic the model shouldn't have to do by
// eye — age, staleness, and title-similarity — computed once at fetch time and
// handed to the model alongside each issue.
//
// DELIBERATELY NOT the run-failure "triage" (FAILURE DIAGNOSIS,
// agent/subagents/triage). This is grooming of the open-issue backlog — a
// distinct name and module, kept apart on purpose.
//
// Everything here is pure (no I/O, no clock of its own — `now` is always
// passed in), so every branch is testable without a live GitHub or a real
// wall clock.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Parse an ISO-8601 timestamp to epoch-ms, or `null` when it is missing or
 * unparseable. GitHub always sends `created_at`/`updated_at` as ISO strings,
 * but a normalized-away or empty value must degrade to `null` (an unknown
 * signal), never to `NaN`-driven nonsense downstream.
 *
 * @param {unknown} iso
 * @returns {number | null}
 */
export function parseIsoMs(iso) {
  if (typeof iso !== "string" || iso.trim() === "") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Whole days between `iso` and `now` (both epoch-ms once parsed), floored and
 * never negative. `null` when `iso` can't be parsed — an unknown signal the
 * skill treats as "age unknown", never as zero (which would falsely read as
 * "brand new").
 *
 * @param {unknown} iso
 * @param {number} now — epoch-ms
 * @returns {number | null}
 */
export function daysBetween(iso, now) {
  const then = parseIsoMs(iso);
  if (then === null || !Number.isFinite(now)) return null;
  const days = Math.floor((now - then) / MS_PER_DAY);
  return days < 0 ? 0 : days;
}

/** Age in days since the issue was OPENED (created_at). See daysBetween. */
export function ageInDays(createdAt, now) {
  return daysBetween(createdAt, now);
}

/** Staleness in days since the issue was last TOUCHED (updated_at). See daysBetween. */
export function stalenessInDays(updatedAt, now) {
  return daysBetween(updatedAt, now);
}

// Short, common words that carry no disambiguating signal for
// duplicate-detection. Kept tiny on purpose — this is a similarity heuristic
// the model refines, not a search engine.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with",
  "is", "are", "be", "when", "add", "fix", "bug", "issue", "support",
]);

/**
 * Normalize a title into a set of comparison tokens: lowercased, punctuation
 * stripped, split on whitespace, stopwords and 1-char tokens dropped.
 *
 * @param {unknown} title
 * @returns {Set<string>}
 */
export function titleTokens(title) {
  const text = String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const tokens = new Set();
  for (const tok of text.split(/\s+/)) {
    if (tok.length <= 1) continue;
    if (STOPWORDS.has(tok)) continue;
    tokens.add(tok);
  }
  return tokens;
}

/**
 * Jaccard similarity (|A ∩ B| / |A ∪ B|) of two token sets — 0..1. Two empty
 * sets are treated as NOT similar (0), never 1: a pair of title-less issues
 * carries no duplicate signal to act on.
 *
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number}
 */
export function jaccardSimilarity(a, b) {
  if (!(a instanceof Set) || !(b instanceof Set)) return 0;
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const tok of a) if (b.has(tok)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Default similarity threshold above which two titles are flagged as LIKELY
 * duplicates. Deliberately conservative — this only SURFACES candidate pairs
 * for the model (and ultimately the human) to judge; it never itself decides a
 * dedupe. Overridable per call.
 */
export const DEFAULT_DUPLICATE_THRESHOLD = 0.6;

/**
 * Find groups of issues whose normalized titles are pairwise-similar at or
 * above `threshold`, by single-linkage clustering (a transitively-connected
 * component). Each returned group has 2+ members; a member is
 * `{ repo, number, title }`. Issues are compared ACROSS repos too — a
 * duplicate can live in a sibling repo. Deterministic: input order is
 * preserved within and across groups.
 *
 * Pure and O(n²) in the issue count — fine for a groomed backlog (the read
 * route caps the sweep well below where this matters).
 *
 * @param {Array<{repo?: string, number?: number, title?: string}>} issues
 * @param {number} [threshold]
 * @returns {Array<{ members: Array<{repo: string, number: number, title: string}>, maxSimilarity: number }>}
 */
export function findLikelyDuplicateGroups(issues, threshold = DEFAULT_DUPLICATE_THRESHOLD) {
  const list = Array.isArray(issues) ? issues : [];
  const tokens = list.map((it) => titleTokens(it && it.title));
  const n = list.length;

  // Union-Find over issue indices, unioning any pair at/above threshold.
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const pairMax = new Map(); // root -> max similarity seen within the component

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = jaccardSimilarity(tokens[i], tokens[j]);
      if (sim >= threshold) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj);
        const root = find(i);
        pairMax.set(root, Math.max(pairMax.get(root) ?? 0, sim));
      }
    }
  }

  // Collect components with 2+ members, preserving input order.
  const byRoot = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(i);
  }

  const groups = [];
  for (const [root, indices] of byRoot) {
    if (indices.length < 2) continue;
    // Re-derive maxSimilarity from a stable root key (components may have
    // merged after pairMax was first written under a since-superseded root).
    let maxSim = 0;
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        maxSim = Math.max(maxSim, jaccardSimilarity(tokens[indices[a]], tokens[indices[b]]));
      }
    }
    void root;
    groups.push({
      members: indices.map((idx) => ({
        repo: String((list[idx] && list[idx].repo) ?? ""),
        number: Number((list[idx] && list[idx].number) ?? 0),
        title: String((list[idx] && list[idx].title) ?? ""),
      })),
      maxSimilarity: Number(maxSim.toFixed(3)),
    });
  }
  return groups;
}

// Impact labels that mark an issue as higher-priority. Matched
// case-insensitively as a substring of a label name, so "priority:high",
// "P1-bug", "security" all hit. This is a SIGNAL the skill weighs, not a
// hard ordering.
const IMPACT_LABEL_PATTERNS = [
  "security",
  "bug",
  "regression",
  "critical",
  "urgent",
  "priority",
  "p0",
  "p1",
  "blocker",
  "data-loss",
];

/**
 * The subset of an issue's labels that read as impact/priority signals. Pure
 * projection over the label names; never invents a label the issue lacks.
 *
 * @param {unknown} labels
 * @returns {string[]}
 */
export function impactLabels(labels) {
  const list = Array.isArray(labels) ? labels : [];
  const out = [];
  for (const raw of list) {
    const name = String(raw ?? "");
    const lower = name.toLowerCase();
    if (IMPACT_LABEL_PATTERNS.some((p) => lower.includes(p))) out.push(name);
  }
  return out;
}
