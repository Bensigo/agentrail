/**
 * Content for the landing page's conversation demo (#1279 PR ①, controller
 * ruling "The demo: replace _dashboard-demo.tsx with a chat-conversation
 * component"). The example task below is illustrative — this exact
 * conversation did not happen — but every NUMBER in it is real: the task
 * type, suggested model, and dollar estimate are the actual output of
 * `estimateBrief` (`../../lib/alignment`, #1275), and the run-outcome ping is
 * the actual output of `buildOutcomeMessage` (`../../lib/outcome-format`,
 * #888/#1277) for a fixed set of demo params. Nothing here is hand-typed
 * into the rendered copy — `_conversation-demo-data.test.ts` re-derives both
 * independently from the same real functions and asserts equality, so a
 * future edit that swaps a live call for a hardcoded literal fails loudly.
 *
 * No fabricated humans, no fake dashboards, no invented metrics (controller
 * ruling) — see `_conversation-demo.tsx` for how this renders.
 */

import { estimateBrief } from "../../lib/alignment";
import type { BriefEstimate } from "../../lib/alignment";
import { buildOutcomeMessage } from "../../lib/outcome-format";

/** The illustrative task a visitor might message Jace about. */
export const DEMO_USER_MESSAGE =
  "Webhook deliveries are dropping silently on a transient 5xx. Can you add a retry with backoff?";

/**
 * The `{title, whatToBuild, acceptanceCriteria}` shape `estimateBrief` (and,
 * in the real chat-born flow, `composeChatBornBrief` — `../../lib/alignment-brief.ts`)
 * consumes. Deliberately ordinary: no keyword-gaming to land on a specific
 * task type — whatever `classifyTaskType` (`../../lib/alignment/classifier.ts`)
 * actually returns for this text is what renders.
 */
export const DEMO_TASK_INPUT = {
  title: "Retry webhook delivery with backoff",
  whatToBuild:
    "Webhook POSTs to customer endpoints fail silently on a transient 5xx and we never retry. Add exponential backoff (3 attempts) before marking a delivery failed, and log each attempt for the failures view.",
  acceptanceCriteria: [
    "Failed deliveries retry up to 3 times with exponential backoff",
    "A success on any retry marks the delivery complete",
    "Exhausted retries mark the delivery failed and show up in Failures",
  ],
};

/** The real, live-computed alignment brief for {@link DEMO_TASK_INPUT}. */
export function getDemoBrief(): BriefEstimate {
  return estimateBrief(DEMO_TASK_INPUT);
}

/** Illustrative issue number and PR url this fixed demo transcript uses. */
export const DEMO_ISSUE_NUMBER = "482";
export const DEMO_PR_URL = "https://github.com/acme/webhooks/pull/128";

/**
 * The real run-outcome ping text, via the actual wire-format builder.
 * `merged: false` deliberately shows the DEFAULT posture: merge permission
 * is off unless the owner opts in (`workspaces.merge_permission` defaults
 * `false`), so the ping reads "PR ready" and the human merges — matching
 * the page's own "nothing merges without you". A `merged: true` variant
 * exists (#1278 PR②, the opt-in the how-we-work-together section
 * describes), but the demo must never imply merge-on-approve is the
 * default (review fix round, 2026-07-19). Cost reuses the SAME estimate
 * the brief quoted — this run landed within its own budget.
 *
 * CONTROLLER RULING (2026-07-19): the "AgentRail:" wire prefix this line
 * renders is ACCEPTED on the otherwise Jace-branded page — the
 * byte-identical-to-real-product rule wins over the branding rule for this
 * one line. Do not "fix" it.
 */
export function getDemoOutcomeMessage(): string {
  const brief = getDemoBrief();
  return buildOutcomeMessage({
    issueNumber: DEMO_ISSUE_NUMBER,
    outcome: "green",
    prUrl: DEMO_PR_URL,
    costUsd: brief.estimateUsd,
    merged: false,
  });
}
