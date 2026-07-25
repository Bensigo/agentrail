import { describe, expect, it } from "vitest";
import {
  ONBOARDING_STEP_LABELS,
  ONBOARDING_STEP_ORDER,
  deriveOnboardingSteps,
  onboardingProgress,
  shouldShowOnboardingBanner,
  type OnboardingStepId,
  type OnboardingStepsInput,
} from "./onboarding-steps";

/** A baseline input where every step is incomplete. */
function baseInput(): OnboardingStepsInput {
  return {
    github: { repoCount: 0, hasWebhookSecret: false, skipped: false },
    invites: { count: 0, skipped: false },
    messageJace: { connected: false, skipped: false },
  };
}

describe("ONBOARDING_STEP_LABELS / ONBOARDING_STEP_ORDER (three-step rebuild)", () => {
  it("has exactly one label per step, in ONBOARDING_STEP_ORDER", () => {
    expect(Object.keys(ONBOARDING_STEP_LABELS).sort()).toEqual(
      [...ONBOARDING_STEP_ORDER].sort()
    );
  });

  it("is exactly three steps — connect-github, invite-team, message-jace, in that order (owner ruling's own numbered list)", () => {
    expect(ONBOARDING_STEP_ORDER).toEqual([
      "connect-github",
      "invite-team",
      "message-jace",
    ]);
  });

  it("never mentions a runner/execution step — that step was removed outright", () => {
    expect(ONBOARDING_STEP_ORDER).not.toContain("attach-runner");
    expect(Object.keys(ONBOARDING_STEP_LABELS)).not.toContain("attach-runner");
  });

  it("labels message-jace with the owner's own words", () => {
    expect(ONBOARDING_STEP_LABELS["message-jace"]).toBe("Message Jace");
  });
});

