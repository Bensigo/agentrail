import { sanitizeField } from "../../../../../lib/approval-message";

/**
 * Pure formatting/derivation helpers for the workspace Approvals page
 * (#1276). Kept in a plain `.ts` file (no JSX) so it's unit-testable —
 * console vitest has no react plugin, mirrors the sibling convention
 * (`budget/budget-helpers.ts`, `review-gates/blocking-reason.ts`). The page
 * and its list components stay thin, reading from here.
 *
 * DELIBERATELY carries no import from `@agentrail/db-postgres` (or any other
 * server-only package): every list component that imports this file is
 * `"use client"` (PR ②'s action buttons), so this module is bundled for the
 * BROWSER. `@agentrail/db-postgres` transitively pulls in Node builtins
 * (`node:crypto`, for `recordApprovalRequest`'s token generation) that
 * webpack cannot bundle for the browser — importing it here broke the page
 * with a hard build error during PR ② verification. Where a value needs to
 * come from that package (the alignment park-reason constant
 * `isAlignmentLocked` compares against), the SERVER component (`page.tsx`)
 * imports the real constant and passes it through as a plain string.
 * `lib/approval-message` is safe: it's pure (zero imports) by design.
 *
 * SANITIZATION (#1276 fix round, review finding I1): every model-authored
 * `toolInput` field rendered here runs through the chat renderer's own
 * `sanitizeField` (imported, never copied — a second copy would drift):
 * invisible/bidi-override stripping, control-char removal, CR/LF
 * flattening, and a per-field length cap matching the chat side's caps
 * field-for-field. This page is the exact surface where a human decides
 * Approve/Deny, so it gets at least the chat renderer's defenses; the caps
 * also bound the RSC payload against a multi-megabyte adversarial
 * toolInput.
 */

export interface RelativeTime {
  label: string;
  title: string;
}

/**
 * Relative time ("3m ago") with the absolute local time as the hover title —
 * same thresholds as `budget/budget-helpers.ts`'s `formatRelativeTime`,
 * duplicated here rather than imported: this codebase's established
 * convention is page-local formatting helpers (see that file's own
 * doc-comment) rather than reaching across feature-folder boundaries.
 * Accepts `Date | string` because the three list sources disagree on shape —
 * `PendingApprovalRow`/`DeadLetterChannelMessageRow` carry a real `Date`,
 * `QueueEntryListItem.updatedAt` is already an ISO string — so callers never
 * have to normalize before calling this.
 */
export function formatRelativeTime(
  value: Date | string,
  now: Date = new Date()
): RelativeTime {
  const d = typeof value === "string" ? new Date(value) : value;
  const diffMs = now.getTime() - d.getTime();
  const minutes = Math.round(diffMs / 60000);
  const hours = Math.round(diffMs / 3600000);
  const days = Math.round(diffMs / 86400000);
  const label =
    minutes < 1
      ? "just now"
      : minutes < 60
        ? `${minutes}m ago`
        : hours < 24
          ? `${hours}h ago`
          : `${days}d ago`;
  return { label, title: d.toLocaleString() };
}

/** The dead-letter list's `lastError` display cap — sanitized AND capped via `sanitizeField` (an exception message can carry control characters and arbitrary length). */
export const LAST_ERROR_MAX_LEN = 160;

export interface ApprovalSummaryField {
  label: string;
  value: string;
}

/** What the page renders for one pending approval: a headline (the thing being approved) plus zero or more secondary fields. Mirrors `approval-message.ts`'s per-tool dispatch, field choices, AND per-field sanitize/caps (same underlying data, same "never throw on a malformed toolInput" posture) but returns STRUCTURED data instead of a formatted text blob — this is a React-rendered list item, not a chat message, so there's no reason to flatten to text first. */
export interface ApprovalSummary {
  headline: string;
  fields: ApprovalSummaryField[];
}

