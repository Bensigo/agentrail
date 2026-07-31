import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Subscription-platform slice 2, Task 11 — the ADMISSION wiring:
 * `alignment-brief.ts`'s `resolveModelSelectionForBrief` computing the
 * entitlement filter (`allowedProfiles`) and threading it into
 * `selectExecuteModel`, gated behind the arc's kill-switch
 * (`subscriptionsEnforced`, `policy/feature-flags.ts`).
 *
 * A SEPARATE file from `alignment-brief.model-selection.test.ts` on purpose,
 * mirroring that file's own "one file per concern" split: THAT file covers
 * the #1338 PR② flag (`isModelSelectionLearningEnabled`) and
 * `selectExecuteModel`'s own glue; THIS file covers the entitlement layer
 * stacked on top of it. `selectExecuteModel`'s own filtering/fail-open
 * correctness stays in `alignment/selector.test.ts` +
 * `alignment/eligibility.test.ts`; `allowedProfilesFor`'s own
 * escalation/downgrade/entitlement math stays in `allowed-profiles.test.ts`.
 * This file is only about the GLUE: does `resolveModelSelectionForBrief`
 * call the right things with the right arguments, in the right order, honor
 * the `degraded` hard contract, and log the `profile_downgraded` telemetry
 * correctly.
 *
 * `classifyTaskProfile` and `allowedProfilesFor` run FOR REAL here (both
 * pure, already covered in depth elsewhere) — only the impure / DB-touching
 * boundaries are mocked: `subscriptionsEnforced`, `resolvePolicyForWorkspace`,
 * `isModelSelectionLearningEnabled`, `selectExecuteModel`. Every test in this
 * file keeps the model-selection-learning gate open (`mockLearningFlag`
 * returns `true` in `beforeEach`) — that gate's OWN behavior (flag off, no
 * workspaceId) is `alignment-brief.model-selection.test.ts`'s job, not
 * this file's.
 */
vi.mock("../alignment/selector", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../alignment/selector")>();
  return { ...actual, selectExecuteModel: vi.fn() };
});

vi.mock("../alignment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../alignment")>();
  return { ...actual, isModelSelectionLearningEnabled: vi.fn() };
});

vi.mock("./feature-flags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./feature-flags")>();
  return { ...actual, subscriptionsEnforced: vi.fn() };
});

vi.mock("./resolve-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./resolve-policy")>();
  return { ...actual, resolvePolicyForWorkspace: vi.fn() };
});

import { resolveModelSelectionForBrief } from "../alignment-brief";
import { selectExecuteModel } from "../alignment/selector";
import { isModelSelectionLearningEnabled, MODEL_CATALOG } from "../alignment";
import { subscriptionsEnforced } from "./feature-flags";
import { resolvePolicyForWorkspace } from "./resolve-policy";
import { PLAN_POLICIES } from "./plan-policies";
import type { ResolvedPolicy } from "./resolve-policy";

const mockSelect = vi.mocked(selectExecuteModel);
const mockLearningFlag = vi.mocked(isModelSelectionLearningEnabled);
const mockSubsFlag = vi.mocked(subscriptionsEnforced);
const mockResolvePolicy = vi.mocked(resolvePolicyForWorkspace);

function resolved(overrides: Partial<ResolvedPolicy> = {}): ResolvedPolicy {
  return {
    policy: PLAN_POLICIES.growth,
    billingAccountId: "acct-1",
    degraded: false,
    ...overrides,
  };
}

