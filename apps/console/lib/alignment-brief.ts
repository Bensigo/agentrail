/**
 * Alignment brief composition (#1274 PR ①) — turns a GitHub issue's raw
 * title/body into the `jace_approvals.tool_input` content the console's
 * github-webhook route records and `approval-message.ts`'s `"alignment_brief"`
 * case later renders. Pure: no db, no fetch, no Telegram shapes — mirrors
 * `approval-message.ts`'s own "pure and channel-agnostic" posture.
 *
 * NOT part of the merged estimate lib (`./alignment/*`, #1275 PR ①) — this is
 * a separate, NEW module that CONSUMES it (`estimateBrief`) rather than
 * extending it, per the #1274 PR ① brief's explicit "no changes to the
 * estimate lib" boundary.
 */

import { estimateBrief } from "./alignment";
import type { TaskType } from "./alignment";
import { validateAcceptanceCriteria } from "@agentrail/db-postgres";

/**
 * The shape stored on `jace_approvals.tool_input` for a `toolName:
 * "alignment_brief"` approval, and what `approval-message.ts`'s
 * `renderAlignmentBrief` reads back out (defensively — see that file's own
 * `Record<string, unknown>` idiom; this interface documents the CONTRACT both
 * sides agree to, not a runtime guarantee once it round-trips through jsonb).
 *
 * `whatToBuild` stores the FULL issue body, not a pre-truncated excerpt: the
 * "approach excerpt" the brief displays is a RENDER-time truncation
 * (`approval-message.ts`'s `sanitizeField`/`hardTruncate` idiom, exactly like
 * every other renderer in that file), so the stored value stays exact — and,
 * not incidentally, is also what `estimateBrief` below was actually computed
 * from (a stored excerpt would silently corrupt the volume-bucket sizing).
 */
export interface AlignmentBriefToolInput {
  title: string;
  whatToBuild: string;
  acceptanceCriteria: string[];
  taskType: TaskType;
  suggestedModel: { slug: string; displayName: string };
  estimateUsd: number;
  assumptions: string[];
  repoFullName: string;
  issueNumber: number;
  issueUrl: string;
}

/**
 * Light, TOLERANT acceptance-criteria extraction for the brief: reuses the
 * db-postgres AC gate's own house-format parser (`## Acceptance criteria`
 * heading + checkbox lines) rather than re-implementing the regex — a second
 * hand-rolled copy would drift. Unlike that gate, an absent/empty section
 * never fails here: it degrades to `[]`, and `estimateBrief`'s volume bucket
 * handles a 0-length acceptanceCriteria gracefully (a smaller bucket, never a
 * throw — see `alignment/estimate.ts`'s "never-0" test). In practice this is
 * never hit on the path this PR wires (enqueueGithubIssue's own AC gate has
 * already required a non-empty section before the alignment hold ever fires),
 * but composeAlignmentBrief is written to be safe for any future caller that
 * doesn't have that guarantee.
 */
export function parseAcceptanceCriteriaForBrief(body: string): string[] {
  const gate = validateAcceptanceCriteria(body);
  return gate.ok ? gate.criteria : [];
}

/**
 * Compose the full alignment-brief content for a GitHub issue. `issueUrl`
 * is a caller-supplied param (not recomputed here) — the caller imports
 * `githubIssueUrl` from `@agentrail/db-postgres` so the two sides can never
 * drift on URL formatting (see that function's own doc-comment).
 */
export function composeAlignmentBrief(input: {
  title: string;
  body: string;
  repoFullName: string;
  issueNumber: number;
  issueUrl: string;
}): AlignmentBriefToolInput {
  const acceptanceCriteria = parseAcceptanceCriteriaForBrief(input.body);
  const estimate = estimateBrief({
    title: input.title,
    whatToBuild: input.body,
    acceptanceCriteria,
  });

  return {
    title: input.title,
    whatToBuild: input.body,
    acceptanceCriteria,
    taskType: estimate.taskType,
    suggestedModel: {
      slug: estimate.suggestedModel.slug,
      displayName: estimate.suggestedModel.displayName,
    },
    estimateUsd: estimate.estimateUsd,
    assumptions: estimate.assumptions,
    repoFullName: input.repoFullName,
    issueNumber: input.issueNumber,
    issueUrl: input.issueUrl,
  };
}

export interface ConfirmedBudgetAndModel {
  estimatedBudgetUsd: number;
  modelOverride: string;
}

/**
 * Defensively extract the two values the alignment gate's confirm side-effect
 * needs FROM THE STORED APPROVAL ROW's `toolInput` — never from the Telegram
 * callback itself (owner rule: server-derived, never caller-supplied). `null`
 * on anything malformed (a hand-edited row, a future toolInput-shape change)
 * so the caller can log loudly and leave the entry parked rather than write a
 * bogus budget/model.
 */
export function extractConfirmedBudgetAndModel(
  toolInput: Record<string, unknown>
): ConfirmedBudgetAndModel | null {
  const estimateUsd = toolInput["estimateUsd"];
  if (typeof estimateUsd !== "number" || !Number.isFinite(estimateUsd)) {
    return null;
  }

  const suggestedModel = toolInput["suggestedModel"];
  if (!suggestedModel || typeof suggestedModel !== "object" || Array.isArray(suggestedModel)) {
    return null;
  }
  const slug = (suggestedModel as Record<string, unknown>)["slug"];
  if (typeof slug !== "string" || slug.length === 0) {
    return null;
  }

  return { estimatedBudgetUsd: estimateUsd, modelOverride: slug };
}