describe("deriveOnboardingSteps", () => {
  it("returns all three steps, in the fixed render order, incomplete on a fresh workspace", () => {
    const steps = deriveOnboardingSteps(baseInput());
    expect(steps.map((s) => s.id)).toEqual([...ONBOARDING_STEP_ORDER]);
    expect(steps.every((s) => s.status === "incomplete")).toBe(true);
  });

  // -- connect-github --------------------------------------------------------
  describe("connect-github", () => {
    it("is incomplete with no repos and no webhook secret", () => {
      const steps = deriveOnboardingSteps(baseInput());
      expect(steps.find((s) => s.id === "connect-github")!.status).toBe(
        "incomplete"
      );
    });

    it("is incomplete with repos but no webhook secret", () => {
      const input = baseInput();
      input.github = { repoCount: 2, hasWebhookSecret: false, skipped: false };
      const steps = deriveOnboardingSteps(input);
      expect(steps.find((s) => s.id === "connect-github")!.status).toBe(
        "incomplete"
      );
    });

    it("is incomplete with a webhook secret but zero repos (vacuous secret)", () => {
      const input = baseInput();
      input.github = { repoCount: 0, hasWebhookSecret: true, skipped: false };
      const steps = deriveOnboardingSteps(input);
      expect(steps.find((s) => s.id === "connect-github")!.status).toBe(
        "incomplete"
      );
    });

    it("is complete with ≥1 repo AND a webhook secret", () => {
      const input = baseInput();
      input.github = { repoCount: 1, hasWebhookSecret: true, skipped: false };
      const steps = deriveOnboardingSteps(input);
      expect(steps.find((s) => s.id === "connect-github")!.status).toBe(
        "complete"
      );
    });

    it("is skipped when not connected and skipped is true", () => {
      const input = baseInput();
      input.github = { repoCount: 0, hasWebhookSecret: false, skipped: true };
      const steps = deriveOnboardingSteps(input);
      expect(steps.find((s) => s.id === "connect-github")!.status).toBe(
        "skipped"
      );
    });

    it("connected outranks a stale skip flag (connect after skip → complete, not skipped)", () => {
      const input = baseInput();
      input.github = { repoCount: 1, hasWebhookSecret: true, skipped: true };
      const steps = deriveOnboardingSteps(input);
      expect(steps.find((s) => s.id === "connect-github")!.status).toBe(
        "complete"
      );
    });
  });

  // -- invite-team --------------------------------------------------------
  describe("invite-team", () => {
    it("is incomplete with zero teammates reached", () => {
      const steps = deriveOnboardingSteps(baseInput());
      expect(steps.find((s) => s.id === "invite-team")!.status).toBe(
        "incomplete"
      );
    });

    it("is complete with exactly one teammate reached", () => {
      const input = baseInput();
      input.invites = { count: 1, skipped: false };
      expect(
        deriveOnboardingSteps(input).find((s) => s.id === "invite-team")!
          .status
      ).toBe("complete");
    });

    it("is complete with many teammates reached", () => {
      const input = baseInput();
      input.invites = { count: 12, skipped: false };
      expect(
        deriveOnboardingSteps(input).find((s) => s.id === "invite-team")!
          .status
      ).toBe("complete");
    });

    it("is skipped when zero teammates reached and skipped is true", () => {
      const input = baseInput();
      input.invites = { count: 0, skipped: true };
      expect(
        deriveOnboardingSteps(input).find((s) => s.id === "invite-team")!
          .status
      ).toBe("skipped");
    });

    it("reaching a teammate outranks a stale skip flag", () => {
      const input = baseInput();
      input.invites = { count: 1, skipped: true };
      expect(
        deriveOnboardingSteps(input).find((s) => s.id === "invite-team")!
          .status
      ).toBe("complete");
    });
  });

  // -- message-jace (replaces connect-channel + say-hi-to-jace) ---------------
  describe("message-jace", () => {
    it("is incomplete when neither a linked chat identity nor a jace reply exists", () => {
      const steps = deriveOnboardingSteps(baseInput());
      expect(steps.find((s) => s.id === "message-jace")!.status).toBe(
        "incomplete"
      );
    });

    it("is skipped when not connected and skipped is true", () => {
      const input = baseInput();
      input.messageJace = { connected: false, skipped: true };
      const steps = deriveOnboardingSteps(input);
      expect(steps.find((s) => s.id === "message-jace")!.status).toBe(
        "skipped"
      );
    });

    it("is complete when connected (a linked identity OR a jace reply — folded into one boolean by the caller), regardless of skipped", () => {
      const input = baseInput();
      input.messageJace = { connected: true, skipped: false };
      expect(
        deriveOnboardingSteps(input).find((s) => s.id === "message-jace")!
          .status
      ).toBe("complete");
    });

    it("connected outranks a stale skip flag (connect after skip → complete, not skipped)", () => {
      const input = baseInput();
      input.messageJace = { connected: true, skipped: true };
      const steps = deriveOnboardingSteps(input);
      expect(steps.find((s) => s.id === "message-jace")!.status).toBe(
        "complete"
      );
    });
  });

  it("is total and deterministic — same input always yields the same output", () => {
    const input: OnboardingStepsInput = {
      github: { repoCount: 3, hasWebhookSecret: true, skipped: false },
      invites: { count: 2, skipped: false },
      messageJace: { connected: false, skipped: true },
    };
    const a = deriveOnboardingSteps(input);
    const b = deriveOnboardingSteps(input);
    expect(a).toEqual(b);
    expect(a).toEqual([
      { id: "connect-github", status: "complete" },
      { id: "invite-team", status: "complete" },
      { id: "message-jace", status: "skipped" },
    ]);
  });

  it("steps derive independently of one another (no cross-step coupling)", () => {
    const allComplete: OnboardingStepsInput = {
      github: { repoCount: 1, hasWebhookSecret: true, skipped: false },
      invites: { count: 1, skipped: false },
      messageJace: { connected: true, skipped: false },
    };
    // Flip exactly one signal at a time; only that step's status should move.
    const flips: Array<[Partial<OnboardingStepsInput>, OnboardingStepId]> = [
      [
        { github: { repoCount: 0, hasWebhookSecret: true, skipped: false } },
        "connect-github",
      ],
      [{ invites: { count: 0, skipped: false } }, "invite-team"],
      [
        { messageJace: { connected: false, skipped: false } },
        "message-jace",
      ],
    ];
    for (const [patch, expectedFlippedId] of flips) {
      const input = { ...allComplete, ...patch };
      const steps = deriveOnboardingSteps(input);
      for (const step of steps) {
        if (step.id === expectedFlippedId) {
          expect(step.status).not.toBe("complete");
        } else {
          expect(step.status).toBe("complete");
        }
      }
    }
  });
});

