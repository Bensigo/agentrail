import { describe, it, expect } from "vitest";
import { CANDIDATES, MODEL_SEATS } from "./candidates";
import { MODEL_CATALOG } from "./catalog";
import { ALL_TASK_TYPES } from "./eligibility";

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
      }
    });
  }

  it("has exactly the 10 distinct slugs the widened pool uses — nothing orphaned, nothing missing", () => {
    expect(new Set(Object.keys(MODEL_SEATS))).toEqual(new Set(ALL_CANDIDATE_SLUGS));
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
  it("opus-4.8 and haiku-4.5 REUSE MODEL_CATALOG's own seat objects verbatim (same rate, nothing to drift)", () => {
    expect(MODEL_SEATS["anthropic/claude-opus-4.8"]).toBe(MODEL_CATALOG.refactor);
    expect(MODEL_SEATS["anthropic/claude-haiku-4.5"]).toBe(MODEL_CATALOG.mechanical);
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
