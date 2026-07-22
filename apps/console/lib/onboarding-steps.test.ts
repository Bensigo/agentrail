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

/** A baseline input where every step is incomplete (chat enabled, no reply yet). */
function baseInput(): OnboardingStepsInput {
  return {
    github: { repoCount: 0, hasWebhookSecret: false },
    channel: { connected: false, skipped: false },
    chat: { enabled: true, jaceReplied: false },
    invites: { count: 0 },
    runner: { connected: false },
  };
}

describe("ONBOARDING_STEP_LABELS (#1281 chat-first relabel)", () => {
  it("still has exactly one label per step, in ONBOARDING_STEP_ORDER, with no step added/removed", () => {
    expect(Object.keys(ONBOARDING_STEP_LABELS).sort()).toEqual(
      [...ONBOARDING_STEP_ORDER].sort()
    );
  });

  it("relabels connect-channel to the chat-first 'Talk to Jace'", () => {
    expect(ONBOARDING_STEP_LABELS["connect-channel"]).toBe("Talk to Jace");
  });

  it("labels say-hi-to-jace (#1288)", () => {
    expect(ONBOARDING_STEP_LABELS["say-hi-to-jace"]).toBe("Say hi to Jace");
  });

  it("relabels attach-runner to 'Execution', not the old install-first wording", () => {
    expect(ONBOARDING_STEP_LABELS["attach-runner"]).toBe("Execution");
    expect(ONBOARDING_STEP_LABELS["attach-runner"]).not.toMatch(/runner/i);
  });

  it("say-hi-to-jace sits 3rd, attach-runner ('Execution') sits 5th — spec §5 ordering, five steps total", () => {
    expect(ONBOARDING_STEP_ORDER[2]).toBe("say-hi-to-jace");
    expect(ONBOARDING_STEP_ORDER[4]).toBe("attach-runner");
    expect(ONBOARDING_STEP_ORDER).toHaveLength(5);
  });
});

