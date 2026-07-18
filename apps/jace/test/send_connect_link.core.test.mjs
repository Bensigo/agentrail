// Unit tests for the connect-link mint core (issue #1263 PR ②). No SDK, no
// live network: the single HTTP call is an injected `transport` seam, so
// every branch — success and every failure — is exercised deterministically.
//
// The fetch NEVER throws and NEVER retries. On an unconfigured, unreachable,
// or failing console this returns ONE honest, generic failure string —
// deliberately not a per-reason breakdown (unlike fetch_workspace_memory):
// this is a WRITE Jace is about to narrate to the user mid-conversation, and
// a finer-grained reason would risk leaking which of the console's
// indistinguishable-by-design 404 cases this was (unknown identity vs
// already-linked vs foreign-tenant — see connect-link/route.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONNECT_LINK_PATH,
  FAILURE_MESSAGE,
  resolveConsoleConfig,
  buildConnectLinkUrl,
  sendConnectLink,
} from "../agent/lib/send_connect_link.core.mjs";

const ENV = {
  JACE_CONSOLE_BASE_URL: "https://console.example.com",
  JACE_CONSOLE_TOKEN: "tok-secret-123",
};

// A fake transport that records how many times it was called and with what,
// so we can assert single-attempt (no-retry) behaviour and request shape.
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
// resolveConsoleConfig / buildConnectLinkUrl
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
});

test("buildConnectLinkUrl joins the base url and the connect-link path, no query params", () => {
  assert.equal(
    buildConnectLinkUrl("https://c.example.com"),
    `https://c.example.com${CONNECT_LINK_PATH}`
  );
  assert.equal(CONNECT_LINK_PATH, "/api/v1/runner/connect-link");
});

// ---------------------------------------------------------------------------
// sendConnectLink — success
// ---------------------------------------------------------------------------

test("sendConnectLink posts the eveSessionId as the body, with bearer + JSON headers, and returns { url, expiresAt } on 200", async () => {
  const transport = fakeTransport(() => ({
    status: 200,
    json: async () => ({ url: "https://console.example.com/connect/abc123", expiresAt: "2026-07-18T00:30:00.000Z" }),
  }));

  const result = await sendConnectLink({ eveSessionId: "eve-session-1", env: ENV, transport });

  assert.deepEqual(result, {
    url: "https://console.example.com/connect/abc123",
    expiresAt: "2026-07-18T00:30:00.000Z",
  });

  assert.equal(transport.calls.length, 1);
  const { url, init } = transport.calls[0];
  assert.equal(url, `https://console.example.com${CONNECT_LINK_PATH}`);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer tok-secret-123");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(init.body), { eveSessionId: "eve-session-1" });
});

// ---------------------------------------------------------------------------
// sendConnectLink — failure outcomes, all collapse to ONE honest string
// ---------------------------------------------------------------------------

test("returns FAILURE_MESSAGE when the console config is unset — no wasted call", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => ({}) }));
  const result = await sendConnectLink({ eveSessionId: "eve-session-1", env: {}, transport });
  assert.equal(result, FAILURE_MESSAGE);
  assert.equal(transport.calls.length, 0);
});

test("returns FAILURE_MESSAGE when eveSessionId is blank — no wasted call", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => ({}) }));
  const result = await sendConnectLink({ eveSessionId: "  ", env: ENV, transport });
  assert.equal(result, FAILURE_MESSAGE);
  assert.equal(transport.calls.length, 0);
});

test("returns FAILURE_MESSAGE when the transport throws (network error) — one attempt, no retry", async () => {
  const transport = fakeTransport(() => {
    throw new Error("ECONNREFUSED 10.0.0.1:443 — secret-looking internal detail");
  });
  const result = await sendConnectLink({ eveSessionId: "eve-session-1", env: ENV, transport });
  assert.equal(result, FAILURE_MESSAGE);
  assert.equal(transport.calls.length, 1);
  assert.doesNotMatch(result, /ECONNREFUSED|10\.0\.0\.1/);
});

test("returns FAILURE_MESSAGE on 404 — the console's indistinguishable-by-design refusal, never surfaced as a distinct case", async () => {
  const transport = fakeTransport(() => ({ status: 404, json: async () => ({ error: "Chat identity not found" }) }));
  const result = await sendConnectLink({ eveSessionId: "eve-session-1", env: ENV, transport });
  assert.equal(result, FAILURE_MESSAGE);
});

test("returns FAILURE_MESSAGE on every other non-2xx status (400, 401, 500) — same generic message, status never leaked", async () => {
  for (const status of [400, 401, 500]) {
    const transport = fakeTransport(() => ({ status, json: async () => ({}) }));
    const result = await sendConnectLink({ eveSessionId: "eve-session-1", env: ENV, transport });
    assert.equal(result, FAILURE_MESSAGE, `status ${status} must fail with the generic message`);
  }
});

test("returns FAILURE_MESSAGE when the console responds 200 with non-JSON", async () => {
  const transport = fakeTransport(() => ({
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  }));
  const result = await sendConnectLink({ eveSessionId: "eve-session-1", env: ENV, transport });
  assert.equal(result, FAILURE_MESSAGE);
});

test("returns FAILURE_MESSAGE when the console responds 200 with a body missing url/expiresAt", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => ({ url: "https://c/connect/x" }) }));
  const result = await sendConnectLink({ eveSessionId: "eve-session-1", env: ENV, transport });
  assert.equal(result, FAILURE_MESSAGE);
});

test("the bearer token never rides out in a failure result", async () => {
  const transport = fakeTransport(() => ({ status: 500, json: async () => ({}) }));
  const result = await sendConnectLink({ eveSessionId: "eve-session-1", env: ENV, transport });
  assert.doesNotMatch(result, /tok-secret-123/);
});
