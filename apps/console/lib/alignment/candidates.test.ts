import { describe, it, expect } from "vitest";
import { CANDIDATES, MODEL_SEATS, slugsForProfiles } from "./candidates";
import { MODEL_CATALOG } from "./catalog";
import { ALL_TASK_TYPES } from "./eligibility";
import type { QualityProfile } from "./quality-profile";

// ---------------------------------------------------------------------------
// #1338 PR③ — the widened candidate pool's own guard.
//
// This is deliberately NOT a cross-language mirror test against
// `agentrail/context/pricing.py::PRICE_TABLE` the way `catalog.test.ts` mirrors
// MODEL_CATALOG: most of these slugs (kimi-k2.7-code, kimi-k3, glm-4.7,
// deepseek-v4-pro, qwen3-coder-plus, gpt-5.1-codex) have no PRICE_TABLE entry
// at all, and `z-ai/glm-5.2` already has ONE — pricing the hosted fleet's
// VERIFY seat at $0.30/$0.94, pinned by `agentrail/tests/run/test_pricing.py`
// + `agentrail/tests/conftest.py`. This pool's own glm-5.2 entry ($0.98/$3.07)
// prices a DIFFERENT role (execute-candidate) and intentionally does not
// touch that pinned, already-shipped, unrelated Python value — see
// candidates.ts's own module doc for the full reasoning. Runtime cost
// metering for a real run never depends on the static numbers here either:
// it resolves gateway-first at call time (#1337/#1368), independent of this
// file. What THIS suite guards instead: every candidate slug is genuinely
// priced (never $0, never missing), the pool matches the owner-confirmed
// spread exactly, and every seed is eligible for its own task type.
// ---------------------------------------------------------------------------

const ALL_CANDIDATE_SLUGS = [
  "moonshotai/kimi-k2.7-code",
  "z-ai/glm-5.2",
  "moonshotai/kimi-k3",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-4.8",
  "deepseek/deepseek-v4-pro",
  "z-ai/glm-4.7",
  "qwen/qwen3-coder-plus",
  "anthropic/claude-haiku-4.5",
  "openai/gpt-5.1-codex",
];

describe("CANDIDATES: pinned per-task pool, seed first (#1338 PR③ confirmed spread)", () => {
  it("ui: kimi-k2.7-code (seed), glm-5.2, kimi-k3, sonnet-5", () => {
    expect(CANDIDATES.ui).toEqual([
      "moonshotai/kimi-k2.7-code",
      "z-ai/glm-5.2",
      "moonshotai/kimi-k3",
      "anthropic/claude-sonnet-5",
    ]);
  });

  it("refactor: opus-4.8 (seed), glm-5.2, deepseek-v4-pro, kimi-k2.7-code, sonnet-5", () => {
    expect(CANDIDATES.refactor).toEqual([
      "anthropic/claude-opus-4.8",
      "z-ai/glm-5.2",
      "deepseek/deepseek-v4-pro",
      "moonshotai/kimi-k2.7-code",
      "anthropic/claude-sonnet-5",
    ]);
  });

  it("mechanical: glm-4.7 (seed), glm-5.2, deepseek-v4-pro, qwen3-coder-plus, haiku-4.5", () => {
    expect(CANDIDATES.mechanical).toEqual([
      "z-ai/glm-4.7",
      "z-ai/glm-5.2",
      "deepseek/deepseek-v4-pro",
      "qwen/qwen3-coder-plus",
      "anthropic/claude-haiku-4.5",
    ]);
  });

  it("general: glm-5.2 (seed), kimi-k2.7-code, deepseek-v4-pro, gpt-5.1-codex, sonnet-5", () => {
    expect(CANDIDATES.general).toEqual([
      "z-ai/glm-5.2",
      "moonshotai/kimi-k2.7-code",
      "deepseek/deepseek-v4-pro",
      "openai/gpt-5.1-codex",
      "anthropic/claude-sonnet-5",
    ]);
  });

  it("every task type's pool has no duplicate slugs", () => {
    for (const taskType of ALL_TASK_TYPES) {
      const pool = CANDIDATES[taskType];
      expect(new Set(pool).size).toBe(pool.length);
    }
  });
});

describe("MODEL_SEATS: every candidate slug (every task type) resolves to a registered seat", () => {
  for (const taskType of ALL_TASK_TYPES) {
    it(`${taskType}`, () => {
      for (const slug of CANDIDATES[taskType]) {
        const seat = MODEL_SEATS[slug];
        expect(seat, `MODEL_SEATS is missing an entry for "${slug}" (task type "${taskType}")`).toBeDefined();
        expect(seat.slug).toBe(slug);
        // Task 9 (quality-profile tags): every reachable seat must be tagged.
        expect(seat.profile, `MODEL_SEATS["${slug}"] (task type "${taskType}") has no profile`).toBeDefined();
      }
    });
  }

  it("has exactly the 10 distinct slugs the widened pool uses — nothing orphaned, nothing missing", () => {
    expect(new Set(Object.keys(MODEL_SEATS))).toEqual(new Set(ALL_CANDIDATE_SLUGS));
  });

  // Task 9: every MODEL_SEATS entry — not just the ones CANDIDATES currently
  // reaches — must carry a profile. Belt-and-suspenders with the per-task-type
  // check above (which only walks CANDIDATES-reachable slugs); this walks the
  // registry's own keys directly, so a hypothetical future MODEL_SEATS entry
  // not yet wired into any CANDIDATES pool would still be caught.
  it("every MODEL_SEATS entry (not just CANDIDATES-reachable ones) has a profile", () => {
    for (const [slug, seat] of Object.entries(MODEL_SEATS)) {
      expect(seat.profile, `MODEL_SEATS["${slug}"] has no profile`).toBeDefined();
    }
  });
});