// Title classifies as "refactor" (classifier.ts keyword match — the SAME
// fixture `alignment-brief.model-selection.test.ts` uses, with the same
// comment there confirming the classification).
const TASK_INPUT = {
  title: "Refactor the billing pipeline",
  whatToBuild: "Decouple invoicing from payments.",
  acceptanceCriteria: ["Modules are separate"],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLearningFlag.mockReturnValue(true);
  mockSelect.mockResolvedValue({ model: MODEL_CATALOG.refactor, reason: "seed" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveModelSelectionForBrief: subscriptionsEnforced() off (default) -- byte-identical, resolver never called", () => {
  it("does not call resolvePolicyForWorkspace, and selectExecuteModel gets no filter", async () => {
    mockSubsFlag.mockReturnValue(false);

    await resolveModelSelectionForBrief(TASK_INPUT, "ws-1");

    expect(mockResolvePolicy).not.toHaveBeenCalled();
    expect(mockSelect).toHaveBeenCalledTimes(1);
    const optsArg = mockSelect.mock.calls[0]?.[2];
    expect(optsArg?.allowedProfiles).toBeUndefined();
  });

  it("still calls selectExecuteModel(taskType, workspaceId) normally -- only the filter is affected, nothing else about the call site", async () => {
    mockSubsFlag.mockReturnValue(false);

    await resolveModelSelectionForBrief(TASK_INPUT, "ws-1");

    expect(mockSelect.mock.calls[0]?.[0]).toBe("refactor");
    expect(mockSelect.mock.calls[0]?.[1]).toBe("ws-1");
  });

  it("never warns profile_downgraded when the kill switch is off", async () => {
    mockSubsFlag.mockReturnValue(false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await resolveModelSelectionForBrief(TASK_INPUT, "ws-1");

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("resolveModelSelectionForBrief: subscriptionsEnforced() on, degraded policy -- the hard contract, no filter", () => {
  it("calls resolvePolicyForWorkspace(workspaceId), but passes NO filter when degraded: true", async () => {
    mockSubsFlag.mockReturnValue(true);
    mockResolvePolicy.mockResolvedValue(resolved({ degraded: true }));

    await resolveModelSelectionForBrief(TASK_INPUT, "ws-1");

    expect(mockResolvePolicy).toHaveBeenCalledWith("ws-1");
    const optsArg = mockSelect.mock.calls[0]?.[2];
    expect(optsArg?.allowedProfiles).toBeUndefined();
  });

  it("never warns profile_downgraded when degraded (nothing safe to compare classified against)", async () => {
    mockSubsFlag.mockReturnValue(true);
    mockResolvePolicy.mockResolvedValue(resolved({ degraded: true, policy: PLAN_POLICIES.starter }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await resolveModelSelectionForBrief(TASK_INPUT, "ws-1");

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("resolveModelSelectionForBrief: subscriptionsEnforced() on, healthy policy -- computes and passes the entitlement filter", () => {
  it("starter + a refactor (premium-classified) task: allowed = {economy, standard}", async () => {
    mockSubsFlag.mockReturnValue(true);
    mockResolvePolicy.mockResolvedValue(resolved({ policy: PLAN_POLICIES.starter }));

    await resolveModelSelectionForBrief(TASK_INPUT, "ws-1");

    expect(mockSelect).toHaveBeenCalledWith("refactor", "ws-1", {
      allowedProfiles: new Set(["economy", "standard"]),
    });
  });

  it("growth + the same refactor task: allowed = {economy, standard, premium} (fully entitled)", async () => {
    mockSubsFlag.mockReturnValue(true);
    mockResolvePolicy.mockResolvedValue(resolved({ policy: PLAN_POLICIES.growth }));

    await resolveModelSelectionForBrief(TASK_INPUT, "ws-1");

    expect(mockSelect).toHaveBeenCalledWith("refactor", "ws-1", {
      allowedProfiles: new Set(["economy", "standard", "premium"]),
    });
  });

  it("resolvePolicyForWorkspace is called with exactly the workspaceId, no deps override", async () => {
    mockSubsFlag.mockReturnValue(true);
    mockResolvePolicy.mockResolvedValue(resolved());

    await resolveModelSelectionForBrief(TASK_INPUT, "ws-42");

    expect(mockResolvePolicy).toHaveBeenCalledWith("ws-42");
    expect(mockResolvePolicy).toHaveBeenCalledTimes(1);
  });
});

describe("resolveModelSelectionForBrief: profile_downgraded telemetry", () => {
  it("warns with the exact structured payload when the classified profile is not in the allowed set", async () => {
    mockSubsFlag.mockReturnValue(true);
    mockResolvePolicy.mockResolvedValue(resolved({ policy: PLAN_POLICIES.starter }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // "refactor" classifies to "premium" (classify-task.ts); starter caps at "standard".
    await resolveModelSelectionForBrief(TASK_INPUT, "ws-1");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("profile_downgraded"),
      {
        workspaceId: "ws-1",
        taskType: "refactor",
        classified: "premium",
        served: "standard",
      }
    );
  });

  it("does NOT warn when the classified profile IS in the allowed set (growth, fully entitled)", async () => {
    mockSubsFlag.mockReturnValue(true);
    mockResolvePolicy.mockResolvedValue(resolved({ policy: PLAN_POLICIES.growth }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await resolveModelSelectionForBrief(TASK_INPUT, "ws-1");

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("fires exactly once even though the wiring computes the filter once (no duplicate warns)", async () => {
    mockSubsFlag.mockReturnValue(true);
    mockResolvePolicy.mockResolvedValue(resolved({ policy: PLAN_POLICIES.starter }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await resolveModelSelectionForBrief(TASK_INPUT, "ws-1");

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe("resolveModelSelectionForBrief: still fails safe when selectExecuteModel itself throws, filter or no filter", () => {
  it("subscriptionsEnforced() on: a selectExecuteModel rejection still resolves to undefined, logged", async () => {
    mockSubsFlag.mockReturnValue(true);
    mockResolvePolicy.mockResolvedValue(resolved({ policy: PLAN_POLICIES.starter }));
    mockSelect.mockRejectedValue(new Error("getModelOutcomeStats: connection refused"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(resolveModelSelectionForBrief(TASK_INPUT, "ws-1")).resolves.toBeUndefined();
  });
});
