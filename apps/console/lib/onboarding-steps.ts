/**
 * Pure step-derivation for the `/setup` onboarding wizard (#1233, spec §5).
 *
 * "Step completion is derived from data — no wizard-state table." This module
 * takes already-fetched signals (the route / server component does all the
 * I/O — mirrors the digest-helpers split, `digest/digest-helpers.ts`) and
 * decides each step's status. No I/O here, so it is fully unit-testable
 * without a database.
 *
 * Steps (spec §5, step 3 "Say hi to Jace" ships with ⑦ console chat — omitted
 * here):
 *   1. Connect GitHub    — complete when the github connector has ≥1 repo AND
 *      a stored webhook secret (`connectors.config.webhookSecret`).
 *   2. Connect a channel — complete when Telegram has a stored credential;
 *      skippable, and the skip is remembered per workspace (also persisted on
 *      the telegram connector row's jsonb config — see `onboarding-data.ts`).
 *   4. Invite your team  — complete once the workspace has reached at least
 *      one teammate beyond the owner (a pending invite or an accepted one).
 *   5. Attach a runner   — complete when a runner is actively polling
 *      (`hasActiveRunner`).
 */

export type OnboardingStepId =
  | "connect-github"
  | "connect-channel"
  | "invite-team"
  | "attach-runner";

export type OnboardingStepStatus = "complete" | "incomplete" | "skipped";

export interface OnboardingStep {
  id: OnboardingStepId;
  status: OnboardingStepStatus;
}

/** The fixed render order for the wizard and the banner. */
export const ONBOARDING_STEP_ORDER: readonly OnboardingStepId[] = [
  "connect-github",
  "connect-channel",
  "invite-team",
  "attach-runner",
];

export const ONBOARDING_STEP_LABELS: Record<OnboardingStepId, string> = {
  "connect-github": "Connect GitHub",
  "connect-channel": "Connect a channel",
  "invite-team": "Invite your team",
  "attach-runner": "Attach a runner",
};

/** The signals every step's completion is derived from. Pure input — no I/O. */
export interface OnboardingStepsInput {
  github: {
    /** Repos configured on the workspace's github connector. */
    repoCount: number;
    /** Whether a webhook secret has been generated + stored for the connector. */
    hasWebhookSecret: boolean;
  };
  channel: {
    /** A channel (Telegram) credential is stored for the workspace. */
    connected: boolean;
    /** The user explicitly chose "Skip for now" for this workspace. */
    skipped: boolean;
  };
  invites: {
    /** Teammates reached beyond the owner: pending invites + accepted members. */
    count: number;
  };
  runner: {
    /** A self-hosted runner is actively polling this workspace. */
    connected: boolean;
  };
}

/**
 * Derive each step's status from the input signals. Total and pure: the same
 * input always yields the same four statuses, in {@link ONBOARDING_STEP_ORDER}.
 * `connected` always outranks `skipped` — a channel that gets connected after
 * being skipped reads as complete, not skipped.
 */
export function deriveOnboardingSteps(
  input: OnboardingStepsInput
): OnboardingStep[] {
  const statuses: Record<OnboardingStepId, OnboardingStepStatus> = {
    "connect-github":
      input.github.repoCount > 0 && input.github.hasWebhookSecret
        ? "complete"
        : "incomplete",
    "connect-channel": input.channel.connected
      ? "complete"
      : input.channel.skipped
        ? "skipped"
        : "incomplete",
    "invite-team": input.invites.count > 0 ? "complete" : "incomplete",
    "attach-runner": input.runner.connected ? "complete" : "incomplete",
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
 * testing in isolation (spec §5: "Incomplete steps show as a progress banner
 * on Home … disappears when all steps complete or are skipped").
 */
export function shouldShowOnboardingBanner(steps: OnboardingStep[]): boolean {
  return !onboardingProgress(steps).allDone;
}
