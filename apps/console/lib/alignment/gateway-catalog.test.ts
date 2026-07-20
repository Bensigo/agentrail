import { describe, it, expect, vi, afterEach } from "vitest";
import { getModelFromCatalog, isKnownModelSlug, getSnapshotMeta } from "./gateway-catalog";
import snapshotJson from "./openrouter-catalog.snapshot.json";

// A slug that will never legitimately exist — used everywhere below as the
// "deliberately-bad slug" case (AC3's "an invalid/retired slug fails loud").
const DEFINITELY_FAKE_SLUG = "not-a-real-provider/definitely-fake-model-9999";

describe("getModelFromCatalog: known slugs resolve from the committed snapshot", () => {
  // Self-consistency, not a re-assertion of literal numbers (that is
  // openrouter-normalize.test.ts's job against pinned fixtures): whatever the
  // snapshot file currently says for a shipped slug, the lookup module must
  // surface verbatim. This stays true across every future `catalog:refresh`
  // run without editing this test.
  for (const slug of [
    "anthropic/claude-sonnet-5",
    "anthropic/claude-opus-4.8",
    "anthropic/claude-haiku-4.5",
    "z-ai/glm-5.2",
  ]) {
    it(`${slug}: lookup matches the snapshot row exactly`, () => {
      const expected = snapshotJson.models.find((m) => m.id === slug);
      expect(expected, `fixture assumption broken: ${slug} missing from the committed snapshot`).toBeDefined();

      const result = getModelFromCatalog(slug);
      expect(result).not.toBeNull();
      expect(result?.slug).toBe(slug);
      expect(result?.inUsdPerMTok).toBe(expected!.inUsdPerMTok);
      expect(result?.outUsdPerMTok).toBe(expected!.outUsdPerMTok);
      expect(result?.contextLength).toBe(expected!.contextLength);
      expect(result?.topProvider).toEqual(expected!.topProvider);
    });
  }

  it("every rate is strictly non-negative (a real price or a real free-tier 0, never a negative/garbage value)", () => {
    for (const model of snapshotJson.models) {
      const result = getModelFromCatalog(model.id);
      expect(result!.inUsdPerMTok).toBeGreaterThanOrEqual(0);
      expect(result!.outUsdPerMTok).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("getModelFromCatalog / isKnownModelSlug: unknown slug fails loud, never a silent $0", () => {
  it("getModelFromCatalog returns null (not a fabricated $0 entry) for a fake slug", () => {
    expect(getModelFromCatalog(DEFINITELY_FAKE_SLUG)).toBeNull();
  });

  it("isKnownModelSlug returns false for the same fake slug", () => {
    expect(isKnownModelSlug(DEFINITELY_FAKE_SLUG)).toBe(false);
  });

  it("isKnownModelSlug returns true for every slug the snapshot actually carries", () => {
    // Spot-check across the full 300+-model list, not just the 4 shipped
    // seats — proves the lookup is a real full-catalog index, not a
    // hardcoded shortlist wearing a catalog's clothes.
    for (const model of snapshotJson.models) {
      expect(isKnownModelSlug(model.id)).toBe(true);
    }
  });

  it("an empty string and a slug with only a provider prefix are both unknown", () => {
    expect(isKnownModelSlug("")).toBe(false);
    expect(isKnownModelSlug("anthropic/")).toBe(false);
    expect(isKnownModelSlug("anthropic")).toBe(false);
  });
});

describe("AC2: the snapshot serves lookups with zero network dependency", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getModelFromCatalog still resolves correctly when fetch is stubbed to always reject", () => {
    // Simulates "OpenRouter is down": if this module made any network call at
    // lookup time, this stub would make every lookup below throw/reject.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network is down — simulated for this test")))
    );

    const result = getModelFromCatalog("anthropic/claude-sonnet-5");
    expect(result).not.toBeNull();
    expect(result?.inUsdPerMTok).toBeGreaterThan(0);
    expect(isKnownModelSlug("anthropic/claude-sonnet-5")).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("snapshotAgeMs and fetchedAt are surfaced on every successful lookup (age must be visible, AC2)", () => {
    const result = getModelFromCatalog("anthropic/claude-sonnet-5");
    expect(result?.fetchedAt).toBe(snapshotJson.fetchedAt);
    expect(typeof result?.snapshotAgeMs).toBe("number");
    // The snapshot was fetched in the past (or this instant) — age is never negative.
    expect(result?.snapshotAgeMs).toBeGreaterThanOrEqual(0);
  });
});

describe("getSnapshotMeta: snapshot-level staleness surfaced independent of any one slug", () => {
  it("reports sourceUrl, fetchedAt, modelCount, and a non-negative age", () => {
    const meta = getSnapshotMeta();
    expect(meta.sourceUrl).toBe("https://openrouter.ai/api/v1/models");
    expect(meta.fetchedAt).toBe(snapshotJson.fetchedAt);
    expect(meta.modelCount).toBe(snapshotJson.models.length);
    expect(meta.snapshotAgeMs).toBeGreaterThanOrEqual(0);
  });

  it("modelCount matches the committed snapshot's own modelCount field (self-consistent)", () => {
    expect(getSnapshotMeta().modelCount).toBe(snapshotJson.modelCount);
  });
});
