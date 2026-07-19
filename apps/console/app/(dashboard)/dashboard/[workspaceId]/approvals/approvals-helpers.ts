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
 * come from that package (the two alignment park-reason constants below),
 * the SERVER component (`page.tsx`) imports the real constant and passes it
 * down as a plain string/array prop instead.
 */

/**
 * Whether a parked queue entry's `parkReason` is an alignment hold — the
 * ONE park kind that must never offer a raw Requeue action (#1276 PR ②): it
 * resolves EXCLUSIVELY through the posted brief's own Approve/Deny, never a
 * requeue, or the alignment gate #1274 built would be bypassed.
 * Parameterized on `alignmentParkReasons` rather than importing
 * `ALIGNMENT_PARK_REASON`/`ALIGNMENT_DENIED_PARK_REASON` directly (see this
 * file's header comment for why) — `page.tsx` is the single place that
 * actually imports those two real constants and passes them down, so this
 * can still never drift from what the gate itself writes, just via a prop
 * instead of a module import. This is UI-side belt-and-suspenders only —
 * `requeueParkedQueueEntry`'s own `WHERE` clause is the real,
 * server-enforced gate (see that function's doc-comment).
 */
export function isAlignmentParkReason(
  parkReason: string | null,
  alignmentParkReasons: readonly string[]
): boolean {
  return parkReason !== null && alignmentParkReasons.includes(parkReason);
}

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

/** Hard-cap a string at `maxLen`, appending an ellipsis marker when cut — used for `lastError` on dead letters, which can carry an arbitrarily long stack trace/message. Never throws on a non-string (coerces defensively, the same posture `approval-message.ts`'s own sanitizer takes for untrusted jsonb-sourced values). */
export function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}…`;
}

export interface ApprovalSummaryField {
  label: string;
  value: string;
}

/** What the page renders for one pending approval: a headline (the thing being approved) plus zero or more secondary fields. Mirrors `approval-message.ts`'s per-tool dispatch and field choices (same underlying data, same "never throw on a malformed toolInput" posture) but returns STRUCTURED data instead of a formatted text blob — this is a React-rendered list item, not a chat message, so there's no reason to flatten to text first. */
export interface ApprovalSummary {
  headline: string;
  fields: ApprovalSummaryField[];
}

/** Cap on how many `toolInput` keys the unknown-tool fallback renders — same rationale and same number as `approval-message.ts`'s `GENERIC_FALLBACK_MAX_KEYS`: a wide/adversarial object could otherwise bury the useful bit under key noise. */
const GENERIC_FALLBACK_MAX_FIELDS = 12;

/** Coerce an untrusted `toolInput` value to a displayable string. Non-strings are JSON-stringified; a circular/unstringifiable value falls back to `String(value)` rather than throwing. */
function asDisplayString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

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
  const title = typeof value["title"] === "string" ? value["title"] : null;
  const estimateUsd =
    typeof value["estimateUsd"] === "number" && Number.isFinite(value["estimateUsd"])
      ? value["estimateUsd"]
      : null;
  if (title === null && estimateUsd === null) return null;
  const parts: string[] = [];
  if (title) parts.push(title);
  if (estimateUsd !== null) parts.push(`~$${estimateUsd.toFixed(2)}`);
  return parts.join(" — ");
}

function summarizeCreateIssue(input: Record<string, unknown>): ApprovalSummary {
  const headline = asDisplayString(input["title"]).trim() || "(untitled)";
  const fields: ApprovalSummaryField[] = [];
  const brief = tolerantBriefSummary(input["_brief"]);
  if (brief) fields.push({ label: "Brief", value: brief });
  return { headline, fields };
}

function summarizeCreateWorkspace(input: Record<string, unknown>): ApprovalSummary {
  const headline = asDisplayString(input["name"]).trim() || "(unnamed)";
  return { headline, fields: [] };
}

function summarizeCreateRepo(input: Record<string, unknown>): ApprovalSummary {
  const headline = asDisplayString(input["name"]).trim() || "(unnamed)";
  // Mirrors approval-message.ts's renderCreateRepo: `private` omitted defaults
  // to private, so anything other than the literal `false` renders as private.
  const isPrivate = input["private"] !== false;
  return {
    headline,
    fields: [{ label: "Visibility", value: isPrivate ? "Private" : "Public" }],
  };
}

/** Mirrors `approval-message.ts`'s `renderAlignmentBrief` field selection (task type, suggested model, estimate) — same content, React-structured. */
function summarizeAlignmentBrief(input: Record<string, unknown>): ApprovalSummary {
  const headline = asDisplayString(input["title"]).trim() || "(untitled)";
  const fields: ApprovalSummaryField[] = [];

  const taskType = asDisplayString(input["taskType"]).trim();
  const suggestedModel = input["suggestedModel"];
  const suggestedModelDisplayName = isPlainObject(suggestedModel)
    ? asDisplayString(suggestedModel["displayName"]).trim()
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

/** Unknown tool: toolName-derived headline + compact key:value fields — the React-side analog of `approval-message.ts`'s `renderGenericFallback`, same graceful-degradation posture (never fails closed on a tool this file doesn't know about yet). */
function summarizeUnknownTool(
  toolName: string,
  input: Record<string, unknown>
): ApprovalSummary {
  const entries = Object.entries(input).slice(0, GENERIC_FALLBACK_MAX_FIELDS);
  const omitted = Object.entries(input).length - entries.length;
  const fields: ApprovalSummaryField[] = entries.map(([key, value]) => ({
    label: key,
    value: asDisplayString(value),
  }));
  if (omitted > 0) {
    fields.push({ label: "", value: `…and ${omitted} more` });
  }
  return { headline: toolName || "(unknown tool)", fields };
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

/** Plain-English label for a gated tool name, shown as a small tag next to each pending approval's headline. */
const TOOL_LABELS: Record<string, string> = {
  create_issue: "Create issue",
  create_workspace: "Create workspace",
  create_repo: "Create repo",
  alignment_brief: "Alignment brief",
};

export function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName;
}

/** Plain-English label for a channel id, shown instead of a raw conversation key (names over IDs — there is no display-name join available on this query without new query work, see the recon annex; the channel name alone is the honest, always-available label). */
const CHANNEL_LABELS: Record<string, string> = {
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  imessage: "iMessage",
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}
