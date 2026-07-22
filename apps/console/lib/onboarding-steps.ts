/**
 * Pure step-derivation for the `/setup` onboarding wizard (#1233, spec §5).
 *
 * "Step completion is derived from data — no wizard-state table." This module
 * takes already-fetched signals (the route / server component does all the
 * I/O — mirrors the digest-helpers split, `digest/digest-helpers.ts`) and
 * decides each step's status. No I/O here, so it is fully unit-testable
 * without a database.
 *
 * Steps (spec §5). Step ids below name the underlying mechanic;
 * `ONBOARDING_STEP_LABELS` is what the wizard/banner actually display and
 * reads chat-first (#1281) — the two are allowed to diverge (e.g. id
 * `connect-channel` / label "Talk to Jace", id `attach-runner` / label
 * "Execution"):
 *   1. Connect GitHub    — complete when the github connector has ≥1 repo AND
 *      a stored webhook secret (`connectors.config.webhookSecret`).
 *   2. Connect a channel — complete when Telegram has a stored credential;
 *      skippable, and the skip is remembered per workspace (also persisted on
 *      the telegram connector row's jsonb config — see `onboarding-data.ts`).
 *   3. Say hi to Jace    — ships with #1288 (console chat). Complete once
 *      `jace_messages` has ANY `role: "jace"` row for the workspace (a real
 *      reply happened, in ANY member's console thread — see
 *      `hasAnyJaceReply`). Distinct from step 2 ("Talk to Jace" — a channel
 *      is CONNECTED) — this step is "you actually said hi and Jace answered."
 *      `skipped` (not `incomplete`) whenever console chat is off for this
 *      workspace (`CONSOLE_CHAT_ENABLED`/allowlist) — the step must not sit
 *      permanently incomplete (blocking `onboardingProgress.allDone`
 *      forever) for a workspace the feature hasn't rolled out to yet.
 *   4. Invite your team  — complete once the workspace has reached at least
 *      one teammate beyond the owner (a pending invite or an accepted one).
 *   5. Attach a runner   — complete when the workspace has an execution path:
 *      hosted execution is enabled (the default for every workspace) or a
 *      self-hosted runner is actively polling (#1268,
 *      `workspaceHasExecutionPath`). The caller (`onboarding-data.ts`) also
 *      passes a `selfHosted` flag alongside this signal so the UI can say
 *      something honest about WHICH path is active — this pure module only
 *      needs the OR'd boolean to decide completion. The step's UI
 *      (`runner-step.tsx`) relocates the device-code form behind a
 *      "Self-hosting?" disclosure whenever hosted execution alone satisfies
 *      it, so a fresh workspace never sees an install form (#1281 AC1).
 */

export type OnboardingStepId =
  | "connect-github"
  | "connect-channel"
  | "say-hi-to-jace"
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
  "say-hi-to-jace",
  "invite-team",
  "attach-runner",
];

export const ONBOARDING_STEP_LABELS: Record<OnboardingStepId, string> = {
  "connect-github": "Connect GitHub",
  // Chat-first relabel (#1281): this step's own body already leads with the
  // shared-bot deep link, not a form — the label should say what the user
  // is doing (message Jace), not the plumbing underneath.
  "connect-channel": "Talk to Jace",
  "say-hi-to-jace": "Say hi to Jace",
  "invite-team": "Invite your team",
  // Chat-first relabel (#1281): hosted execution is the default for every
  // fresh workspace (see runner-step.tsx) — "Attach a runner" implied an
  // install step that most workspaces never need. "Execution" covers both
  // the hosted-done state and the self-host disclosure underneath it.
  "attach-runner": "Execution",
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
  chat: {
    /** Console chat (#1288) is rolled out for this workspace
     * (`CONSOLE_CHAT_ENABLED` / the per-workspace allowlist). */
    enabled: boolean;
    /** `hasAnyJaceReply` — a real `jace_messages` reply already exists. */
    jaceReplied: boolean;
  };
  invites: {
    /** Teammates reached beyond the owner: pending invites + accepted members. */
    count: number;
  };
  runner: {
    /** The workspace has an execution path: hosted execution enabled, or a
     * self-hosted runner actively polling (#1268). */
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
    "say-hi-to-jace": input.chat.jaceReplied
      ? "complete"
      : input.chat.enabled
        ? "incomplete"
        : "skipped",
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
