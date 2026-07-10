// Unit tests for the researcher subagent's pure cores (no SDK, no network,
// no model). Covers AC7: connection config / env resolution, the Playwright
// read-only tool allowlist, the brief schema shape, and the graceful-
// degradation path.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT7_MCP_URL,
  CONTEXT7_TOOLS,
  DEFAULT_PLAYWRIGHT_MCP_URL,
  PLAYWRIGHT_READONLY_TOOLS,
  PLAYWRIGHT_FORBIDDEN_TOOLS,
  resolvePlaywrightUrl,
  resolveContext7Headers,
  resolveResearchSources,
} from "../agent/subagents/researcher/lib/connections.core.mjs";
import {
  BRIEF_SCHEMA,
  CONFIDENCE_LEVELS,
  SOURCE_KINDS,
  validateBrief,
} from "../agent/subagents/researcher/lib/brief.core.mjs";

// ---------------------------------------------------------------------------
// Connection config / env resolution
// ---------------------------------------------------------------------------

test("Context7 points at the hosted MCP endpoint with only its two read tools", () => {
  assert.equal(CONTEXT7_MCP_URL, "https://mcp.context7.com/mcp");
  assert.deepEqual([...CONTEXT7_TOOLS].sort(), ["query-docs", "resolve-library-id"]);
});

test("resolvePlaywrightUrl falls back to the local-dev default when unset/blank", () => {
  assert.equal(resolvePlaywrightUrl({}), DEFAULT_PLAYWRIGHT_MCP_URL);
  assert.equal(resolvePlaywrightUrl({ JACE_PLAYWRIGHT_MCP_URL: "" }), DEFAULT_PLAYWRIGHT_MCP_URL);
  assert.equal(resolvePlaywrightUrl({ JACE_PLAYWRIGHT_MCP_URL: "   " }), DEFAULT_PLAYWRIGHT_MCP_URL);
  assert.equal(DEFAULT_PLAYWRIGHT_MCP_URL, "http://localhost:8931/mcp");
});

test("resolvePlaywrightUrl honours and trims an explicit sidecar URL", () => {
  assert.equal(
    resolvePlaywrightUrl({ JACE_PLAYWRIGHT_MCP_URL: "  http://playwright:8931/mcp  " }),
    "http://playwright:8931/mcp",
  );
});

test("Context7 headers carry the API key only when set (public tier otherwise)", () => {
  assert.deepEqual(resolveContext7Headers({}), {});
  assert.deepEqual(resolveContext7Headers({ CONTEXT7_API_KEY: "" }), {});
  assert.deepEqual(resolveContext7Headers({ CONTEXT7_API_KEY: "   " }), {});
  assert.deepEqual(resolveContext7Headers({ CONTEXT7_API_KEY: "  sk-ctx7  " }), {
    CONTEXT7_API_KEY: "sk-ctx7",
  });
});

// ---------------------------------------------------------------------------
// Playwright read-only allowlist — the safety property
// ---------------------------------------------------------------------------

test("Playwright allowlist is navigation/observation only — no write tool leaks in", () => {
  // Every allowed tool is a browser_* tool.
  for (const t of PLAYWRIGHT_READONLY_TOOLS) {
    assert.match(t, /^browser_/, `${t} is not a browser_ tool`);
  }
  // Core read tools are present.
  assert.ok(PLAYWRIGHT_READONLY_TOOLS.includes("browser_navigate"));
  assert.ok(PLAYWRIGHT_READONLY_TOOLS.includes("browser_snapshot"));

  // The allowlist and the forbidden (write/interaction/code-exec) set are
  // disjoint: no forbidden tool may appear in the allowlist.
  const allow = new Set(PLAYWRIGHT_READONLY_TOOLS);
  for (const forbidden of PLAYWRIGHT_FORBIDDEN_TOOLS) {
    assert.ok(!allow.has(forbidden), `write tool ${forbidden} must not be allowed`);
  }

  // Belt-and-braces: no allowed tool name hints at a mutating action, even if
  // a future Playwright release renames tools.
  const MUTATING_HINT =
    /click|type|fill|upload|evaluate|run_code|press|select|drag|hover|dialog|cookie|storage|tab|close|resize|install/i;
  for (const t of PLAYWRIGHT_READONLY_TOOLS) {
    assert.doesNotMatch(t, MUTATING_HINT, `${t} looks like a mutating tool`);
  }
});

// ---------------------------------------------------------------------------
// Brief schema shape (AC1 output contract)
// ---------------------------------------------------------------------------