describe("deriveOnboardingSteps", () => {
  it("returns all five steps, in the fixed render order, incomplete on a fresh (chat-enabled) workspace", () => {
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
      input.github = { repoCount: 2, hasWebhookSecret: false };
      const steps = deriveOnboardingSteps(input);
      expect(steps.find((s) => s.id === "connect-github")!.status).toBe(
        "incomplete"
      );
    });

    it("is incomplete with a webhook secret but zero repos (vacuous secret)", () => {
      const input = baseInput();
      input.github = { repoCount: 0, hasWebhookSecret: true };
      const steps = deriveOnboardingSteps(input);
      expect(steps.find((s) => s.id === "connect-github")!.status).toBe(
        "incomplete"
      );
    });

    it("is complete with ≥1 repo AND a webhook secret", () => {
      const input = baseInput();
      input.github = { repoCount: 1, hasWebhookSecret: true };
      const steps = deriveOnboardingSteps(input);
      expect(steps.find((s) => s.id === "connect-github")!.status).toBe(
        "complete"
      );
    });

    it("is never skippable — no skip state exists in the input shape", () => {
      // Type-level guarantee: OnboardingStepsInput["github"] carries no
      // skip field, so this is exercised via the exhaustive status checks
      // above (only "complete" | "incomplete" ever appear for this step).
      const input = baseInput();
      input.github = { repoCount: 5, hasWebhookSecret: false };
      const steps = deriveOnboardingSteps(input);
      expect(steps.find((s) => s.id === "connect-github")!.status).not.toBe(
        "skipped"
      );
    });
  });

  // -- connect-channel --------------------------------------------------------
  describe("connect-channel", () => {
    it("is incomplete when not connected and not skipped", () => {
      const steps = deriveOnboardingSteps(baseInput());
      expect(steps.find((s) => s.id === "connect-channel")!.status).toBe(
        "incomplete"
      );
    });

    it("is skipped when not connected and skipped is true", () => {
      const input = baseInput();
      input.channel = { connected: false, skipped: true };
      const steps = deriveOnboardingSteps(input);
      expect(steps.find((s) => s.id === "connect-channel")!.status).toBe(
        "skipped"
      );
    });

    it("is complete when connected, regardless of skipped", () => {
      const input = baseInput();
      input.channel = { connected: true, skipped: false };
      expect(
        deriveOnboardingSteps(input).find((s) => s.id === "connect-channel")!
          .status
      ).toBe("complete");
    });

    it("connected outranks a stale skip flag (connect after skip → complete, not skipped)", () => {
      const input = baseInput();
      input.channel = { connected: true, skipped: true };
      const steps = deriveOnboardingSteps(input);
      expect(steps.find((s) => s.id === "connect-channel")!.status).toBe(
        "complete"
      );
    });
  });

  // -- say-hi-to-jace (#1288) --------------------------------------------------
  describe("say-hi-to-jace", () => {
    it("is incomplete when chat is enabled but Jace hasn't replied yet", () => {
      const input = baseInput();
      input.chat = { enabled: true, jaceReplied: false };
      const steps = deriveOnboardingSteps(input);
      expect(steps.find((s) => s.id === "say-hi-to-jace")!.status).toBe(
        "incomplete"
      );
    });

    it("is complete once a jace_messages reply exists", () => {
      const input = baseInput();
      input.chat = { enabled: true, jaceReplied: true };
      const steps = deriveOnboardingSteps(input);
      expect(steps.find((s) => s.id === "say-hi-to-jace")!.status).toBe(
        "complete"
      );
    });

    it("is skipped (not incomplete) when console chat is not enabled for this workspace — never permanently blocks allDone", () => {
      const input = baseInput();
      input.chat = { enabled: false, jaceReplied: false };
      const steps = deriveOnboardingSteps(input);
      expect(steps.find((s) => s.id === "say-hi-to-jace")!.status).toBe(
        "skipped"
      );
    });

    it("a reply outranks the flag being off (jaceReplied always wins, even if enabled somehow flips back false later)", () => {
      const input = baseInput();
      input.chat = { enabled: false, jaceReplied: true };
      const steps = deriveOnboardingSteps(input);
      expect(steps.find((s) => s.id === "say-hi-to-jace")!.status).toBe(
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
      input.invites = { count: 1 };
      expect(
        deriveOnboardingSteps(input).find((s) => s.id === "invite-team")!
          .status
      ).toBe("complete");
    });

    it("is complete with many teammates reached", () => {
      const input = baseInput();
      input.invites = { count: 12 };
      expect(
        deriveOnboardingSteps(input).find((s) => s.id === "invite-team")!
          .status
      ).toBe("complete");
    });

    it("is never skippable", () => {
      const input = baseInput();
      input.invites = { count: 0 };
      expect(
        deriveOnboardingSteps(input).find((s) => s.id === "invite-team")!
          .status
      ).not.toBe("skipped");
    });
  });

  // -- attach-runner --------------------------------------------------------
  describe("attach-runner", () => {
    it("is incomplete when no runner is connected", () => {
      const steps = deriveOnboardingSteps(baseInput());
      expect(steps.find((s) => s.id === "attach-runner")!.status).toBe(
        "incomplete"
      );
    });

    it("is complete when a runner is connected", () => {
      const input = baseInput();
      input.runner = { connected: true };
      expect(
        deriveOnboardingSteps(input).find((s) => s.id === "attach-runner")!
          .status
      ).toBe("complete");
    });

    it("is never skippable", () => {
      const steps = deriveOnboardingSteps(baseInput());
      expect(steps.find((s) => s.id === "attach-runner")!.status).not.toBe(
        "skipped"
      );
    });
  });

  it("is total and deterministic — same input always yields the same output", () => {
    const input: OnboardingStepsInput = {
      github: { repoCount: 3, hasWebhookSecret: true },
      channel: { connected: false, skipped: true },
      chat: { enabled: true, jaceReplied: true },
      invites: { count: 2 },
      runner: { connected: true },
    };
    const a = deriveOnboardingSteps(input);
    const b = deriveOnboardingSteps(input);
    expect(a).toEqual(b);
    expect(a).toEqual([
      { id: "connect-github", status: "complete" },
      { id: "connect-channel", status: "skipped" },
      { id: "say-hi-to-jace", status: "complete" },
      { id: "invite-team", status: "complete" },
      { id: "attach-runner", status: "complete" },
    ]);
  });

  it("steps derive independently of one another (no cross-step coupling)", () => {
    const allComplete: OnboardingStepsInput = {
      github: { repoCount: 1, hasWebhookSecret: true },
      channel: { connected: true, skipped: false },
      chat: { enabled: true, jaceReplied: true },
      invites: { count: 1 },
      runner: { connected: true },
    };
    // Flip exactly one signal at a time; only that step's status should move.
    const flips: Array<[Partial<OnboardingStepsInput>, OnboardingStepId]> = [
      [{ github: { repoCount: 0, hasWebhookSecret: true } }, "connect-github"],
      [{ channel: { connected: false, skipped: false } }, "connect-channel"],
      [{ chat: { enabled: true, jaceReplied: false } }, "say-hi-to-jace"],
      [{ invites: { count: 0 } }, "invite-team"],
      [{ runner: { connected: false } }, "attach-runner"],
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
      github: { repoCount: 1, hasWebhookSecret: true }, // complete
      channel: { connected: false, skipped: true }, // skipped
      chat: { enabled: false, jaceReplied: false }, // skipped
      invites: { count: 0 }, // incomplete
      runner: { connected: false }, // incomplete
    });
    const progress = onboardingProgress(steps);
    expect(progress).toEqual({ done: 3, total: 5, allDone: false });
  });

  it("allDone is true once nothing is incomplete (mix of complete + skipped)", () => {
    const steps = deriveOnboardingSteps({
      github: { repoCount: 1, hasWebhookSecret: true },
      channel: { connected: false, skipped: true },
      chat: { enabled: false, jaceReplied: false },
      invites: { count: 3 },
      runner: { connected: true },
    });
    expect(onboardingProgress(steps)).toEqual({
      done: 5,
      total: 5,
      allDone: true,
    });
  });

  it("allDone is false when even one step is incomplete", () => {
    const steps = deriveOnboardingSteps({
      github: { repoCount: 1, hasWebhookSecret: true },
      channel: { connected: true, skipped: false },
      chat: { enabled: true, jaceReplied: false },
      invites: { count: 3 },
      runner: { connected: false },
    });
    expect(onboardingProgress(steps).allDone).toBe(false);
  });

  it("a fresh workspace has zero done of five", () => {
    const steps = deriveOnboardingSteps({
      github: { repoCount: 0, hasWebhookSecret: false },
      channel: { connected: false, skipped: false },
      chat: { enabled: true, jaceReplied: false },
      invites: { count: 0 },
      runner: { connected: false },
    });
    expect(onboardingProgress(steps)).toEqual({
      done: 0,
      total: 5,
      allDone: false,
    });
  });
});

