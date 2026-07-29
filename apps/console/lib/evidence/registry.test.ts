import { describe, expect, it, test } from "vitest";
import { CONNECTOR_CATALOG } from "../../app/(dashboard)/dashboard/[workspaceId]/connectors/components/connector-helpers";
import { adapterFor, evidenceCapabilities, registerAdapter } from "./registry";
import { EVIDENCE_DEGRADATION_REASONS, EVIDENCE_VERBS } from "./types";

describe("EVIDENCE_DEGRADATION_REASONS taxonomy (Fix Round 1: capture_failed added)", () => {
  it("is the exact ten-reason closed set, including capture_failed", () => {
    expect([...EVIDENCE_DEGRADATION_REASONS].sort()).toEqual(
      [
        "bad_body",
        "bad_request",
        "capture_failed",
        "config_missing",
        "no_investigation",
        "no_provider",
        "unauthorized",
        "unexpected_status",
        "unreachable",
        "upstream_error",
      ].sort()
    );
    expect(EVIDENCE_DEGRADATION_REASONS).toHaveLength(10);
  });

  it("contains capture_failed exactly once", () => {
    expect(EVIDENCE_DEGRADATION_REASONS.filter((r) => r === "capture_failed")).toHaveLength(1);
  });
});

/**
 * This is the architecture-preserving test (Task 4 brief, Step 1, verbatim):
 * adding a future observability provider must be exactly a catalog entry + an
 * adapter, with ZERO changes to any prompt/agent/route code. `fakeobs` here
 * stands in for a provider Tasks 5-7 haven't written yet — if this test ever
 * needs the route or the registry's OWN implementation to change to pass,
 * that is a regression in the capability-layer's whole reason for existing.
 */
test("a new provider = catalog entry + adapter, nothing else", async () => {
  registerAdapter({
    provider: "fakeobs",
    verbs: ["signals"],
    query: async () => ({ ok: true, raw: "error_rate=0.42" }),
  });
  const caps = evidenceCapabilities(
    [...CONNECTOR_CATALOG, { kind: "fakeobs", capabilities: { evidence: ["signals"] } }],
    [{ provider: "fakeobs", enabled: true, hasSecret: true }]
  );
  expect(caps.signals).toContain("fakeobs"); // discoverable
  // and queryable through the route with zero prompt/subagent changes (route test below)
});

describe("evidenceCapabilities", () => {
  it("returns every verb as a key, even ones with zero declared providers (family-nested from day one)", () => {
    const caps = evidenceCapabilities(CONNECTOR_CATALOG, []);
    expect(Object.keys(caps).sort()).toEqual([...EVIDENCE_VERBS].sort());
    for (const verb of EVIDENCE_VERBS) {
      expect(caps[verb]).toEqual([]);
    }
  });

  it("a catalog entry with no declared evidence capability contributes to no verb", () => {
    // The real CONNECTOR_CATALOG entries carry no `evidence` field yet (Task 7
    // populates it) — this is exactly that "declared nothing" case, using the
    // real catalog directly.
    const caps = evidenceCapabilities(CONNECTOR_CATALOG, [
      { provider: "github", enabled: true, hasSecret: true },
      { provider: "linear", enabled: true, hasSecret: true },
    ]);
    for (const verb of EVIDENCE_VERBS) {
      expect(caps[verb]).toEqual([]);
    }
  });

  it("excludes a declared provider with no connector row at all", () => {
    const caps = evidenceCapabilities(
      [{ kind: "no-row-provider", capabilities: { evidence: ["changes"] } }],
      []
    );
    expect(caps.changes).toEqual([]);
  });

  it("excludes a declared provider that is enabled but has no stored secret", () => {
    const caps = evidenceCapabilities(
      [{ kind: "no-secret-provider", capabilities: { evidence: ["changes"] } }],
      [{ provider: "no-secret-provider", enabled: true, hasSecret: false }]
    );
    expect(caps.changes).toEqual([]);
  });

  it("excludes a declared provider that has a secret but is disabled", () => {
    const caps = evidenceCapabilities(
      [{ kind: "disabled-provider", capabilities: { evidence: ["changes"] } }],
      [{ provider: "disabled-provider", enabled: false, hasSecret: true }]
    );
    expect(caps.changes).toEqual([]);
  });

  it("a declared, enabled, credentialed provider appears under every verb it declares", () => {
    const caps = evidenceCapabilities(
      [{ kind: "multi", capabilities: { evidence: ["changes", "search_events"] } }],
      [{ provider: "multi", enabled: true, hasSecret: true }]
    );
    expect(caps.changes).toEqual(["multi"]);
    expect(caps.search_events).toEqual(["multi"]);
    expect(caps.signals).toEqual([]);
  });

  it("an internal-availability provider needs no connector row at all — short-circuits the credentialed check (Task 5's factory adapter has none)", () => {
    const caps = evidenceCapabilities(
      [
        {
          kind: "factory",
          availability: "internal",
          capabilities: { evidence: ["changes", "search_events"] },
        },
      ],
      [] // deliberately no connector row for "factory"
    );
    expect(caps.changes).toContain("factory");
    expect(caps.search_events).toContain("factory");
  });

  it("an internal-availability provider still appears even if a stray disabled row exists for it", () => {
    const caps = evidenceCapabilities(
      [{ kind: "factory", availability: "internal", capabilities: { evidence: ["changes"] } }],
      [{ provider: "factory", enabled: false, hasSecret: false }]
    );
    expect(caps.changes).toContain("factory");
  });
});

describe("registerAdapter / adapterFor", () => {
  it("returns null for a provider nothing ever registered", () => {
    expect(adapterFor("totally-unregistered-provider")).toBeNull();
  });

  it("adapterFor finds an adapter registered for its own provider slug", async () => {
    registerAdapter({
      provider: "roundtrip-provider",
      verbs: ["probe"],
      query: async () => ({ ok: true, raw: "pong" }),
    });
    const adapter = adapterFor("roundtrip-provider");
    expect(adapter).not.toBeNull();
    expect(adapter!.verbs).toEqual(["probe"]);
    await expect(
      adapter!.query("ws-1", { verb: "probe", windowStart: "2026-07-29T00:00:00Z", windowEnd: "2026-07-29T01:00:00Z" }, null)
    ).resolves.toEqual({ ok: true, raw: "pong" });
  });

  it("re-registering the same provider slug replaces the adapter (last write wins, by provider key)", () => {
    registerAdapter({ provider: "dup-provider", verbs: ["probe"], query: async () => ({ ok: true, raw: "v1" }) });
    registerAdapter({ provider: "dup-provider", verbs: ["signals"], query: async () => ({ ok: true, raw: "v2" }) });
    const adapter = adapterFor("dup-provider");
    expect(adapter!.verbs).toEqual(["signals"]);
  });
});
