/**
 * Pure client-side helpers for the console chat thread (#1288). No I/O — the
 * polling client (`chat-thread.tsx`) does the fetching; this is the one bit
 * of logic worth unit testing in isolation (mirrors this codebase's split
 * for every other pure derivation module, e.g. `onboarding-steps.ts`,
 * `budget/budget-helpers.ts`).
 */

export type ChatMessageRole = "user" | "jace";

/**
 * One console chat thread in the history list (#1288 sessions UI) — the wire
 * shape of `GET /api/v1/workspaces/:workspaceId/chat/threads` (snake_case,
 * every console route's convention). A thread is a distinct `n` in this
 * member's `console:<userId>:<n>` family.
 */
export interface ChatThreadSummary {
  n: number;
  title: string;
  last_message_at: string;
  message_count: number;
}

/**
 * The `n` a "New chat" should use: one past the highest existing thread, or 1
 * when the member has none yet. A brand-new thread lives only as client state
 * (it isn't in `threads` until its first message materializes a row) — this is
 * what lets the ＋ affordance open an empty thread without a write, matching
 * ChatGPT (an empty new chat isn't in history yet).
 */
export function nextThreadN(threads: readonly ChatThreadSummary[]): number {
  return threads.reduce((max, t) => Math.max(max, t.n), 0) + 1;
}

/**
 * Compact relative time for the history list ("just now", "5m", "3h", "2d",
 * else a short date). Pure so it unit-tests without a clock; `now` defaults to
 * the current time. A future/invalid timestamp falls back to "just now" rather
 * than showing a negative age.
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diffMs = now.getTime() - then;
  if (diffMs < 0) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export interface ChatMessage {
  id: string;
  seq: number;
  role: ChatMessageRole;
  text: string;
  created_at: string;
}

export interface ChatApproval {
  id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  created_at: string;
}

/**
 * Merge a poll's `incoming` messages into `existing`, de-duplicating by
 * `seq` (a re-poll can legitimately re-send a message the client already
 * has — e.g. a retried request) and keeping the result ascending by `seq` so
 * the thread always reads top-to-bottom, oldest first.
 */
export function mergeChatMessages(
  existing: ChatMessage[],
  incoming: ChatMessage[]
): ChatMessage[] {
  const bySeq = new Map(existing.map((m) => [m.seq, m]));
  for (const m of incoming) bySeq.set(m.seq, m);
  return Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
}

/** The `after_seq` cursor for the NEXT poll: the highest `seq` rendered so far, or 0 for a fresh thread. */
export function highestSeq(messages: ChatMessage[]): number {
  return messages.reduce((max, m) => Math.max(max, m.seq), 0);
}

/**
 * Whether the thread should show the "Jace is working…" pending affordance
 * (#1288 chat rework — the current complaint this fixes: the POST returns
 * before Jace replies, and the reply only arrives via the next poll, so
 * without this the UI looks frozen for however long that turn takes).
 *
 * Deliberately simple, relying on the two invariants this module's other
 * helpers already establish: `messages` is always ascending by `seq`
 * (`mergeChatMessages`'s own contract), and a pending approval IS Jace's
 * response for that turn (a gated tool call awaiting a decision) — so
 * `approvals.length > 0` means Jace already responded, never "still
 * thinking". Awaiting is therefore exactly: no pending approvals, AND the
 * last message in the thread is the member's own (nothing from Jace has
 * landed after it yet).
 */
export function isAwaitingReply(messages: ChatMessage[], approvals: ChatApproval[]): boolean {
  if (approvals.length > 0) return false;
  const last = messages[messages.length - 1];
  return last?.role === "user";
}

export type GithubLinkKind = "pull" | "issue" | "file";

export interface GithubLinkInfo {
  kind: GithubLinkKind;
  owner: string;
  repo: string;
  /** Set for `pull`/`issue` — the PR or issue number. */
  number?: string;
  /** Set for `file` — the path within the repo (after `/blob/<ref>/`). */
  path?: string;
  /** Set for `file` — `path`'s last segment, the chip's display label. */
  filename?: string;
}

const GITHUB_PR_ISSUE_RE =
  /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)(?:[/?#].*)?$/;
const GITHUB_BLOB_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/blob\/[^/]+\/(.+)$/;

/**
 * Recognize a GitHub PR / issue / file-blob URL so the link renderer can show
 * a rich chip (icon + `owner/repo#123` or filename) instead of a raw URL —
 * `ui-prefer-names-over-ids` house rule. Returns `null` for anything else
 * (including github.com URLs of other shapes), which the renderer treats as
 * a plain styled link — this function only ever narrows, never guesses.
 */
export function parseGithubLink(href: string): GithubLinkInfo | null {
  const prIssue = GITHUB_PR_ISSUE_RE.exec(href);
  if (prIssue) {
    const [, owner, repo, kindRaw, number] = prIssue;
    return { kind: kindRaw === "pull" ? "pull" : "issue", owner: owner!, repo: repo!, number };
  }

  const blob = GITHUB_BLOB_RE.exec(href);
  if (blob) {
    const [, owner, repo, path] = blob;
    const filename = path!.split("/").pop() || path!;
    return { kind: "file", owner: owner!, repo: repo!, path, filename };
  }

  return null;
}

/**
 * Goal-stamp convention from `schema/goals.ts` ("Goal: <objective>
 * (goal:<slug>)", embedded in filed issue bodies) — slugs are
 * lowercase-hyphenated (`goals/route.ts`'s own `slugify`), so this is a
 * narrow, deliberately conservative match: it only ever fires on that exact
 * stamp shape, never on arbitrary parenthesized text.
 */
const GOAL_STAMP_RE = /\(goal:([a-z0-9-]+)\)/gi;

/**
 * The sentinel href prefix a linkified goal reference resolves to — a
 * relative-looking PATH, deliberately NOT a custom URI scheme (no
 * `goal://`): `react-markdown`'s default `urlTransform`
 * (`defaultUrlTransform`, react-markdown's own security default) only
 * allows a fixed protocol allowlist (`http(s)`, `irc(s)`, `mailto`, `xmpp`)
 * and silently rewrites anything that LOOKS like an unrecognized protocol
 * (a colon before the first `/`/`?`/`#`) down to an empty string — which
 * `chat-markdown.tsx`'s `a` override would then render as plain, unlinked
 * text. A string with no colon before its first `/` reads as relative, so
 * `defaultUrlTransform` passes it through untouched. (Caught live: an
 * earlier `goal://<slug>` version rendered as bare text in the browser —
 * see this PR's own verification notes.)
 */
export const GOAL_REFERENCE_HREF_PREFIX = "/__goal_ref__/";

/**
 * Rewrite any `(goal:<slug>)` stamp in Jace's raw markdown text into a
 * sentinel markdown link (`GOAL_REFERENCE_HREF_PREFIX<slug>`) BEFORE handing
 * the text to the markdown renderer — this lets every "special renderable
 * reference" (GitHub links, goal references) flow through the ONE
 * link-rendering path (`chat-markdown.tsx`'s `a` component override)
 * instead of adding a second, bespoke text-scanning renderer. The link's own
 * visible text is never shown (the renderer recomputes the chip's label
 * from the href), so what's substituted here doesn't matter beyond being
 * non-empty.
 */
export function linkifyGoalReferences(text: string): string {
  return text.replace(
    GOAL_STAMP_RE,
    (_match, slug: string) => `[Goal: ${slug}](${GOAL_REFERENCE_HREF_PREFIX}${slug})`
  );
}
