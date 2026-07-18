/**
 * Task-type classifier for the alignment brief (#1275).
 *
 * There is no measured task-type signal anywhere in this codebase today
 * (`runs.task_type` is a documented-absent stub — see
 * `packages/db-postgres/src/queries/index.ts`'s `GetRunnerRunStatsFilters`
 * comment — and no GitHub label beyond the single trigger label is ever
 * captured). The only free inputs available at brief-render time are the
 * text `create_issue` already collects: `title`, `whatToBuild`,
 * `acceptanceCriteria` (see `apps/jace/agent/tools/create_issue.ts`).
 *
 * ASSUMPTION: this entire module is a v1 keyword heuristic, not a trained or
 * measured classifier. Every keyword list below is a first guess at what
 * correlates with a task type's actual cost/difficulty profile — it is
 * calibratable later once enough completed runs exist to correlate keyword
 * hits against real `runs.costUsd` spend (recon annex §3). Treat a
 * misclassification here as an expected v1 heuristic miss, not a bug.
 */

export type TaskType = "ui" | "refactor" | "mechanical" | "general";

export interface TaskInput {
  title: string;
  whatToBuild: string;
  acceptanceCriteria: string[];
}

// ---------------------------------------------------------------------------
// Keyword sets (ASSUMPTION — see module doc comment above)
// ---------------------------------------------------------------------------

/** ASSUMPTION: signals a frontend-shaped task (locked design point 2). */
const UI_KEYWORDS = [
  "component",
  "page",
  "css",
  "layout",
  "design",
  "frontend",
  "ui",
  "ux",
  "style",
  "styling",
  "screen",
  "modal",
  "dialog",
  "form",
  "button",
  "responsive",
] as const;

/** ASSUMPTION: signals a small, bounded, low-risk change (locked design point 2). */
const MECHANICAL_KEYWORDS = [
  "rename",
  "bump",
  "typo",
  "config",
  "copy-change",
  "copy change",
  "changelog",
  "formatting",
  "dependency bump",
  "version bump",
] as const;

/** ASSUMPTION: signals a harder, reasoning-heavy change (locked design point 2). */
const REFACTOR_KEYWORDS = [
  "refactor",
  "architecture",
  "migrate",
  "migration",
  "redesign",
  "extract",
  "restructure",
  "decouple",
  "consolidate",
] as const;

/**
 * Whole-word, case-insensitive-by-caller-convention match (the haystack is
 * lowercased by the only caller, {@link classifyTaskType}).
 *
 * Word-boundary anchored on purpose: a naive substring `.includes()` check
 * would false-positive constantly — e.g. the UI keyword `"ui"` is a literal
 * substring of "build", "guide", "quick", and the UI keyword `"form"` is a
 * substring of "format"/"platform"/"information". `\b...\b` avoids all of
 * these while still matching hyphenated multi-word keywords like
 * `"copy-change"` (the hyphen itself is matched literally; `\b` only anchors
 * the outer edges against non-word characters).
 *
 * Trade-off, documented rather than hidden: this also means a keyword like
 * `"config"` will NOT match inside "configuration" (no trailing word
 * boundary). Recall is intentionally sacrificed for precision in v1 — a
 * missed keyword falls through to a later bucket or to "general", which is
 * the safe direction to fail in (see the assumption note on `classifyTaskType`
 * below).
 */
function containsAnyKeyword(haystack: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`).test(haystack);
  });
}

/**
 * Classify a task's type from its free-text description. Deterministic and
 * case-insensitive: the same input always returns the same {@link TaskType},
 * and casing never affects the result.
 *
 * Precedence when multiple keyword sets match (ASSUMPTION, documented — not
 * specified by any measured signal): mechanical > refactor > ui > general.
 *   - mechanical first: a task described as a "rename"/"bump"/"typo" fix is
 *     small and bounded even when it happens to touch UI code (e.g. "bump the
 *     Button component's version").
 *   - refactor before ui: a "redesign" or "architecture" change is scoped by
 *     its reasoning difficulty, not by whether it touches UI surface — e.g.
 *     "redesign the onboarding modal" is a refactor-shaped task even though
 *     "modal" is also a UI keyword.
 *   - ui before the general fallback.
 *
 * No keyword match at all → "general" (the honest, non-committal default —
 * see the locked design's "ambiguous-defaults-to-general" requirement).
 */
export function classifyTaskType(input: TaskInput): TaskType {
  const haystack = [input.title, input.whatToBuild, ...input.acceptanceCriteria]
    .join(" ")
    .toLowerCase();

  if (containsAnyKeyword(haystack, MECHANICAL_KEYWORDS)) return "mechanical";
  if (containsAnyKeyword(haystack, REFACTOR_KEYWORDS)) return "refactor";
  if (containsAnyKeyword(haystack, UI_KEYWORDS)) return "ui";
  return "general";
}