test("BRIEF_SCHEMA declares the full brief contract", () => {
  assert.equal(BRIEF_SCHEMA.type, "object");
  assert.equal(BRIEF_SCHEMA.additionalProperties, false);
  assert.deepEqual(
    [...BRIEF_SCHEMA.required].sort(),
    [
      "alternatives",
      "citations",
      "confidence",
      "degraded",
      "openQuestions",
      "recommendedApproach",
      "sourcesUsed",
    ],
  );
  assert.deepEqual(BRIEF_SCHEMA.properties.confidence.enum, CONFIDENCE_LEVELS);
  assert.deepEqual(BRIEF_SCHEMA.properties.sourcesUsed.items.enum, SOURCE_KINDS);
  // Citations tie a claim to a URL (version optional).
  const cite = BRIEF_SCHEMA.properties.citations.items;
  assert.deepEqual([...cite.required].sort(), ["claim", "url"]);
  assert.ok("version" in cite.properties);
});

test("validateBrief accepts a well-formed brief", () => {
  const brief = {
    recommendedApproach: "Use defineMcpClientConnection with tools.allow.",
    alternatives: [{ approach: "stdio transport", whyNot: "Eve needs Streamable HTTP/SSE." }],
    citations: [
      { claim: "url must speak Streamable HTTP or SSE", url: "https://eve.dev/docs/connections/mcp", version: "0.19.0" },
    ],
    openQuestions: ["Does the hosted server rate-limit keyless callers?"],
    confidence: "high",
    degraded: false,
    sourcesUsed: ["context7", "web"],
  };
  const { ok, errors } = validateBrief(brief);
  assert.ok(ok, `expected valid brief, got errors: ${errors.join("; ")}`);
});

test("validateBrief rejects malformed briefs", () => {
  assert.equal(validateBrief(null).ok, false);
  assert.equal(validateBrief({}).ok, false);
  // Missing recommendedApproach.
  assert.equal(
    validateBrief({
      alternatives: [],
      citations: [],
      openQuestions: [],
      confidence: "high",
      degraded: false,
      sourcesUsed: [],
    }).ok,
    false,
  );
  // Bad confidence enum.
  assert.equal(
    validateBrief({
      recommendedApproach: "x",
      alternatives: [],
      citations: [],
      openQuestions: [],
      confidence: "certain",
      degraded: false,
      sourcesUsed: [],
    }).ok,
    false,
  );
  // Citation missing a url.
  assert.equal(
    validateBrief({
      recommendedApproach: "x",
      alternatives: [],
      citations: [{ claim: "y" }],
      openQuestions: [],
      confidence: "low",
      degraded: false,
      sourcesUsed: [],
    }).ok,
    false,
  );
  // Alternative missing whyNot.
  assert.equal(
    validateBrief({
      recommendedApproach: "x",
      alternatives: [{ approach: "a" }],
      citations: [],
      openQuestions: [],
      confidence: "low",
      degraded: false,
      sourcesUsed: [],
    }).ok,
    false,
  );
});

// ---------------------------------------------------------------------------
// Graceful-degradation path (AC5)
// ---------------------------------------------------------------------------

test("resolveResearchSources reports full sources when the web is reachable", () => {
  assert.deepEqual(resolveResearchSources({ webReachable: true }), {
    sourcesUsed: ["context7", "web"],
    degraded: false,
  });
});

test("resolveResearchSources degrades to Context7-only when the sidecar is down", () => {
  const degraded = resolveResearchSources({ webReachable: false });
  assert.deepEqual(degraded, { sourcesUsed: ["context7"], degraded: true });
});

test("a degraded (Context7-only) brief still validates against the schema contract", () => {
  const { sourcesUsed, degraded } = resolveResearchSources({ webReachable: false });
  const brief = {
    recommendedApproach: "Per Context7 docs, use X; live-web confirmation unavailable.",
    alternatives: [],
    citations: [{ claim: "X is the documented default", url: "https://mcp.context7.com/mcp", version: "n/a" }],
    openQuestions: ["Browser sidecar unreachable — release-note check skipped."],
    confidence: "medium",
    degraded,
    sourcesUsed,
  };
  const res = validateBrief(brief);
  assert.ok(res.ok, `degraded brief should validate, got: ${res.errors.join("; ")}`);
  assert.equal(brief.degraded, true);
  assert.deepEqual(brief.sourcesUsed, ["context7"]);
});
