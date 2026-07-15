// Unit tests for the workspace-memory fetch core (no SDK, no live network).
// The single HTTP call is an injected `transport` seam, so every branch —
// success and each degraded outcome — is exercised deterministically.
//
// The fetch NEVER throws and NEVER retries. On an unconfigured, unreachable, or
// failing console the core returns a degraded result carrying a stable reason +
// a cause-free note (never the workspace's content, never transport error text,
// never the bearer token).
//
// The workspace is still NEVER a param (derived from the bearer token
// server-side) — but the model-supplied `query` now IS, so the console can rank
// + trim via `retrieveMemory` instead of dumping the whole memory table.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MEMORY_PATH,
  resolveConsoleConfig,
  buildMemoryUrl,
  classifyStatus,
  degraded,
  projectItems,
  fetchWorkspaceMemory,
} from "../agent/lib/fetch_workspace_memory.core.mjs";

const ENV = {
  JACE_CONSOLE_BASE_URL: "https://console.example.com",
  JACE_CONSOLE_TOKEN: "tok-secret-123",
};

// A fake transport that records how many times it was called and with what, so
// we can assert single-attempt (no-retry) behaviour and header shape.
function fakeTransport(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// resolveConsoleConfig
// ---------------------------------------------------------------------------

test("resolveConsoleConfig resolves + trims + de-slashes when both vars are set", () => {
  const cfg = resolveConsoleConfig({
    JACE_CONSOLE_BASE_URL: "  https://c.example.com/  ",
    JACE_CONSOLE_TOKEN: "  tok  ",
  });
  assert.deepEqual(cfg, { ok: true, baseUrl: "https://c.example.com", token: "tok" });
});

test("resolveConsoleConfig reports exactly which vars are missing", () => {
  assert.deepEqual(resolveConsoleConfig({}), {
    ok: false,
    missing: ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"],
  });
  assert.deepEqual(resolveConsoleConfig({ JACE_CONSOLE_BASE_URL: "https://c" }), {
    ok: false,
    missing: ["JACE_CONSOLE_TOKEN"],
  });
  assert.deepEqual(resolveConsoleConfig({ JACE_CONSOLE_TOKEN: "t" }), {
    ok: false,
    missing: ["JACE_CONSOLE_BASE_URL"],
  });
  // Whitespace-only is treated as unset.
  assert.deepEqual(resolveConsoleConfig({ JACE_CONSOLE_BASE_URL: "   ", JACE_CONSOLE_TOKEN: "  " }), {
    ok: false,
    missing: ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"],
  });
});

// ---------------------------------------------------------------------------
// buildMemoryUrl / classifyStatus
// ---------------------------------------------------------------------------

test("buildMemoryUrl omits the query param when the query is empty/whitespace", () => {
  assert.equal(buildMemoryUrl("https://c.example.com"), `https://c.example.com${MEMORY_PATH}`);
  assert.equal(buildMemoryUrl("https://c.example.com", ""), `https://c.example.com${MEMORY_PATH}`);
  assert.equal(buildMemoryUrl("https://c.example.com", "   "), `https://c.example.com${MEMORY_PATH}`);
});

test("buildMemoryUrl carries the (trimmed, URL-encoded) query as a query param", () => {
  const url = buildMemoryUrl("https://c.example.com", "  test commands & conventions  ");
  assert.equal(
    url,
    `https://c.example.com${MEMORY_PATH}?query=${encodeURIComponent("test commands & conventions")}`
  );
});

test("buildMemoryUrl NEVER carries a workspace param — the workspace comes from the token", () => {
  const url = buildMemoryUrl("https://c.example.com", "workspaceId=evil-tenant");
  // The (attacker-controlled) query text is URL-encoded as the VALUE of `query`,
  // never parsed as its own param name.
  assert.doesNotMatch(url, /[?&]workspaceId=/);
});

test("classifyStatus maps HTTP status to outcome (2xx ok, rest degraded reasons)", () => {
  assert.deepEqual(classifyStatus(200), { ok: true });
  assert.deepEqual(classifyStatus(204), { ok: true });
  assert.deepEqual(classifyStatus(400), { ok: false, reason: "bad_request" });
  assert.deepEqual(classifyStatus(401), { ok: false, reason: "unauthorized" });
  assert.deepEqual(classifyStatus(403), { ok: false, reason: "unauthorized" });
  assert.deepEqual(classifyStatus(404), { ok: false, reason: "not_found" });
  assert.deepEqual(classifyStatus(500), { ok: false, reason: "upstream_error" });
  assert.deepEqual(classifyStatus(503), { ok: false, reason: "upstream_error" });
  assert.deepEqual(classifyStatus(418), { ok: false, reason: "unexpected_status" });
});

test("degraded carries a stable reason + cause-free note and no free-form text", () => {
  const d = degraded("unreachable", { status: 0 });
  assert.equal(d.ok, false);
  assert.equal(d.degraded, true);
  assert.equal(d.reason, "unreachable");
  assert.equal(typeof d.note, "string");
  assert.ok(d.note.length > 0);
  assert.equal(d.status, 0);
  // Unknown reasons still yield a safe note (never undefined).
  assert.equal(typeof degraded("who_knows").note, "string");
});

// ---------------------------------------------------------------------------
// projectItems — light projection to the pinned contract shape
// ---------------------------------------------------------------------------

test("projectItems keeps only the contract fields, drops unknowns, normalizes tags", () => {
  const body = {
    items: [
      {
        id: "m1",
        source: "CONTEXT.md",
        content: "Use pnpm, never npm.",
        type: "convention",
        writtenBy: "human",
        tags: ["build"],
        repositoryName: "agentrail",
        createdAt: "2026-07-01T00:00:00Z",
        lastUsedAt: "2026-07-14T00:00:00Z",
        secretExtraField: "should be dropped",
      },
      // Missing/loose fields normalize: null-fills + tags → [].
      { id: "m2", content: "Tests run with node --test." },
    ],
  };
  const items = projectItems(body);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    id: "m1",
    source: "CONTEXT.md",
    content: "Use pnpm, never npm.",
    type: "convention",
    writtenBy: "human",
    tags: ["build"],
    repositoryName: "agentrail",
    createdAt: "2026-07-01T00:00:00Z",
    lastUsedAt: "2026-07-14T00:00:00Z",
  });
  assert.ok(!("secretExtraField" in items[0]), "unknown fields must be dropped");
  assert.deepEqual(items[1].tags, []);
  assert.equal(items[1].source, null);
});