/** Cap on how many `toolInput` keys the unknown-tool fallback renders — same rationale and same number as `approval-message.ts`'s `GENERIC_FALLBACK_MAX_KEYS`: a wide/adversarial object could otherwise bury the useful bit under key noise. Combined with the per-field caps below (60/key + 200/value), this bounds the whole fallback summary to ~3.2KB — the structured-fields analog of the chat side's `hardTruncate` total cap. */
const GENERIC_FALLBACK_MAX_FIELDS = 12;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Defensive, best-effort summary of a `_brief` value that may appear inside a
 * `create_issue` approval's `toolInput` (a parallel PR may start writing this
 * — see `annex-1276-1278-recon.md`). No producer exists anywhere in this repo
 * today, so this has NOTHING real to validate against yet: it renders a
 * "Brief" field only when the value is a plain object carrying a usable
 * `title` and/or `estimateUsd`, and returns `null` (rendering nothing, never
 * throwing) for absolutely any other shape — a string, an array, a number, an
 * object missing both fields, or the key simply not being present at all.
 */
function tolerantBriefSummary(value: unknown): string | null {
  if (!isPlainObject(value)) return null;
  const title = typeof value["title"] === "string" ? sanitizeField(value["title"], 200) : "";
  const estimateUsd =
    typeof value["estimateUsd"] === "number" && Number.isFinite(value["estimateUsd"])
      ? value["estimateUsd"]
      : null;
  if (!title && estimateUsd === null) return null;
  const parts: string[] = [];
  if (title) parts.push(title);
  if (estimateUsd !== null) parts.push(`~$${estimateUsd.toFixed(2)}`);
  return parts.join(" — ");
}

// Per-field caps below mirror approval-message.ts's own renderers
// field-for-field (title 200, workspace name 80, repo name 100, taskType 40,
// model displayName 60, generic key 60 / value 200, toolName 100).

function summarizeCreateIssue(input: Record<string, unknown>): ApprovalSummary {
  const headline = sanitizeField(input["title"], 200) || "(untitled)";
  const fields: ApprovalSummaryField[] = [];
  const brief = tolerantBriefSummary(input["_brief"]);
  if (brief) fields.push({ label: "Brief", value: brief });
  return { headline, fields };
}

function summarizeCreateWorkspace(input: Record<string, unknown>): ApprovalSummary {
  const headline = sanitizeField(input["name"], 80) || "(unnamed)";
  return { headline, fields: [] };
}

function summarizeCreateRepo(input: Record<string, unknown>): ApprovalSummary {
  const headline = sanitizeField(input["name"], 100) || "(unnamed)";
  // Mirrors approval-message.ts's renderCreateRepo: `private` omitted defaults
  // to private, so anything other than the literal `false` renders as private.
  const isPrivate = input["private"] !== false;
  return {
    headline,
    fields: [{ label: "Visibility", value: isPrivate ? "Private" : "Public" }],
  };
}

/** Mirrors `approval-message.ts`'s `renderAlignmentBrief` field selection (task type, suggested model, estimate) — same content, same caps, React-structured. */
function summarizeAlignmentBrief(input: Record<string, unknown>): ApprovalSummary {
  const headline = sanitizeField(input["title"], 200) || "(untitled)";
  const fields: ApprovalSummaryField[] = [];

  const taskType = sanitizeField(input["taskType"], 40);
  const suggestedModel = input["suggestedModel"];
  const suggestedModelDisplayName = isPlainObject(suggestedModel)
    ? sanitizeField(suggestedModel["displayName"], 60)
    : "";
  if (taskType || suggestedModelDisplayName) {
    fields.push({
      label: "Task type",
      value: suggestedModelDisplayName
        ? `${taskType || "general"} → ${suggestedModelDisplayName}`
        : taskType || "general",
    });
  }

  const estimateUsd = input["estimateUsd"];
  if (typeof estimateUsd === "number" && Number.isFinite(estimateUsd)) {
    fields.push({ label: "Estimate", value: `~$${estimateUsd.toFixed(2)}` });
  }

  return { headline, fields };
}

