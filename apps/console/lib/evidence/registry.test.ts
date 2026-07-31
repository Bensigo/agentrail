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
    // Task 5: `factory` (availability: "internal") is now a real catalog
    // entry, unconditionally credentialed regardless of the (here, empty)
    // connector rows — see the dedicated test below. It declares
    // changes+search_events, so those two verbs are excluded from the
    // "zero declared providers" claim this test makes; every OTHER verb
    // still has zero providers with no connector rows supplied.
    for (const verb of EVIDENCE_VERBS) {
      if (verb === "changes" || verb === "search_events") continue;
      expect(caps[verb]).toEqual([]);
    }
    expect(caps.changes).toEqual(["factory"]);
    expect(caps.search_events).toEqual(["factory"]);
  });

  it("linear (non-evidence catalog entry) contributes to no verb; github (Task 6) now contributes to 'changes' — factory (internal) covers changes/search_events regardless", () => {
    // linear carries no `evidence` field (Task 7 adds it) — this is the
    // "declared nothing" case for it specifically, using the real catalog
    // directly. github NOW declares `evidence: ["changes"]` (Task 6) — its
    // row here is `enabled: true, hasSecret: false`, the SHAPE an oauth
    // connector row actually has (see the oauth-credentialed describe block
    // below for why `hasSecret` is structurally always false for it).
    // factory (Task 5, availability: "internal") is unconditionally
    // credentialed regardless of the connector rows passed here.
    const caps = evidenceCapabilities(CONNECTOR_CATALOG, [
      { provider: "github", enabled: true, hasSecret: false },
      { provider: "linear", enabled: true, hasSecret: true },
    ]);
    for (const verb of EVIDENCE_VERBS) {
      if (verb === "changes" || verb === "search_events") continue;
      expect(caps[verb]).toEqual([]);
    }
    expect(caps.changes.slice().sort()).toEqual(["factory", "github"]);
    expect(caps.search_events).toEqual(["factory"]);
  });

  it("Task 5: factory appears in evidenceCapabilities using the REAL CONNECTOR_CATALOG, with zero connector rows at all (internal availability needs none)", () => {
    const caps = evidenceCapabilities(CONNECTOR_CATALOG, []);
    expect(caps.changes).toContain("factory");
    expect(caps.search_events).toContain("factory");
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

/**
 * Task 6 fix: `evidenceCapabilities` previously required `hasSecret` for
 * EVERY non-internal provider (`Boolean(row?.enabled && row?.hasSecret)`).
 * An oauth-connected provider's credential is never a `connectors.secret`
 * value (github's is a per-installation token minted fresh per call — see
 * `github.ts`'s own doc-comment and `github-app-token.ts`), so its connector
 * row's `hasSecret` is structurally ALWAYS false: under the old formula,
 * github could never have been credentialed no matter how connected the
 * workspace was — a real gap between T4 (only ever exercised secret-based/
 * internal rows) and T6 (the first EXTERNAL oauth evidence provider). These
 * tests pin the minimal fix: a catalog entry's `connectMethod === "oauth"`
 * makes `enabled` ALONE the credentialed signal; every other entry
 * (`connectMethod: "secret"` or absent) keeps the original check untouched.
 */
describe("evidenceCapabilities — oauth-connected providers (Task 6 fix)", () => {
  it("an oauth entry is credentialed by `enabled` alone — hasSecret:false does not exclude it", () => {
    const caps = evidenceCapabilities(
      [{ kind: "oauth-provider", connectMethod: "oauth", capabilities: { evidence: ["changes"] } }],
      [{ provider: "oauth-provider", enabled: true, hasSecret: false }]
    );
    expect(caps.changes).toEqual(["oauth-provider"]);
  });

  it("an oauth entry is excluded when its row is disabled, even with hasSecret:true", () => {
    const caps = evidenceCapabilities(
      [{ kind: "oauth-provider", connectMethod: "oauth", capabilities: { evidence: ["changes"] } }],
      [{ provider: "oauth-provider", enabled: false, hasSecret: true }]
    );
    expect(caps.changes).toEqual([]);
  });

  it("an oauth entry is excluded with no connector row at all (never connected)", () => {
    const caps = evidenceCapabilities(
      [{ kind: "oauth-provider", connectMethod: "oauth", capabilities: { evidence: ["changes"] } }],
      []
    );
    expect(caps.changes).toEqual([]);
  });

  it("a non-oauth entry (connectMethod absent) is UNCHANGED by the fix — still requires hasSecret", () => {
    const caps = evidenceCapabilities(
      [{ kind: "secret-provider", capabilities: { evidence: ["changes"] } }],
      [{ provider: "secret-provider", enabled: true, hasSecret: false }]
    );
    expect(caps.changes).toEqual([]);
  });

  it("a non-oauth entry (connectMethod: 'secret' explicitly) is UNCHANGED by the fix", () => {
    const caps = evidenceCapabilities(
      [{ kind: "secret-provider", connectMethod: "secret", capabilities: { evidence: ["changes"] } }],
      [{ provider: "secret-provider", enabled: true, hasSecret: false }]
    );
    expect(caps.changes).toEqual([]);
  });

  it("github — using the REAL CONNECTOR_CATALOG — appears under 'changes' once connected (enabled), with the realistic no-stored-secret row shape", () => {
    const caps = evidenceCapabilities(CONNECTOR_CATALOG, [
      { provider: "github", enabled: true, hasSecret: false },
    ]);
    expect(caps.changes).toContain("github");
  });

  it("github — using the REAL CONNECTOR_CATALOG — is excluded when disconnected (no row)", () => {
    const caps = evidenceCapabilities(CONNECTOR_CATALOG, []);
    expect(caps.changes).not.toContain("github");
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
