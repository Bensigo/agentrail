// Connection core for the qa subagent: URL resolution honors env with a
// local-dev fallback, and the allowlists can never smuggle in a capability
// the spec excludes (JS evaluate, uploads, cookie/storage manipulation).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_AGENT_BROWSER_MCP_URL,
  DEFAULT_BROWSER_USE_MCP_URL,
  resolveAgentBrowserUrl,
  resolveBrowserUseUrl,
  AGENT_BROWSER_QA_TOOLS,
  BROWSER_USE_QA_TOOLS,
  QA_FORBIDDEN_TOOL_PATTERNS,
} from "../agent/subagents/qa/lib/connections.core.mjs";

test("agent-browser URL: env wins, trimmed", () => {
  assert.equal(
    resolveAgentBrowserUrl({ JACE_AGENT_BROWSER_MCP_URL: "  http://sidecar:9000/mcp  " }),
    "http://sidecar:9000/mcp",
  );
});

test("agent-browser URL: falls back when unset, empty, or blank", () => {
  assert.equal(resolveAgentBrowserUrl({}), DEFAULT_AGENT_BROWSER_MCP_URL);
  assert.equal(resolveAgentBrowserUrl(), DEFAULT_AGENT_BROWSER_MCP_URL);
  assert.equal(
    resolveAgentBrowserUrl({ JACE_AGENT_BROWSER_MCP_URL: "   " }),
    DEFAULT_AGENT_BROWSER_MCP_URL,
  );
});

test("browser-use URL: env wins, trimmed; falls back otherwise", () => {
  assert.equal(
    resolveBrowserUseUrl({ JACE_BROWSER_USE_MCP_URL: " http://sidecar:9001/mcp " }),
    "http://sidecar:9001/mcp",
  );
  assert.equal(resolveBrowserUseUrl({}), DEFAULT_BROWSER_USE_MCP_URL);
});

test("the two sidecars get distinct default ports", () => {
  assert.notEqual(DEFAULT_AGENT_BROWSER_MCP_URL, DEFAULT_BROWSER_USE_MCP_URL);
});

for (const [name, list] of [
  ["AGENT_BROWSER_QA_TOOLS", AGENT_BROWSER_QA_TOOLS],
  ["BROWSER_USE_QA_TOOLS", BROWSER_USE_QA_TOOLS],
]) {
  test(`${name} is a non-empty list of unique non-empty strings`, () => {
    assert.ok(Array.isArray(list) && list.length > 0);
    assert.ok(list.every((t) => typeof t === "string" && t.length > 0));
    assert.equal(new Set(list).size, list.length);
  });

  test(`${name} never allowlists an excluded capability (spec §4)`, () => {
    for (const tool of list) {
      for (const pattern of QA_FORBIDDEN_TOOL_PATTERNS) {
        assert.ok(
          !pattern.test(tool),
          `${name} contains '${tool}' which matches forbidden pattern ${pattern}`,
        );
      }
    }
  });
}

test("forbidden patterns cover the spec's exclusions", () => {
  const mustCatch = [
    "browser_evaluate",
    "agent_browser_eval",
    "upload_file",
    "set_cookie",
    "local_storage_write",
  ];
  for (const bad of mustCatch) {
    assert.ok(
      QA_FORBIDDEN_TOOL_PATTERNS.some((p) => p.test(bad)),
      `no pattern catches '${bad}'`,
    );
  }
});