describe("MODEL_SEATS: never a $0 hazard — every seat has real, positive, finite rates", () => {
  for (const slug of ALL_CANDIDATE_SLUGS) {
    it(`${slug}`, () => {
      const seat = MODEL_SEATS[slug];
      expect(Number.isFinite(seat.inUsdPerMTok)).toBe(true);
      expect(Number.isFinite(seat.outUsdPerMTok)).toBe(true);
      expect(seat.inUsdPerMTok).toBeGreaterThan(0);
      expect(seat.outUsdPerMTok).toBeGreaterThan(0);
      expect(seat.displayName.length).toBeGreaterThan(0);
    });
  }
});

describe("MODEL_SEATS: deliberate reuse vs. deliberate divergence from MODEL_CATALOG (documented in candidates.ts's module doc)", () => {
  // Task 9 (quality-profile tags) added a `profile` field that MODEL_CATALOG's
  // own ModelSeat objects don't carry, so these two entries can no longer be
  // literal aliases of MODEL_CATALOG.refactor/.mechanical (a CandidateSeat
  // needs `profile` from somewhere) — they're built via
  // `{ ...MODEL_CATALOG.X, profile: "..." }` instead. Rates and display
  // fields still mirror MODEL_CATALOG exactly; only reference identity was
  // traded away, and only because of the new field. This test used to assert
  // `.toBe` (same object); it now asserts the same thing field-by-field.
  it("opus-4.8 and haiku-4.5 mirror MODEL_CATALOG's own seat rates exactly (same numbers, nothing to drift)", () => {
    const opus = MODEL_SEATS["anthropic/claude-opus-4.8"];
    expect(opus.slug).toBe(MODEL_CATALOG.refactor.slug);
    expect(opus.displayName).toBe(MODEL_CATALOG.refactor.displayName);
    expect(opus.inUsdPerMTok).toBe(MODEL_CATALOG.refactor.inUsdPerMTok);
    expect(opus.outUsdPerMTok).toBe(MODEL_CATALOG.refactor.outUsdPerMTok);

    const haiku = MODEL_SEATS["anthropic/claude-haiku-4.5"];
    expect(haiku.slug).toBe(MODEL_CATALOG.mechanical.slug);
    expect(haiku.displayName).toBe(MODEL_CATALOG.mechanical.displayName);
    expect(haiku.inUsdPerMTok).toBe(MODEL_CATALOG.mechanical.inUsdPerMTok);
    expect(haiku.outUsdPerMTok).toBe(MODEL_CATALOG.mechanical.outUsdPerMTok);
  });

  it("sonnet-5 is a DIFFERENT object from MODEL_CATALOG.ui, at a different (live vs. sticker) rate — intentional, not drift", () => {
    const candidateSonnet = MODEL_SEATS["anthropic/claude-sonnet-5"];
    expect(candidateSonnet).not.toBe(MODEL_CATALOG.ui);
    expect(candidateSonnet.inUsdPerMTok).toBe(2.0);
    expect(candidateSonnet.outUsdPerMTok).toBe(10.0);
    // MODEL_CATALOG.ui stays untouched at its own sticker rate (flag-OFF
    // static default — see catalog.ts's own module doc; must never change).
    expect(MODEL_CATALOG.ui.inUsdPerMTok).toBe(3.0);
    expect(MODEL_CATALOG.ui.outUsdPerMTok).toBe(15.0);
  });

  it("MODEL_CATALOG itself is untouched by this pool (byte-identical flag-OFF default — catalog.test.ts owns its own drift guard)", () => {
    expect(MODEL_CATALOG.ui.slug).toBe("anthropic/claude-sonnet-5");
    expect(MODEL_CATALOG.refactor.slug).toBe("anthropic/claude-opus-4.8");
    expect(MODEL_CATALOG.mechanical.slug).toBe("anthropic/claude-haiku-4.5");
    expect(MODEL_CATALOG.general.slug).toBe("anthropic/claude-sonnet-5");
  });
});