test("projectItems tolerates a missing/non-array items field", () => {
  assert.deepEqual(projectItems({}), []);
  assert.deepEqual(projectItems({ items: null }), []);
  assert.deepEqual(projectItems(null), []);
  assert.deepEqual(projectItems("nope"), []);
});

// ---------------------------------------------------------------------------
// projectItems — content is hardened via hardenUntrusted (injection defense)
// ---------------------------------------------------------------------------

test("projectItems runs content through hardenUntrusted: strips invisibles, defangs dangerous schemes", () => {
  const items = projectItems({
    items: [
      {
        id: "m1",
        // Zero-width space (U+200B) smuggled into otherwise-ordinary content,
        // plus a javascript: URL — both are hardenUntrusted's job to neutralize.
        content: "click javascript:alert(1) ​now",
      },
    ],
  });
  assert.equal(items.length, 1);
  assert.ok(!items[0].content.includes("​"), "zero-width space must be stripped");
  assert.match(items[0].content, /javascript\[:\]alert\(1\)/, "dangerous scheme must be defanged");
});

test("projectItems caps content length (defense-in-depth on top of retrieveMemory's own 1000-char trim)", () => {
  const longContent = "a".repeat(5000);
  const items = projectItems({ items: [{ id: "m1", content: longContent }] });
  assert.ok(items[0].content.length <= 1001, "content must be capped (1000 chars + ellipsis)");
  assert.notEqual(items[0].content, longContent);
});

test("projectItems tolerates missing content (hardens the empty string, not null)", () => {
  const items = projectItems({ items: [{ id: "m1" }] });
  assert.equal(items[0].content, "");
});

// ---------------------------------------------------------------------------
// fetchWorkspaceMemory — success
// ---------------------------------------------------------------------------

