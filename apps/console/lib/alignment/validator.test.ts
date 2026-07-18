import { describe, it, expect } from "vitest";
import { validateOverride } from "./validator";
import { MODEL_CATALOG } from "./catalog";

const OPUS = MODEL_CATALOG.refactor.slug; // anthropic/claude-opus-4-8
const HAIKU = MODEL_CATALOG.mechanical.slug; // anthropic/claude-haiku-4-5
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