/** Unknown tool: toolName-derived headline + compact key:value fields — the React-side analog of `approval-message.ts`'s `renderGenericFallback`, same graceful-degradation posture (never fails closed on a tool this file doesn't know about yet) and same caps. */
function summarizeUnknownTool(
  toolName: string,
  input: Record<string, unknown>
): ApprovalSummary {
  const entries = Object.entries(input).slice(0, GENERIC_FALLBACK_MAX_FIELDS);
  const omitted = Object.entries(input).length - entries.length;
  const fields: ApprovalSummaryField[] = entries.map(([key, value]) => ({
    label: sanitizeField(key, 60),
    value: sanitizeField(value, 200),
  }));
  if (omitted > 0) {
    fields.push({ label: "", value: `…and ${omitted} more` });
  }
  return { headline: sanitizeField(toolName, 100) || "(unknown tool)", fields };
}

/**
 * Render the approve/deny summary for a gated tool call. Dispatches on
 * `toolName`, exactly like `approval-message.ts::renderApprovalMessage`; any
 * tool this file doesn't specifically know about renders via
 * `summarizeUnknownTool` rather than throwing or hiding the row.
 */
export function summarizeApprovalToolInput(
  toolName: string,
  toolInput: Record<string, unknown>
): ApprovalSummary {
  switch (toolName) {
    case "create_issue":
      return summarizeCreateIssue(toolInput);
    case "create_workspace":
      return summarizeCreateWorkspace(toolInput);
    case "create_repo":
      return summarizeCreateRepo(toolInput);
    case "alignment_brief":
      return summarizeAlignmentBrief(toolInput);
    default:
      return summarizeUnknownTool(toolName, toolInput);
  }
}

/** Plain-English label for a gated tool name, shown as a small tag next to each pending approval's headline. Unknown names are sanitized+capped (same provenance as any other stored-row field). */
const TOOL_LABELS: Record<string, string> = {
  create_issue: "Create issue",
  create_workspace: "Create workspace",
  create_repo: "Create repo",
  alignment_brief: "Alignment brief",
};

export function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? (sanitizeField(toolName, 100) || "(unknown tool)");
}

/** Plain-English label for a channel id, shown instead of a raw conversation key (names over IDs — there is no display-name join available on this query without new query work, see the recon annex; the channel name alone is the honest, always-available label). */
const CHANNEL_LABELS: Record<string, string> = {
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  imessage: "iMessage",
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? (sanitizeField(channel, 40) || "(unknown)");
}

/** The parked-row fields the alignment-lock predicate reads — a structural subset of `QueueEntryListItem` (not imported: see this file's header comment). */
export interface ParkedRowLockInput {
  kind: string;
  estimatedBudgetUsd: number | null;
  parkReason: string | null;
}

/**
 * Whether a parked queue entry is alignment-held — the ONE park kind whose
 * Requeue must render disabled (#1276 fix round, review C1): it resolves
 * EXCLUSIVELY through the posted brief's own Approve/Deny, never a raw
 * requeue, or the alignment gate #1274 built would be bypassed.
 *
 * MIRRORS `requeueParkedQueueEntry`'s server-side predicate EXACTLY (which
 * itself mirrors `unparkDependents`' aligned check — see that function's
 * doc-comment for the full rationale): a denial
 * (`alignmentDeniedParkReason`, passed down from the server page which
 * imports the real constant) is held unconditionally; otherwise held iff
 * `kind === 'issue'` AND no confirmed `estimatedBudgetUsd` AND the
 * workspace's `require_alignment` gate is on. NOT a parkReason string match
 * — a dependency/guardrail-parked row with a pending brief carries the
 * dependency/guardrail reason while still alignment-held.
 *
 * UI-side belt-and-suspenders only — the server route's own guarded query is
 * the real enforcement; this just keeps the page honest instead of offering
 * a button that 409s.
 */
export function isAlignmentLocked(
  row: ParkedRowLockInput,
  requireAlignment: boolean,
  alignmentDeniedParkReason: string
): boolean {
  if (row.parkReason === alignmentDeniedParkReason) return true;
  return row.kind === "issue" && row.estimatedBudgetUsd === null && requireAlignment;
}
