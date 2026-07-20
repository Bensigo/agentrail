import { describe, it, expect } from "vitest";
import { bucketVolume, estimateBrief } from "./estimate";
import type { VolumeBucket } from "./estimate";
import type { TaskInput, TaskType } from "./classifier";
import { MODEL_CATALOG } from "./catalog";
import { resolveModelPrice } from "./resolve-price";

function acList(count: number): string[] {
  return Array.from({ length: count }, () => "a");
}

/** Titles guaranteed to classify as the given TaskType (mirrors classifier.test.ts's cases). */
const TRIGGER_TITLE: Record<TaskType, string> = {
  ui: "Build a new settings page",
  refactor: "Refactor the billing module architecture",
  mechanical: "Bump the dependency version",
  general: "Investigate the reported issue",
};

// ---------------------------------------------------------------------------
// bucketVolume: boundary cases (S/M/L thresholds documented in estimate.ts:
// acCount<=2 & bodyChars<=280 -> S; acCount>=5 or bodyChars>1200 -> L; else M).
// ---------------------------------------------------------------------------
describe("bucketVolume: boundary cases", () => {
  const cases: Array<{ name: string; acCount: number; bodyChars: number; expected: VolumeBucket }> = [
    { name: "0 AC, empty body -> S", acCount: 0, bodyChars: 0, expected: "S" },
    { name: "exactly 2 AC, exactly 280 chars -> S (both at threshold)", acCount: 2, bodyChars: 280, expected: "S" },
    { name: "exactly 3 AC, tiny body -> M (AC count alone breaks S)", acCount: 3, bodyChars: 10, expected: "M" },
    { name: "exactly 2 AC, 281 chars -> M (body alone breaks S)", acCount: 2, bodyChars: 281, expected: "M" },
    { name: "exactly 5 AC, tiny body -> L (AC count alone forces L)", acCount: 5, bodyChars: 10, expected: "L" },
    { name: "4 AC, exactly 1200 chars -> M (not yet over the long threshold)", acCount: 4, bodyChars: 1200, expected: "M" },
    { name: "4 AC, 1201 chars -> L (body alone forces L)", acCount: 4, bodyChars: 1201, expected: "L" },
    { name: "4 AC, 500 chars -> M (neither S nor L condition met)", acCount: 4, bodyChars: 500, expected: "M" },
  ];

  for (const { name, acCount, bodyChars, expected } of cases) {
    it(name, () => {
      // Split bodyChars between whatToBuild and the AC join deterministically:
      // put it all in whatToBuild, and keep AC entries at exactly 1 char each
      // (so join length = acCount + max(acCount - 1, 0) separators).
      const acceptanceCriteria = Array.from({ length: acCount }, () => "x");
      const acJoinLen = acceptanceCriteria.join(" ").length;
      const whatToBuild = "y".repeat(Math.max(bodyChars - acJoinLen, 0));
      const totalBody = whatToBuild.length + acJoinLen;
      expect(totalBody).toBe(bodyChars); // sanity check on the fixture itself
      expect(bucketVolume({ whatToBuild, acceptanceCriteria })).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// estimateBrief: exact math pinned per seat x bucket.
//
// Rates are resolved gateway-first (#1337 PR ②, see resolve-price.ts) rather
// than pinned as literals here: `claude-sonnet-5`'s live rate can legitimately
// move (its introductory pricing lapses 2026-08-31 — see catalog.ts), and a
// `catalog:refresh` picks that up automatically. Hardcoding this test's
// expected rates would make it fail on every such refresh for a reason that
// has nothing to do with estimateBrief's own logic. Instead this test
// independently re-derives the expected dollar figure from whatever
// resolveModelPrice ACTUALLY resolves right now (the same function
// estimateBrief itself calls) combined with the token-volume-bucket
// constants below, which — unlike prices — really are fixed source constants
// (VOLUME_TOKEN_ASSUMPTIONS in estimate.ts) and are legitimately safe to pin.
//
// tokens per bucket: S 40_000/4_000, M 120_000/12_000, L 300_000/30_000.
// estimateUsd = inTokens/1e6*inRate + outTokens/1e6*outRate, rounded to cents.
// A separate, fully-literal pin of the price_table FALLBACK branch's math
// lives in resolve-price.test.ts (a synthetic seat with fixed constants that
// cannot drift).
// ---------------------------------------------------------------------------
describe("estimateBrief: exact math pinned per seat x bucket", () => {
  const BUCKET_FIXTURE: Record<VolumeBucket, { acCount: number; bodyLen: number }> = {
    S: { acCount: 1, bodyLen: 10 },
    M: { acCount: 3, bodyLen: 500 },
    L: { acCount: 6, bodyLen: 10 },
  };

  const BUCKET_TOKENS: Record<VolumeBucket, { inTokens: number; outTokens: number }> = {
    S: { inTokens: 40_000, outTokens: 4_000 },
    M: { inTokens: 120_000, outTokens: 12_000 },
    L: { inTokens: 300_000, outTokens: 30_000 },
  };

  const taskTypes: TaskType[] = ["ui", "refactor", "mechanical", "general"];
  const buckets: VolumeBucket[] = ["S", "M", "L"];

  for (const taskType of taskTypes) {
    for (const bucket of buckets) {
      it(`${taskType} x ${bucket}: matches inTokens/1e6*inRate + outTokens/1e6*outRate at the resolved rate`, () => {
        const { acCount, bodyLen } = BUCKET_FIXTURE[bucket];
        const input: TaskInput = {
          title: TRIGGER_TITLE[taskType],
          whatToBuild: "z".repeat(bodyLen),
          acceptanceCriteria: acList(acCount),
        };
        const result = estimateBrief(input);
        expect(result.taskType).toBe(taskType);
        expect(result.volumeBucket).toBe(bucket);
        expect(result.suggestedModel).toBe(MODEL_CATALOG[taskType]);

        const resolved = resolveModelPrice(MODEL_CATALOG[taskType]);
        expect(result.priceSource).toBe(resolved.priceSource);
        expect(result.resolvedInUsdPerMTok).toBe(resolved.inUsdPerMTok);
        expect(result.resolvedOutUsdPerMTok).toBe(resolved.outUsdPerMTok);

        const { inTokens, outTokens } = BUCKET_TOKENS[bucket];
        const expectedUsd =
          Math.round(
            ((inTokens / 1_000_000) * resolved.inUsdPerMTok + (outTokens / 1_000_000) * resolved.outUsdPerMTok) * 100
          ) / 100;
        expect(result.estimateUsd).toBeCloseTo(expectedUsd, 5);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Current-state check: every shipped seat's slug is in the committed gateway
// snapshot today, so estimateBrief should price ALL of them via "gateway",
// never falling through to the price_table mirror. This is deliberately NOT
// a tolerant check — if a future snapshot refresh ever drops one of these 4
// slugs (retired model, typo'd catalog.ts edit, ...), THIS test should fail
// loudly and immediately, the same "$0 hazard" discipline as the AC3
// slug-validation coupling test (slug-validation.test.ts), applied to the
// price-source dimension instead of the known/unknown dimension.
// ---------------------------------------------------------------------------
describe("estimateBrief: today, every real seat prices from the gateway (not the price_table fallback)", () => {
  const taskTypes: TaskType[] = ["ui", "refactor", "mechanical", "general"];

  for (const taskType of taskTypes) {
    it(`${taskType} (${MODEL_CATALOG[taskType].slug}): priceSource is "gateway"`, () => {
      const result = estimateBrief({
        title: TRIGGER_TITLE[taskType],
        whatToBuild: "x".repeat(10),
        acceptanceCriteria: ["a"],
      });
      expect(result.priceSource).toBe("gateway");
    });
  }
});

// ---------------------------------------------------------------------------
// Cents rounding + never-0 (hard rule): every seat x bucket combination.
// ---------------------------------------------------------------------------
describe("estimateBrief: cents rounding and never-0", () => {
  const taskTypes: TaskType[] = ["ui", "refactor", "mechanical", "general"];
  const fixtures: Array<{ bucket: VolumeBucket; acCount: number; bodyLen: number }> = [
    { bucket: "S", acCount: 0, bodyLen: 0 },
    { bucket: "M", acCount: 3, bodyLen: 400 },
    { bucket: "L", acCount: 8, bodyLen: 5000 },
  ];

  for (const taskType of taskTypes) {
    for (const { bucket, acCount, bodyLen } of fixtures) {
      it(`${taskType} x ${bucket}: rounded to cents and strictly greater than 0`, () => {
        const input: TaskInput = {
          title: TRIGGER_TITLE[taskType],
          whatToBuild: "w".repeat(bodyLen),
          acceptanceCriteria: acList(acCount),
        };
        const { estimateUsd } = estimateBrief(input);
        expect(estimateUsd).toBeGreaterThan(0);
        // "Rounded to cents": *100 must land on (very close to) an integer.
        expect(Math.round(estimateUsd * 100) / 100).toBeCloseTo(estimateUsd, 9);
        expect(Number.isInteger(Math.round(estimateUsd * 10000) / 100)).toBe(true);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// assumptions content: the honest list the brief displays.
// ---------------------------------------------------------------------------
describe("estimateBrief: assumptions content", () => {
  it("names the task type, volume bucket label, token counts, and model rates", () => {
    const input: TaskInput = {
      title: "Refactor the checkout state machine",
      whatToBuild: "x".repeat(500),
      acceptanceCriteria: ["AC1", "AC2", "AC3"],
    };
    const { assumptions, taskType, volumeBucket, suggestedModel } = estimateBrief(input);
    expect(taskType).toBe("refactor");
    expect(volumeBucket).toBe("M");

    const joined = assumptions.join(" | ");
    expect(joined).toContain("refactor");
    expect(joined).toContain("Medium");
    expect(joined).toContain("120,000");
    expect(joined).toContain("12,000");
    expect(joined).toContain(suggestedModel.displayName);
    expect(assumptions.length).toBeGreaterThanOrEqual(4);
  });

  it("labels each bucket correctly: Small / Medium / Large", () => {
    const small = estimateBrief({ title: "x", whatToBuild: "", acceptanceCriteria: [] });
    const large = estimateBrief({ title: "x", whatToBuild: "", acceptanceCriteria: acList(6) });
    expect(small.assumptions.join(" ")).toContain("Small");
    expect(large.assumptions.join(" ")).toContain("Large");
  });
});
