import { describe, it, expect } from "vitest";
import { validateOverride } from "./validator";
import { MODEL_CATALOG } from "./catalog";
import { allEligibleModelSlugs, isModelEligibleForTaskType } from "./eligibility";

const OPUS = MODEL_CATALOG.refactor.slug; // anthropic/claude-opus-4.8
const HAIKU = MODEL_CATALOG.mechanical.slug; // anthropic/claude-haiku-4.5
const SONNET = MODEL_CATALOG.ui.slug; // anthropic/claude-sonnet-5 (== general's slug)
const VERIFY_MODEL = "z-ai/glm-5.2"; // matches deploy/runner/agentrail-config.hosted.json's verify seat

describe("validateOverride: ok path", () => {
  it("accepts a catalog slug distinct from the configured verify model", () => {
    expect(validateOverride(OPUS, VERIFY_MODEL)).toEqual({ ok: true });
  });

  it("accepts every catalog seat's slug when distinct from verify", () => {
    for (const seat of Object.values(MODEL_CATALOG)) {
      expect(validateOverride(seat.slug, VERIFY_MODEL).ok).toBe(true);
    }
  });
});

describe("validateOverride: the #1270 verify-collision refusal", () => {
  it("refuses when the override equals the configured verify model", () => {
    const result = validateOverride(VERIFY_MODEL, VERIFY_MODEL);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("the refusal reason honestly names the independent-review protection (#1270), not a generic message", () => {
    const result = validateOverride(VERIFY_MODEL, VERIFY_MODEL);
    expect(result.reason).toMatch(/#1270/);
    expect(result.reason).toMatch(/independent review/i);
    expect(result.reason).toMatch(/skipped_no_distinct_model/);
    // Must NOT be the generic catalog-membership message even though
    // VERIFY_MODEL also happens to not be a catalog slug — the collision
    // check is unconditional and takes priority.
    expect(result.reason).not.toMatch(/catalog-only/);
  });

  it("collision refusal fires even when the colliding slug IS a catalog member", () => {
    // Contrived but real: if a workspace's verify phase were ever configured
    // to one of the catalog's own slugs, an override matching it must still
    // be refused on the #1270 grounds, not silently allowed because it's
    // "in the catalog".
    const result = validateOverride(OPUS, OPUS);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/#1270/);
  });
});

describe("validateOverride: catalog-only refusal (v1 has no additional allowlist)", () => {
  it("refuses a slug outside the catalog that does not collide with verify", () => {
    const result = validateOverride("mystery/model-1", VERIFY_MODEL);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/catalog-only/);
    expect(result.reason).not.toMatch(/#1270/);
  });

  it("lists the actual catalog slugs in the refusal reason", () => {
    const result = validateOverride("mystery/model-1", VERIFY_MODEL);
    expect(result.reason).toContain(OPUS);
    expect(result.reason).toContain(HAIKU);
    expect(result.reason).toContain(SONNET);
  });
});

// ---------------------------------------------------------------------------
// #1338 PR② — allowlist widened to eligibility.ts's allEligibleModelSlugs
// union (source-of-truth change; see validator.ts's own module doc for why
// this was numerically identical to the old MODEL_CATALOG-derived set at the
// time). PR③ widened the underlying pool for real (candidates.ts) — the
// union now includes `z-ai/glm-5.2`, which ALSO happens to be this test
// file's fixed VERIFY_MODEL constant (matching the real hosted-runner
// config's verify seat). That single slug is carved out below: the #1270
// collision refusal correctly takes priority over catalog membership for it,
// exactly as it would for any workspace whose verify phase happened to be
// configured to a model that is also an eligible execute-candidate.
// ---------------------------------------------------------------------------
describe("validateOverride: allowlist == eligibility.ts's allEligibleModelSlugs union (#1338 PR②, pool widened PR③)", () => {
  it("accepts exactly the slugs allEligibleModelSlugs() returns, nothing more or less (excluding the one slug that collides with VERIFY_MODEL itself)", () => {
    const eligible = allEligibleModelSlugs();
    for (const slug of eligible) {
      if (slug === VERIFY_MODEL) {
        // z-ai/glm-5.2 is both an eligible execute-candidate (PR③'s widened
        // pool) AND this fixture's configured verify-phase model — see the
        // dedicated test below for the collision assertion.
        continue;
      }
      expect(validateOverride(slug, VERIFY_MODEL).ok).toBe(true);
    }
    expect(validateOverride("totally-unknown/model", VERIFY_MODEL).ok).toBe(false);
  });

  it("z-ai/glm-5.2 is eligible (PR③'s widened pool) yet refused as an override here because it collides with VERIFY_MODEL — #1270 takes priority over catalog membership", () => {
    expect(allEligibleModelSlugs()).toContain(VERIFY_MODEL);
    const result = validateOverride(VERIFY_MODEL, VERIFY_MODEL);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/#1270/);
  });

  it("HARD OWNER RULE check: haiku is excluded from ui's AUTO-picker eligibility, but an explicit override to haiku is still ALLOWED (eligibility constrains the auto picker, not a user's explicit choice)", () => {
    // Confirms the premise this describe block is testing: haiku really is
    // ineligible for ui's auto picker...
    expect(isModelEligibleForTaskType(HAIKU, "ui")).toBe(false);
    // ...yet validateOverride (which is task-type-agnostic by design) still
    // accepts it as a valid override, because it's eligible for AT LEAST ONE
    // task type (mechanical, under the widened PR③ pool) and thus in the union.
    expect(validateOverride(HAIKU, VERIFY_MODEL)).toEqual({ ok: true });
  });
});