describe("onboardingProgress", () => {
  it("counts complete + skipped as done, incomplete as not done", () => {
    const steps = deriveOnboardingSteps({
      github: { repoCount: 1, hasWebhookSecret: true, skipped: false }, // complete
      invites: { count: 0, skipped: true }, // skipped
      messageJace: { connected: false, skipped: false }, // incomplete
    });
    const progress = onboardingProgress(steps);
    expect(progress).toEqual({ done: 2, total: 3, allDone: false });
  });

  it("allDone is true once nothing is incomplete (mix of complete + skipped)", () => {
    const steps = deriveOnboardingSteps({
      github: { repoCount: 1, hasWebhookSecret: true, skipped: false },
      invites: { count: 0, skipped: true },
      messageJace: { connected: true, skipped: false },
    });
    expect(onboardingProgress(steps)).toEqual({
      done: 3,
      total: 3,
      allDone: true,
    });
  });

  it("allDone is true when EVERY step is skipped — all-optional means this is legitimate, not a degraded state", () => {
    const steps = deriveOnboardingSteps({
      github: { repoCount: 0, hasWebhookSecret: false, skipped: true },
      invites: { count: 0, skipped: true },
      messageJace: { connected: false, skipped: true },
    });
    expect(onboardingProgress(steps)).toEqual({
      done: 3,
      total: 3,
      allDone: true,
    });
  });

  it("allDone is false when even one step is incomplete", () => {
    const steps = deriveOnboardingSteps({
      github: { repoCount: 1, hasWebhookSecret: true, skipped: false },
      invites: { count: 3, skipped: false },
      messageJace: { connected: false, skipped: false },
    });
    expect(onboardingProgress(steps).allDone).toBe(false);
  });

  it("a fresh workspace has zero done of three", () => {
    const steps = deriveOnboardingSteps({
      github: { repoCount: 0, hasWebhookSecret: false, skipped: false },
      invites: { count: 0, skipped: false },
      messageJace: { connected: false, skipped: false },
    });
    expect(onboardingProgress(steps)).toEqual({
      done: 0,
      total: 3,
      allDone: false,
    });
  });
});

describe("shouldShowOnboardingBanner", () => {
  it("shows the banner when any step is incomplete", () => {
    const steps = deriveOnboardingSteps({
      github: { repoCount: 1, hasWebhookSecret: true, skipped: false },
      invites: { count: 1, skipped: false },
      messageJace: { connected: false, skipped: false },
    });
    expect(shouldShowOnboardingBanner(steps)).toBe(true);
  });

  it("hides the banner once every step is complete", () => {
    const steps = deriveOnboardingSteps({
      github: { repoCount: 1, hasWebhookSecret: true, skipped: false },
      invites: { count: 1, skipped: false },
      messageJace: { connected: true, skipped: false },
    });
    expect(shouldShowOnboardingBanner(steps)).toBe(false);
  });

  it("hides the banner when the only remaining steps are skipped, not incomplete", () => {
    const steps = deriveOnboardingSteps({
      github: { repoCount: 0, hasWebhookSecret: false, skipped: true },
      invites: { count: 1, skipped: false },
      messageJace: { connected: false, skipped: true },
    });
    expect(shouldShowOnboardingBanner(steps)).toBe(false);
  });

  it("hides the banner when the workspace skipped all three steps — never implies the product is unusable", () => {
    const steps = deriveOnboardingSteps({
      github: { repoCount: 0, hasWebhookSecret: false, skipped: true },
      invites: { count: 0, skipped: true },
      messageJace: { connected: false, skipped: true },
    });
    expect(shouldShowOnboardingBanner(steps)).toBe(false);
  });

  it("shows the banner on a completely fresh workspace", () => {
    const steps = deriveOnboardingSteps({
      github: { repoCount: 0, hasWebhookSecret: false, skipped: false },
      invites: { count: 0, skipped: false },
      messageJace: { connected: false, skipped: false },
    });
    expect(shouldShowOnboardingBanner(steps)).toBe(true);
  });
});
