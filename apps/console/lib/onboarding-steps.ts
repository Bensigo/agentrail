/**
 * Pure step-derivation for the `/setup` onboarding wizard (three-step
 * rebuild — owner ruling, verbatim: "on the setup page it should be and all
 * optional: connect to github / invite team / message Jace that sent to
 * telegram — the rest is redundant. fix it").
 *
 * "Step completion is derived from data — no wizard-state table." This
 * module takes already-fetched signals (the route / server component does
 * all the I/O — mirrors the digest-helpers split, `digest/digest-helpers.ts`)
 * and decides each step's status. No I/O here, so it is fully unit-testable
 * without a database.
 *
 * **Every step is optional** — none of the three ever "blocks" anything.
 * `deriveOnboardingSteps` only ever returns `complete | incomplete | skipped`
 * per step, and `onboardingProgress`/`shouldShowOnboardingBanner` both treat
 * `skipped` exactly like `complete` ("nothing left for the user to do") —
 * skipping every step is a fully legitimate way to reach `allDone`. No step
 * may read as permanently, unskippably incomplete; each has its own
 * `skip-*` API route the wizard calls (see `onboarding-data.ts` for where
 * each skip is persisted).
 *
 * The three steps, in render order:
 *   1. Connect GitHub  — complete when the github connector has ≥1 repo AND
 *      a stored webhook secret (`connectors.config.webhookSecret`).
 *      Skippable; the skip is remembered on the github connector row's own
 *      jsonb config (`githubSkippedAt`).
 *   2. Invite your team — complete once the workspace has reached at least
 *      one teammate beyond the owner (a pending invite or an accepted one).
 *      Skippable; the skip piggybacks on the github connector row too
 *      (`inviteTeamSkippedAt` — invite-team has no connector of its own; see
 *      `onboarding-data.ts` / the schema doc-comment for why).
 *   3. Message Jace    — replaces BOTH of the old "Connect a channel" and
 *      "Say hi to Jace" steps; that split was the redundancy the owner
 *      ruling called out. Complete when the workspace has a linked chat
 *      identity for Telegram (`listChatIdentitiesForWorkspace` — a user
 *      DM'd the shared bot) OR Jace has ever replied in console chat
 *      (`hasAnyJaceReply`) — either one proves the user reached him.
 *      Skippable; the skip is remembered on the telegram connector row's
 *      jsonb config (`channelSkippedAt` — unchanged field name from the step
 *      this superseded, so an existing skip survives the rename).
 *
 * Removed outright: the old "Attach a runner" / Execution step. Hosted
 * execution has been the default for every workspace since the 2026-07-17
 * e2e cutover, so the step was vestigial — always-complete noise, never
 * actionable. There is nothing left for it to gate.
 */

export type OnboardingStepId = "connect-github" | "invite-team" | "message-jace";

export type OnboardingStepStatus = "complete" | "incomplete" | "skipped";

export interface OnboardingStep {
  id: OnboardingStepId;
  status: OnboardingStepStatus;
}

/** The fixed render order for the wizard and the banner — matches the owner
 * ruling's own numbered list (GitHub, team, Jace). */
export const ONBOARDING_STEP_ORDER: readonly OnboardingStepId[] = [
  "connect-github",
  "invite-team",
  "message-jace",
];

export const ONBOARDING_STEP_LABELS: Record<OnboardingStepId, string> = {
  "connect-github": "Connect GitHub",
  "invite-team": "Invite your team",
  // The owner's own words for this step (verbatim ruling) — it replaces the
  // old "Talk to Jace" / "Say hi to Jace" split.
  "message-jace": "Message Jace",
};

/** The signals every step's completion is derived from. Pure input — no I/O. */
export interface OnboardingStepsInput {
  github: {
    /** Repos configured on the workspace's github connector. */
    repoCount: number;
    /** Whether a webhook secret has been generated + stored for the connector. */
    hasWebhookSecret: boolean;
    /** The user explicitly chose "Skip for now" for this workspace. */
    skipped: boolean;
  };
  invites: {
    /** Teammates reached beyond the owner: pending invites + accepted members. */
    count: number;
    /** The user explicitly chose "Skip for now" for this workspace. */
    skipped: boolean;
  };
  messageJace: {
    /** A linked Telegram chat identity exists OR Jace has ever replied in
     * console chat — either proves the user reached him. */
    connected: boolean;
    /** The user explicitly chose "Skip for now" for this workspace. */
    skipped: boolean;
  };
}

/**
 * Derive each step's status from the input signals. Total and pure: the same
 * input always yields the same three statuses, in {@link ONBOARDING_STEP_ORDER}.
 * `connected`/count>0 always outranks `skipped` — completing a step after
 * skipping it reads as complete, not skipped, for all three steps alike.
 */
export function deriveOnboardingSteps(
  input: OnboardingStepsInput
): OnboardingStep[] {
  const statuses: Record<OnboardingStepId, OnboardingStepStatus> = {
    "connect-github":
      input.github.repoCount > 0 && input.github.hasWebhookSecret
        ? "complete"
        : input.github.skipped
          ? "skipped"
          : "incomplete",
    "invite-team":
      input.invites.count > 0
        ? "complete"
        : input.invites.skipped
          ? "skipped"
          : "incomplete",
    "message-jace": input.messageJace.connected
      ? "complete"
      : input.messageJace.skipped
        ? "skipped"
        : "incomplete",
  };

  return ONBOARDING_STEP_ORDER.map((id) => ({ id, status: statuses[id] }));
}

export interface OnboardingProgress {
  /** Steps that are complete or skipped — nothing left for the user to do. */
  done: number;
  total: number;
  /** True once every step is complete or skipped (none incomplete). */
  allDone: boolean;
}

/** Summarize a step list into the "X of N steps done" banner count. */
export function onboardingProgress(steps: OnboardingStep[]): OnboardingProgress {
  const done = steps.filter((s) => s.status !== "incomplete").length;
  return { done, total: steps.length, allDone: done === steps.length };
}

/**
 * Whether the Home progress banner should render. Pure — the banner component
 * itself stays a thin renderer; this is the one bit of logic worth unit
 * testing in isolation. Disappears once every step is complete OR skipped —
 * "all optional" means skipping all three is a legitimate way to get here,
 * not a state the banner should keep nagging about.
 */
export function shouldShowOnboardingBanner(steps: OnboardingStep[]): boolean {
  return !onboardingProgress(steps).allDone;
}
