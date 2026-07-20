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
 *
 * Model-selection learning loop (#1338 PR②): `composeAlignmentBrief` /
 * `composeChatBornBrief` themselves stay exactly as pure/synchronous as
 * before — they gained one new OPTIONAL input field (`modelSelection`) that,
 * when supplied, is threaded into `estimateBrief`'s own new optional
 * `modelOverride` param instead of letting it fall through to
 * `MODEL_CATALOG[taskType]`. Neither function calls the database itself.
 * The ONE new async, DB-touching function in this file is
 * {@link resolveModelSelectionForBrief} — it decides (per the feature flag)
 * whether to await the selector at all, and BOTH real call sites
 * (`alignment-reconciler.ts`'s `postAlignmentBrief`, the runner/approvals
 * POST route's `enrichCreateIssueToolInput`) call it BEFORE calling
 * `composeAlignmentBrief`/`composeChatBornBrief`, never the other way
 * around. This keeps every existing synchronous call site (including every
 * pre-#1338 test that calls these two functions directly, with no `await`)
 * completely unaffected.
 */

import { estimateBrief, classifyTaskType, isModelSelectionLearningEnabled } from "./alignment";
import type { TaskType, ModelSeat } from "./alignment";
// selectExecuteModel/describeModelSelection are imported directly from
// ./alignment/selector, NOT the ./alignment barrel — that barrel is also
// imported by client-rendered code and must stay free of anything that
// transitively pulls in @agentrail/db-postgres (see index.ts's own module
// doc for the build failure this avoids).
import { selectExecuteModel, describeModelSelection } from "./alignment/selector";
import { validateAcceptanceCriteria } from "@agentrail/db-postgres";

/**
 * An already-resolved execute-model pick to feed into
 * `composeAlignmentBrief`/`composeChatBornBrief` instead of letting them
 * fall through to `MODEL_CATALOG[taskType]`. Always built via
 * {@link resolveModelSelectionForBrief} — never constructed ad hoc — so the
 * two compose functions never need to know HOW the pick was made, only
 * what it was and why.
 */
export interface ModelSelectionForBrief {
  model: ModelSeat;
  /** Precomputed human-readable one-line "why" (`selector.ts`'s `describeModelSelection`) — the compose functions store this verbatim; they never reformat it. */
  reasonText: string;
}

/**
 * #1338 PR② — resolve the model-selection override for a brief, if the
 * feature flag (`feature-flags.ts`) is on for `workspaceId`. This is the
 * ONE place in the whole alignment-brief compose path that touches the
 * database (via `selectExecuteModel` -> `getModelOutcomeStats`) — isolated
 * here so `estimateBrief` and `composeAlignmentBrief`/`composeChatBornBrief`
 * all stay synchronous and side-effect-free, exactly as before #1338.
 *
 * Returns `undefined` (falling back to `MODEL_CATALOG[taskType]`,
 * byte-identical to pre-#1338 behavior) when: the flag is off, `workspaceId`
 * is absent (a chat-identity-only session that hasn't graduated to a
 * workspace yet — there is no workspace to scope `run_outcomes` stats to
 * anyway), or `selectExecuteModel` itself throws (fail-safe: a selector bug
 * or a transient DB error must never block posting a brief — the caller
 * still gets a usable static-catalog brief instead of an unhandled 500).
 */
export async function resolveModelSelectionForBrief(
  taskInput: { title: string; whatToBuild: string; acceptanceCriteria: string[] },
  workspaceId: string | null | undefined
): Promise<ModelSelectionForBrief | undefined> {
  if (!workspaceId || !isModelSelectionLearningEnabled(workspaceId)) {
    return undefined;
  }

  const taskType = classifyTaskType(taskInput);
  try {
    const selection = await selectExecuteModel(taskType, workspaceId);
    return {
      model: selection.model,
      reasonText: describeModelSelection(taskType, selection),
    };
  } catch (err) {
    console.error(
      `[alignment-brief] selectExecuteModel threw while resolving the model-selection override for ` +
        `workspace ${workspaceId} (task type "${taskType}"); falling back to MODEL_CATALOG[taskType] ` +
        `(byte-identical to the flag-off path):`,
      err
    );
    return undefined;
  }
}

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
  /**
   * #1338 PR② — present ONLY when the model-selection-learning flag was on
   * for this workspace at compose time (see `resolveModelSelectionForBrief`):
   * the precomputed one-line "why" behind `suggestedModel`, e.g. "Claude
   * Sonnet 5 — best success rate for ui (12 runs)". Absent (`undefined`,
   * never serialized onto the stored jsonb row) when the flag was off — the
   * pre-#1338-PR② shape, byte-identical. Rendered on both brief surfaces
   * (`approval-message.ts`'s `renderAlignmentBrief`, `approvals-helpers.ts`'s
   * `summarizeAlignmentBrief`) as a defensively-sanitized extra line/field.
   */
  modelSelectionReason?: string;
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
 *
 * `modelSelection` (#1338 PR②, OPTIONAL): an already-resolved pick from
 * {@link resolveModelSelectionForBrief} — the CALLER awaits that async,
 * flag-gated function BEFORE calling this one; this function itself stays
 * fully synchronous, exactly like `estimateBrief`. Omitted (every call site
 * before #1338, and any call site when the flag is off) -> behavior is
 * completely unchanged: `estimateBrief` falls through to
 * `MODEL_CATALOG[taskType]`, and `modelSelectionReason` is absent from the
 * returned shape.
 */
export function composeAlignmentBrief(input: {
  title: string;
  body: string;
  repoFullName: string;
  issueNumber: number;
  issueUrl: string;
  modelSelection?: ModelSelectionForBrief;
}): AlignmentBriefToolInput {
  const acceptanceCriteria = parseAcceptanceCriteriaForBrief(input.body);
  const estimate = estimateBrief(
    {
      title: input.title,
      whatToBuild: input.body,
      acceptanceCriteria,
    },
    input.modelSelection ? { modelOverride: input.modelSelection.model } : {}
  );

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
    ...(input.modelSelection ? { modelSelectionReason: input.modelSelection.reasonText } : {}),
  };
}

/**
 * The `_brief` shape (#1274 PR ②) the approvals POST route computes and
 * merges onto a `create_issue` approval's OWN `toolInput` at record time —
 * the "enrichment" half of the chat-born one-confirm collapse. Deliberately
 * NARROWER than {@link AlignmentBriefToolInput}: `title`/`whatToBuild`/
 * `acceptanceCriteria` already live at the top level of create_issue's own
 * `toolInput` (no need to duplicate them under `_brief`), and `repoFullName`/
 * `issueNumber`/`issueUrl` don't exist yet at approval-record time — no
 * GitHub issue has been created. `renderCreateIssue`
 * (`./approval-message.ts`) reuses `renderAlignmentBrief`'s own render by
 * flattening a create_issue toolInput's own fields together with `_brief`'s
 * fields back into the full shape — see that file's own comment.
 */
export interface ChatBornBrief {
  taskType: TaskType;
  suggestedModel: { slug: string; displayName: string };
  estimateUsd: number;
  assumptions: string[];
  /** #1338 PR② — see `AlignmentBriefToolInput.modelSelectionReason`'s own doc-comment; same presence rule, same content. */
  modelSelectionReason?: string;
}

/**
 * Compute the `_brief` fields for a chat-born `create_issue` call — the
 * SAME estimate-lib computation {@link composeAlignmentBrief} runs for a
 * GitHub-issue-shaped brief, just fed straight from create_issue's OWN
 * `{title, whatToBuild, acceptanceCriteria}` fields (already discrete on
 * that tool's toolInput — no AC-parsing needed, unlike a raw issue body).
 *
 * Pure — never throws for a well-shaped input (mirrors `estimateBrief`'s own
 * "never 0" guarantee); the caller (the approvals POST route) is
 * responsible for coercing a possibly-malformed `toolInput` into this
 * well-shaped input BEFORE calling this, and for catching/logging if it
 * still somehow throws (defense in depth — see that route's own comment).
 *
 * `modelSelection` (#1338 PR②, OPTIONAL): see `composeAlignmentBrief`'s own
 * doc-comment — same contract, same caller-awaits-first posture
 * (`resolveModelSelectionForBrief`), same byte-identical-when-omitted
 * guarantee.
 */
export function composeChatBornBrief(input: {
  title: string;
  whatToBuild: string;
  acceptanceCriteria: string[];
  modelSelection?: ModelSelectionForBrief;
}): ChatBornBrief {
  const estimate = estimateBrief(
    input,
    input.modelSelection ? { modelOverride: input.modelSelection.model } : {}
  );
  return {
    taskType: estimate.taskType,
    suggestedModel: {
      slug: estimate.suggestedModel.slug,
      displayName: estimate.suggestedModel.displayName,
    },
    estimateUsd: estimate.estimateUsd,
    assumptions: estimate.assumptions,
    ...(input.modelSelection ? { modelSelectionReason: input.modelSelection.reasonText } : {}),
  };
}

export interface ConfirmedBudgetAndModel {
  estimatedBudgetUsd: number;
  modelOverride: string;
  /** #1338 PR① (model-selection learning loop — the FUEL): the classifier's
   * output, read straight off the SAME stored `toolInput` (top-level on an
   * `alignment_brief` approval — see `AlignmentBriefToolInput.taskType`).
   * `null` when absent/malformed — independent of the two fields above, a
   * missing task type never fails this extraction (see the function's own
   * doc-comment). */
  taskType: string | null;
}

/**
 * Defensively extract the values the alignment gate's confirm side-effect
 * needs FROM THE STORED APPROVAL ROW's `toolInput` — never from the Telegram
 * callback itself (owner rule: server-derived, never caller-supplied). `null`
 * (the WHOLE result) on a malformed estimateUsd/suggestedModel (a hand-edited
 * row, a future toolInput-shape change) so the caller can log loudly and
 * leave the entry parked rather than write a bogus budget/model.
 *
 * `taskType` is extracted independently and never gates the result: a
 * missing/malformed task type still yields a valid
 * `{estimatedBudgetUsd, modelOverride, taskType: null}` — it's a
 * denormalization nice-to-have for #1338's learning-loop capture, not a
 * value the confirm flow itself depends on.
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

  const taskTypeValue = toolInput["taskType"];
  const taskType =
    typeof taskTypeValue === "string" && taskTypeValue.length > 0 ? taskTypeValue : null;

  return { estimatedBudgetUsd: estimateUsd, modelOverride: slug, taskType };
}
