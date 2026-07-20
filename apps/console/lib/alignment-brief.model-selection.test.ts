import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * #1338 PR② — `resolveModelSelectionForBrief`'s flag-ON wiring.
 *
 * A SEPARATE file from `alignment-brief.test.ts` on purpose: this is the
 * ONLY spot in the whole alignment-brief compose path that calls the async,
 * DB-backed `selectExecuteModel` (`alignment/selector.ts` ->
 * `getModelOutcomeStats`, `@agentrail/db-postgres`). Rather than mocking
 * `@agentrail/db-postgres` itself (which `alignment-brief.test.ts` and
 * several other files already import FOR REAL, unmocked, via
 * `validateAcceptanceCriteria` — a pure, DB-free export), this file does TWO
 * PARTIAL mocks via `importOriginal`:
 *   - `./alignment/selector` — `selectExecuteModel` replaced with a
 *     controllable fake; `describeModelSelection` stays REAL (it's pure —
 *     `alignment-brief.ts` imports both directly from this module, NOT the
 *     `./alignment` barrel; see that barrel's own module doc for why
 *     selector.ts is deliberately excluded from it).
 *   - `./alignment` — only `isModelSelectionLearningEnabled` replaced;
 *     `classifyTaskType`, `estimateBrief`, `MODEL_CATALOG` stay REAL.
 * `selectExecuteModel`'s own correctness (eligibility, MIN_RUNS, exploration,
 * the haiku-for-ui hard rule) is already covered in depth by
 * `alignment/selector.test.ts`; this file is only about the GLUE: does
 * `resolveModelSelectionForBrief` call the right things with the right
 * arguments, and does it fail safe.
 */
vi.mock("./alignment/selector", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./alignment/selector")>();
  return {
    ...actual,
    selectExecuteModel: vi.fn(),
  };
});

vi.mock("./alignment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./alignment")>();
  return {
    ...actual,
    isModelSelectionLearningEnabled: vi.fn(),
  };
});

import { resolveModelSelectionForBrief } from "./alignment-brief";
import { selectExecuteModel } from "./alignment/selector";
import { isModelSelectionLearningEnabled, MODEL_CATALOG } from "./alignment";

const mockSelect = vi.mocked(selectExecuteModel);
const mockFlag = vi.mocked(isModelSelectionLearningEnabled);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const TASK_INPUT = {
  title: "Refactor the billing pipeline",
  whatToBuild: "Decouple invoicing from payments.",
  acceptanceCriteria: ["Modules are separate"],
};

describe("resolveModelSelectionForBrief: flag check", () => {
  it("checks the flag for the given workspaceId before doing anything else", async () => {
    mockFlag.mockReturnValue(false);
    await resolveModelSelectionForBrief(TASK_INPUT, "ws-1");
    expect(mockFlag).toHaveBeenCalledWith("ws-1");
  });

  it("flag off: resolves undefined and NEVER calls the (DB-backed) selector", async () => {
    mockFlag.mockReturnValue(false);
    const result = await resolveModelSelectionForBrief(TASK_INPUT, "ws-1");
    expect(result).toBeUndefined();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("no workspaceId: resolves undefined WITHOUT even checking the flag (nothing to scope stats to)", async () => {
    const result = await resolveModelSelectionForBrief(TASK_INPUT, undefined);
    expect(result).toBeUndefined();
    expect(mockFlag).not.toHaveBeenCalled();
    expect(mockSelect).not.toHaveBeenCalled();
  });
});

describe("resolveModelSelectionForBrief: flag on", () => {
  it("classifies the task, calls selectExecuteModel(taskType, workspaceId), and returns {model, reasonText} built from the REAL describeModelSelection", async () => {
    mockFlag.mockReturnValue(true);
    mockSelect.mockResolvedValue({
      model: MODEL_CATALOG.refactor,
      reason: "best-from-data",
      runCount: 9,
    });

    const result = await resolveModelSelectionForBrief(TASK_INPUT, "ws-1");

    expect(mockSelect).toHaveBeenCalledWith("refactor", "ws-1"); // TASK_INPUT's title classifies as "refactor"
    expect(result).toEqual({
      model: MODEL_CATALOG.refactor,
      reasonText: "Claude Opus 4.8 — best success rate for refactor (9 runs)",
    });
  });

  it("a 'seed' selection with no data produces the seed's own 'starting default' text", async () => {
    mockFlag.mockReturnValue(true);
    mockSelect.mockResolvedValue({ model: MODEL_CATALOG.refactor, reason: "seed" });

    const result = await resolveModelSelectionForBrief(TASK_INPUT, "ws-1");

    expect(result?.reasonText).toBe("Claude Opus 4.8 — starting default, no data yet");
  });

  it("an 'exploring' selection produces the compare-and-learn text", async () => {
    mockFlag.mockReturnValue(true);
    mockSelect.mockResolvedValue({ model: MODEL_CATALOG.mechanical, reason: "exploring" });

    const result = await resolveModelSelectionForBrief(TASK_INPUT, "ws-1");

    expect(result?.reasonText).toBe("Trying Claude Haiku 4.5 to compare");
  });
});

describe("resolveModelSelectionForBrief: fail-safe on selector errors", () => {
  it("selectExecuteModel throwing resolves to undefined rather than propagating (falls back to MODEL_CATALOG[taskType])", async () => {
    mockFlag.mockReturnValue(true);
    mockSelect.mockRejectedValue(new Error("getModelOutcomeStats: connection refused"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(resolveModelSelectionForBrief(TASK_INPUT, "ws-1")).resolves.toBeUndefined();
  });

  it("logs the failure loudly (never a silent swallow)", async () => {
    mockFlag.mockReturnValue(true);
    mockSelect.mockRejectedValue(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await resolveModelSelectionForBrief(TASK_INPUT, "ws-1");

    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls[0]?.[0]).toContain("ws-1");
  });
});
