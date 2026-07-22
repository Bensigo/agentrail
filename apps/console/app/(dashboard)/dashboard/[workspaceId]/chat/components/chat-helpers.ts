/**
 * Pure client-side helpers for the console chat thread (#1288). No I/O — the
 * polling client (`chat-thread.tsx`) does the fetching; this is the one bit
 * of logic worth unit testing in isolation (mirrors this codebase's split
 * for every other pure derivation module, e.g. `onboarding-steps.ts`,
 * `budget/budget-helpers.ts`).
 */

export type ChatMessageRole = "user" | "jace";

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