// ---------------------------------------------------------------------------
// Subscription-platform slice 2, Task 9 — quality-profile tags.
//
// `MODEL_SEATS` entries now also carry a `profile: QualityProfile`
// (economy/standard/premium, `./quality-profile.ts`) so a LATER task can
// filter model selection down to a workspace's entitled profiles. This
// suite pins the exact assignment (a reviewable judgment call — the full
// slug/tier/cost/profile table is in this task's PR body) and guards the
// pure `slugsForProfiles` filter helper. No selection behavior changes here
// — `eligibility.ts`/`seeds.ts`/`selector.ts` don't read `.profile` yet.
// ---------------------------------------------------------------------------

describe("MODEL_SEATS: quality-profile tag (subscription-platform slice 2, Task 9)", () => {
  it("every entry has a profile that is economy, standard, or premium", () => {
    const validProfiles: QualityProfile[] = ["economy", "standard", "premium"];
    for (const [slug, seat] of Object.entries(MODEL_SEATS)) {
      expect(validProfiles, `MODEL_SEATS["${slug}"].profile is not a valid QualityProfile`).toContain(
        seat.profile
      );
    }
  });

  it("every CANDIDATES slug (every task type) resolves to a seat with a profile — nothing reachable from the pool is untagged", () => {
    for (const taskType of ALL_TASK_TYPES) {
      for (const slug of CANDIDATES[taskType]) {
        expect(MODEL_SEATS[slug]?.profile, `MODEL_SEATS["${slug}"] (task type "${taskType}") has no profile`).toBeDefined();
      }
    }
  });

  it("pins the exact owner-reviewable assignment (cost-tier split — see candidates.ts's module doc for the methodology, PR body for the review table)", () => {
    const profileBySlug: Record<string, QualityProfile> = {};
    for (const [slug, seat] of Object.entries(MODEL_SEATS)) {
      profileBySlug[slug] = seat.profile;
    }
    expect(profileBySlug).toEqual({
      "moonshotai/kimi-k2.7-code": "standard",
      "z-ai/glm-5.2": "standard",
      "moonshotai/kimi-k3": "premium",
      "anthropic/claude-sonnet-5": "premium",
      "anthropic/claude-opus-4.8": "premium",
      "deepseek/deepseek-v4-pro": "economy",
      "z-ai/glm-4.7": "economy",
      "qwen/qwen3-coder-plus": "standard",
      "anthropic/claude-haiku-4.5": "standard",
      "openai/gpt-5.1-codex": "premium",
    });
  });

  it("counts: 2 economy / 4 standard / 4 premium", () => {
    const counts: Record<QualityProfile, number> = { economy: 0, standard: 0, premium: 0 };
    for (const seat of Object.values(MODEL_SEATS)) {
      counts[seat.profile]++;
    }
    expect(counts).toEqual({ economy: 2, standard: 4, premium: 4 });
  });
});

describe("slugsForProfiles: pure filter over MODEL_SEATS, preserves input order", () => {
  it("keeps only slugs whose MODEL_SEATS profile is in the allowed set", () => {
    const result = slugsForProfiles(
      ["z-ai/glm-4.7", "anthropic/claude-opus-4.8", "z-ai/glm-5.2"],
      new Set<QualityProfile>(["economy"])
    );
    expect(result).toEqual(["z-ai/glm-4.7"]);
  });

  it("preserves the input order of the slugs it keeps (never re-sorts, e.g. by MODEL_SEATS declaration order)", () => {
    // Input order deliberately does NOT match MODEL_SEATS's own declaration
    // order (gpt-5.1-codex is declared last there, kimi-k3 near the top) —
    // if this function ever started sorting by declaration order instead of
    // preserving input order, this assertion would catch it.
    const result = slugsForProfiles(
      ["openai/gpt-5.1-codex", "z-ai/glm-4.7", "anthropic/claude-haiku-4.5", "moonshotai/kimi-k3"],
      new Set<QualityProfile>(["standard", "premium"])
    );
    expect(result).toEqual(["openai/gpt-5.1-codex", "anthropic/claude-haiku-4.5", "moonshotai/kimi-k3"]);
  });

  it("returns [] for an empty allowed set, even when every slug is a real, tagged seat", () => {
    const result = slugsForProfiles(
      ["z-ai/glm-4.7", "anthropic/claude-opus-4.8"],
      new Set<QualityProfile>()
    );
    expect(result).toEqual([]);
  });

  it("returns [] for empty input slugs regardless of allowed", () => {
    const result = slugsForProfiles([], new Set<QualityProfile>(["economy", "standard", "premium"]));
    expect(result).toEqual([]);
  });

  it("filters out a slug with no MODEL_SEATS entry rather than throwing", () => {
    const result = slugsForProfiles(
      ["not-a-real-slug", "z-ai/glm-4.7"],
      new Set<QualityProfile>(["economy", "standard", "premium"])
    );
    expect(result).toEqual(["z-ai/glm-4.7"]);
  });

  it("does not mutate its input slugs array", () => {
    const input = ["z-ai/glm-4.7", "anthropic/claude-opus-4.8"];
    const snapshot = [...input];
    slugsForProfiles(input, new Set<QualityProfile>(["economy"]));
    expect(input).toEqual(snapshot);
  });
});