describe("shouldShowOnboardingBanner", () => {
  it("shows the banner when any step is incomplete", () => {
    const steps = deriveOnboardingSteps({
      github: { repoCount: 1, hasWebhookSecret: true },
      channel: { connected: false, skipped: true },
      chat: { enabled: false, jaceReplied: false },
      invites: { count: 1 },
      runner: { connected: false },
    });
    expect(shouldShowOnboardingBanner(steps)).toBe(true);
  });

  it("hides the banner once every step is complete", () => {
    const steps = deriveOnboardingSteps({
      github: { repoCount: 1, hasWebhookSecret: true },
      channel: { connected: true, skipped: false },
      chat: { enabled: true, jaceReplied: true },
      invites: { count: 1 },
      runner: { connected: true },
    });
    expect(shouldShowOnboardingBanner(steps)).toBe(false);
  });

  it("hides the banner when the only remaining steps are skipped, not incomplete", () => {
    const steps = deriveOnboardingSteps({
      github: { repoCount: 1, hasWebhookSecret: true },
      channel: { connected: false, skipped: true },
      chat: { enabled: false, jaceReplied: false },
      invites: { count: 1 },
      runner: { connected: true },
    });
    expect(shouldShowOnboardingBanner(steps)).toBe(false);
  });

  it("shows the banner on a completely fresh workspace", () => {
    const steps = deriveOnboardingSteps({
      github: { repoCount: 0, hasWebhookSecret: false },
      channel: { connected: false, skipped: false },
      chat: { enabled: true, jaceReplied: false },
      invites: { count: 0 },
      runner: { connected: false },
    });
    expect(shouldShowOnboardingBanner(steps)).toBe(true);
  });
});
