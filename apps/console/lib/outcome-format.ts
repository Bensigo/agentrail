/**
 * The run-outcome message TEMPLATE (#888 notify, #1277 replyable threads).
 *
 * `buildOutcomeMessage` is the ONE place the wire format for a terminal queue
 * outcome is composed; every outbound channel (the legacy Telegram/Discord
 * senders, the Jace handoff — see `apps/console/app/api/v1/runner/result/notify.ts`)
 * sends its exact output. `parseOutcomeIssueNumber` is its inverse: given a
 * Telegram reply's quoted `reply_to_message.text` (Telegram self-contains the
 * replied-to message on every reply), recover the issue number WE encoded —
 * strictly, anchored to our own template shape.
 *
 * Extracted out of `notify.ts` (#1277) as a PURE refactor: `notify.ts`
 * re-exports `buildOutcomeMessage`/`NotifyOutcome`/`NotifyParams` unchanged, and
 * the sent text is byte-identical (see notify.test.ts's pre-existing coverage
 * plus this module's own round-trip tests in outcome-format.test.ts).
 *
 * THREAT MODEL (#1277): `parseOutcomeIssueNumber` is the ONLY thing ever read
 * back out of a quoted reply's text — one integer, nothing else. Parsing is
 * FORMAT-only, not an authenticity check: anyone can type a lookalike
 * "AgentRail: ... — issue #N" message and reply to it, so a forged reply
 * parses just as successfully as a real one. That is by design and is safe
 * BECAUSE the number is only ever used for a WORKSPACE-SCOPED run lookup
 * (`latestRunForIssue` in `@agentrail/db-postgres`, called with the caller's
 * OWN resolved workspace — see `apps/console/lib/channel-dispatch.ts`) —
 * exactly what a human asking "why did issue #N fail?" in plain chat can
 * already do. Worst case for a forged reply is an honest "no matching run
 * found" in the caller's own workspace; nothing is trusted or disclosed
 * beyond that.
 */

export type NotifyOutcome = "green" | "escalated-to-human" | "blocked";

export interface OutcomeMessageParams {
  issueNumber: string;
  outcome: NotifyOutcome;
  prUrl?: string;
  costUsd?: number;
}

/** Run-Outcome headline for each terminal state (operator-facing wording). */
const OUTCOME_HEADLINE: Record<NotifyOutcome, string> = {
  green: "PR ready",
  "escalated-to-human": "Escalated to human",
  blocked: "Blocked",
};

/** Format a dollar cost, or "" when absent/non-finite. Mirrors the Py `_fmt_cost`. */
function fmtCost(costUsd: number | undefined): string {
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return "";
  return `$${costUsd.toFixed(2)}`;
}

/**
 * Build the one-line chat message. Pure + exported so it is unit-testable and
 * provider-agnostic (every gateway speaks the same Run-Outcome vocabulary).
 *
 * e.g. `AgentRail: PR ready — issue #42 (https://github.com/o/r/pull/9 · $1.20)`
 */
export function buildOutcomeMessage(params: OutcomeMessageParams): string {
  const headline = OUTCOME_HEADLINE[params.outcome];
  let line = `AgentRail: ${headline} — issue #${params.issueNumber}`;
  const extras: string[] = [];
  if (params.prUrl) extras.push(params.prUrl);
  const cost = fmtCost(params.costUsd);
  if (cost) extras.push(cost);
  if (extras.length) line = `${line} (${extras.join(" · ")})`;
  return line;
}

// Anchored to the EXACT skeleton `buildOutcomeMessage` emits: the literal
// "AgentRail: <headline> — issue #<digits>" marker, optionally followed by a
// "(...)" extras group, and NOTHING else. `\d+` is greedy, so a run of digits
// is always captured whole (issue #101 can never be mis-read as "10") — the
// anchoring here is about REJECTING near-misses (trailing junk, a non-numeric
// suffix, missing the em dash) rather than truncating a number; the DB-side
// exact-suffix match (`latestRunForIssue`) is the second, independent guard
// against a short issue number's LIKE pattern over-matching a longer one.
const OUTCOME_ISSUE_PATTERN = /^AgentRail: .+ — issue #(\d+)(?: \(.*\))?$/;

/**
 * Recover the issue number `buildOutcomeMessage` encoded into `text`, or
 * `null` if `text` doesn't match our exact template shape. Strict on purpose
 * (see the module threat-model note above) — this is the ONLY field ever
 * parsed back out of a quoted reply.
 */
export function parseOutcomeIssueNumber(text: string): number | null {
  const match = OUTCOME_ISSUE_PATTERN.exec(text.trim());
  if (!match) return null;
  const issueNumber = Number(match[1]);
  return Number.isSafeInteger(issueNumber) && issueNumber > 0 ? issueNumber : null;
}

/**
 * The #1277 reply-context marker attached to an inbound channel_inbox payload
 * (webhook-parsed, see `route.ts`'s `resolveReplyContext`) when a Telegram
 * reply's quoted text parses as a run-outcome message. Carries ONLY the
 * parsed issue number — never anything else read out of the quoted text.
 */
export interface RunOutcomeReplyContext {
  kind: "run_outcome";
  issueNumber: number;
}

/**
 * The server-built bracketed preface handed to Jace (`channel-dispatch.ts`)
 * when an inbound message carries a `RunOutcomeReplyContext`. `found` is
 * whatever the workspace-scoped `latestRunForIssue` query resolved — `null`
 * gets an HONEST "no matching run found" rather than a fabricated one (the
 * same honesty rule the triage subagent already follows for a degraded
 * lookup — see `apps/jace/agent/instructions.md`).
 */
export function buildRunOutcomeReplyPreface(
  issueNumber: number,
  found: { runId: string; state: string } | null
): string {
  const resolution = found
    ? `latest run: ${found.runId}, state: ${found.state}`
    : "no matching run found";
  return `[reply to the run-outcome notification for issue #${issueNumber} — ${resolution}]`;
}