test("fetchWorkspaceMemory returns projected items + count on 200 (ok path)", async () => {
  const body = {
    items: [
      { id: "m1", source: "CONTEXT.md", content: "Use pnpm.", type: "convention", writtenBy: "human", tags: ["build"], repositoryName: "agentrail", createdAt: "t0", lastUsedAt: "t1" },
      { id: "m2", source: "README.md", content: "node --test", type: "command", writtenBy: "jace", tags: [], repositoryName: "agentrail", createdAt: "t0", lastUsedAt: "t1" },
    ],
  };
  const transport = fakeTransport(() => ({ status: 200, json: async () => body }));
  const res = await fetchWorkspaceMemory({ query: "build and test commands", env: ENV, transport });
  assert.equal(res.ok, true);
  assert.equal(res.count, 2);
  assert.equal(res.items.length, 2);
  assert.equal(res.items[0].id, "m1");
  assert.equal(res.items[1].content, "node --test");
  // Exactly one attempt, with the bearer + accept headers, to a URL carrying the query.
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].init.headers.Authorization, "Bearer tok-secret-123");
  assert.equal(transport.calls[0].init.headers.Accept, "application/json");
  assert.equal(
    transport.calls[0].url,
    `https://console.example.com${MEMORY_PATH}?query=${encodeURIComponent("build and test commands")}`
  );
});

test("fetchWorkspaceMemory sends no query param when query is omitted/empty", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => ({ items: [] }) }));
  await fetchWorkspaceMemory({ env: ENV, transport });
  assert.equal(transport.calls[0].url, `https://console.example.com${MEMORY_PATH}`);
});

test("fetchWorkspaceMemory returns an empty list (not degraded) when the workspace has no memory", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => ({ items: [] }) }));
  const res = await fetchWorkspaceMemory({ query: "anything", env: ENV, transport });
  assert.equal(res.ok, true);
  assert.equal(res.count, 0);
  assert.deepEqual(res.items, []);
});

// ---------------------------------------------------------------------------
// fetchWorkspaceMemory — degraded outcomes, never throws, never retries
// ---------------------------------------------------------------------------

test("degraded(config_missing) with the missing vars when console is unconfigured", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => ({ items: [] }) }));
  const res = await fetchWorkspaceMemory({ env: {}, transport });
  assert.equal(res.degraded, true);
  assert.equal(res.reason, "config_missing");
  assert.deepEqual(res.missing, ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"]);
  assert.equal(transport.calls.length, 0); // no wasted call
});

test("degraded(unreachable) when the transport throws — one attempt, no retry", async () => {
  const transport = fakeTransport(() => {
    throw new Error("ECONNREFUSED 10.0.0.1:443 — secret-looking internal detail");
  });
  const res = await fetchWorkspaceMemory({ env: ENV, transport });
  assert.equal(res.degraded, true);
  assert.equal(res.reason, "unreachable");
  assert.equal(transport.calls.length, 1); // exactly one attempt, not retried
  // The transport's error text must NOT leak into the result.
  assert.doesNotMatch(JSON.stringify(res), /ECONNREFUSED|10\.0\.0\.1|secret-looking/);
});

test("degraded maps each non-2xx status and carries the status, without the token", async () => {
  const cases = [
    [400, "bad_request"],
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "not_found"],
    [500, "upstream_error"],
    [418, "unexpected_status"],
  ];
  for (const [status, reason] of cases) {
    const transport = fakeTransport(() => ({ status, json: async () => ({}) }));
    const res = await fetchWorkspaceMemory({ env: ENV, transport });
    assert.equal(res.degraded, true, `status ${status} must degrade`);
    assert.equal(res.reason, reason, `status ${status} → ${reason}`);
    assert.equal(res.status, status);
    assert.equal(transport.calls.length, 1);
    // The bearer token must never ride out in a degraded result.
    assert.doesNotMatch(JSON.stringify(res), /tok-secret-123/);
  }
});

test("degraded(bad_body) when the console responds 200 with non-JSON", async () => {
  const transport = fakeTransport(() => ({
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  }));
  const res = await fetchWorkspaceMemory({ env: ENV, transport });
  assert.equal(res.degraded, true);
  assert.equal(res.reason, "bad_body");
  assert.equal(res.status, 200);
});
