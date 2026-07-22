// Unit tests for the create_workspace core (issue #1264 PR ①). No SDK, no
// live network: the single HTTP call is an injected `transport` seam, so
// every branch — success and every failure — is exercised deterministically.
//
// Unlike send_connect_link (which collapses EVERY non-2xx into one generic
// message), this tool is human-approved before it ever runs and its
// endpoint's 409 family is deliberately honest (see
// apps/console/app/api/v1/runner/workspaces/route.ts's doc-comment) — so a
// 409's own message is surfaced VERBATIM for Jace to relay. Every other
// non-2xx (400, 401, 404 — the endpoint's own deliberately-indistinguishable
// resolution-failure case — 500) collapses to ONE generic honest string,
// same posture as send_connect_link.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CREATE_WORKSPACE_PATH,
  GENERIC_FAILURE_MESSAGE,
  resolveConsoleConfig,
  buildCreateWorkspaceUrl,
  runCreateWorkspace,
} from "../agent/lib/create_workspace.core.mjs";

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
// resolveConsoleConfig / buildCreateWorkspaceUrl
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

test("buildCreateWorkspaceUrl joins the base url and the create-workspace path, no query params", () => {
  assert.equal(
    buildCreateWorkspaceUrl("https://c.example.com"),
    `https://c.example.com${CREATE_WORKSPACE_PATH}`
  );
  assert.equal(CREATE_WORKSPACE_PATH, "/api/v1/runner/workspaces");
});

// ---------------------------------------------------------------------------
// runCreateWorkspace — success
// ---------------------------------------------------------------------------

test("runCreateWorkspace posts { eveSessionId, name } with bearer + JSON headers, and returns { workspaceId, name, url } on 201", async () => {
  const transport = fakeTransport(() => ({
    status: 201,
    json: async () => ({
      workspaceId: "ws-new-1",
      name: "Acme Co",
      slug: "acme-co",
      url: "https://console.example.com/dashboard/ws-new-1",
    }),
  }));

  const result = await runCreateWorkspace({
    eveSessionId: "eve-session-1",
    name: "Acme Co",
    env: ENV,
    transport,
  });

  assert.deepEqual(result, {
    workspaceId: "ws-new-1",
    name: "Acme Co",
    url: "https://console.example.com/dashboard/ws-new-1",
  });

  assert.equal(transport.calls.length, 1);
  const { url, init } = transport.calls[0];
  assert.equal(url, `https://console.example.com${CREATE_WORKSPACE_PATH}`);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer tok-secret-123");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(init.body), { eveSessionId: "eve-session-1", name: "Acme Co" });
});

test("runCreateWorkspace trims the name before sending it", async () => {
  const transport = fakeTransport(() => ({
    status: 201,
    json: async () => ({ workspaceId: "ws-1", name: "Acme", url: "https://c/dashboard/ws-1" }),
  }));

  await runCreateWorkspace({ eveSessionId: "eve-session-1", name: "  Acme  ", env: ENV, transport });

  assert.deepEqual(JSON.parse(transport.calls[0].init.body), {
    eveSessionId: "eve-session-1",
    name: "Acme",
  });
});

// ---------------------------------------------------------------------------
// runCreateWorkspace — the 409 family surfaces its message VERBATIM
// ---------------------------------------------------------------------------

test("on 409, surfaces the console's own message verbatim (already-attached conversation)", async () => {
  const transport = fakeTransport(() => ({
    status: 409,
    json: async () => ({ error: "this conversation is already attached to a workspace" }),
  }));

  const result = await runCreateWorkspace({
    eveSessionId: "eve-session-1",
    name: "Acme",
    env: ENV,
    transport,
  });

  assert.equal(result, "this conversation is already attached to a workspace");
});

test("on 409, surfaces the console's own message verbatim (slug exhausted, a DIFFERENT 409 message)", async () => {
  const transport = fakeTransport(() => ({
    status: 409,
    json: async () => ({ error: "a workspace with a similar name already exists — try a different name" }),
  }));

  const result = await runCreateWorkspace({
    eveSessionId: "eve-session-1",
    name: "Acme",
    env: ENV,
    transport,
  });

  assert.equal(result, "a workspace with a similar name already exists — try a different name");
});

test("on 409 with a malformed/missing error body, falls back to the generic message rather than throwing", async () => {
  const transport = fakeTransport(() => ({ status: 409, json: async () => ({}) }));
  const result = await runCreateWorkspace({
    eveSessionId: "eve-session-1",
    name: "Acme",
    env: ENV,
    transport,
  });
  assert.equal(result, GENERIC_FAILURE_MESSAGE);
});

test("on 409 with non-JSON body, falls back to the generic message rather than throwing", async () => {
  const transport = fakeTransport(() => ({
    status: 409,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  }));
  const result = await runCreateWorkspace({
    eveSessionId: "eve-session-1",
    name: "Acme",
    env: ENV,
    transport,
  });
  assert.equal(result, GENERIC_FAILURE_MESSAGE);
});

// ---------------------------------------------------------------------------
// runCreateWorkspace — issue #1364 PR②: the sign-up-gate 409 shape returns a
// STRUCTURED object, not a string, so the model can relay a real link.
// ---------------------------------------------------------------------------

test("on 409 with a signupUrl: returns { signupRequired: true, url, expiresAt } instead of a plain string", async () => {
  const transport = fakeTransport(() => ({
    status: 409,
    json: async () => ({
      error: "sign up to create a workspace",
      signupUrl: "https://console.example.com/signup/abc123",
      expiresAt: "2026-07-22T12:30:00.000Z",
    }),
  }));

  const result = await runCreateWorkspace({
    eveSessionId: "eve-session-1",
    name: "Acme",
    env: ENV,
    transport,
  });

  assert.deepEqual(result, {
    signupRequired: true,
    url: "https://console.example.com/signup/abc123",
    expiresAt: "2026-07-22T12:30:00.000Z",
  });
});

test("on 409 with a signupUrl but a missing/malformed expiresAt: still returns the structured shape, with an empty expiresAt rather than throwing", async () => {
  const transport = fakeTransport(() => ({
    status: 409,
    json: async () => ({
      error: "sign up to create a workspace",
      signupUrl: "https://console.example.com/signup/abc123",
    }),
  }));

  const result = await runCreateWorkspace({
    eveSessionId: "eve-session-1",
    name: "Acme",
    env: ENV,
    transport,
  });

  assert.deepEqual(result, {
    signupRequired: true,
    url: "https://console.example.com/signup/abc123",
    expiresAt: "",
  });
});

test("on 409 with an EMPTY signupUrl string: does NOT take the structured path — falls back to the verbatim error string (empty string is falsy, same treatment as a missing field)", async () => {
  const transport = fakeTransport(() => ({
    status: 409,
    json: async () => ({
      error: "this conversation is already attached to a workspace",
      signupUrl: "",
    }),
  }));

  const result = await runCreateWorkspace({
    eveSessionId: "eve-session-1",
    name: "Acme",
    env: ENV,
    transport,
  });

  assert.equal(result, "this conversation is already attached to a workspace");
});

test("a 409 WITHOUT signupUrl (already-attached / slug-exhausted) still returns the plain verbatim string, unaffected", async () => {
  const transport = fakeTransport(() => ({
    status: 409,
    json: async () => ({ error: "this conversation is already attached to a workspace" }),
  }));

  const result = await runCreateWorkspace({
    eveSessionId: "eve-session-1",
    name: "Acme",
    env: ENV,
    transport,
  });

  assert.equal(result, "this conversation is already attached to a workspace");
  assert.equal(typeof result, "string");
});

// ---------------------------------------------------------------------------
// runCreateWorkspace — every OTHER failure outcome collapses to ONE generic
// message (same posture as send_connect_link)
// ---------------------------------------------------------------------------

test("returns GENERIC_FAILURE_MESSAGE when the console config is unset — no wasted call", async () => {
  const transport = fakeTransport(() => ({ status: 201, json: async () => ({}) }));
  const result = await runCreateWorkspace({ eveSessionId: "eve-session-1", name: "Acme", env: {}, transport });
  assert.equal(result, GENERIC_FAILURE_MESSAGE);
  assert.equal(transport.calls.length, 0);
});

test("returns GENERIC_FAILURE_MESSAGE when eveSessionId is blank — no wasted call", async () => {
  const transport = fakeTransport(() => ({ status: 201, json: async () => ({}) }));
  const result = await runCreateWorkspace({ eveSessionId: "  ", name: "Acme", env: ENV, transport });
  assert.equal(result, GENERIC_FAILURE_MESSAGE);
  assert.equal(transport.calls.length, 0);
});

test("returns GENERIC_FAILURE_MESSAGE when name is blank — no wasted call", async () => {
  const transport = fakeTransport(() => ({ status: 201, json: async () => ({}) }));
  const result = await runCreateWorkspace({ eveSessionId: "eve-session-1", name: "   ", env: ENV, transport });
  assert.equal(result, GENERIC_FAILURE_MESSAGE);
  assert.equal(transport.calls.length, 0);
});

test("returns GENERIC_FAILURE_MESSAGE when the transport throws (network error) — one attempt, no retry, no leaked detail", async () => {
  const transport = fakeTransport(() => {
    throw new Error("ECONNREFUSED 10.0.0.1:443 — secret-looking internal detail");
  });
  const result = await runCreateWorkspace({ eveSessionId: "eve-session-1", name: "Acme", env: ENV, transport });
  assert.equal(result, GENERIC_FAILURE_MESSAGE);
  assert.equal(transport.calls.length, 1);
  assert.doesNotMatch(result, /ECONNREFUSED|10\.0\.0\.1/);
});

test("returns GENERIC_FAILURE_MESSAGE on 400 (name validation) — never surfaced verbatim, only 409 is", async () => {
  const transport = fakeTransport(() => ({ status: 400, json: async () => ({ error: "name must be 1-80 characters" }) }));
  const result = await runCreateWorkspace({ eveSessionId: "eve-session-1", name: "Acme", env: ENV, transport });
  assert.equal(result, GENERIC_FAILURE_MESSAGE);
});

test("returns GENERIC_FAILURE_MESSAGE on 404 — the endpoint's own deliberately-indistinguishable resolution refusal, never surfaced as a distinct case", async () => {
  const transport = fakeTransport(() => ({ status: 404, json: async () => ({ error: "Chat identity not found" }) }));
  const result = await runCreateWorkspace({ eveSessionId: "eve-session-1", name: "Acme", env: ENV, transport });
  assert.equal(result, GENERIC_FAILURE_MESSAGE);
});

test("returns GENERIC_FAILURE_MESSAGE on 401 and 500 — same generic message, status never leaked", async () => {
  for (const status of [401, 500]) {
    const transport = fakeTransport(() => ({ status, json: async () => ({ error: "whatever" }) }));
    const result = await runCreateWorkspace({ eveSessionId: "eve-session-1", name: "Acme", env: ENV, transport });
    assert.equal(result, GENERIC_FAILURE_MESSAGE, `status ${status} must fail with the generic message`);
  }
});

test("returns GENERIC_FAILURE_MESSAGE when the console responds 201 with non-JSON", async () => {
  const transport = fakeTransport(() => ({
    status: 201,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  }));
  const result = await runCreateWorkspace({ eveSessionId: "eve-session-1", name: "Acme", env: ENV, transport });
  assert.equal(result, GENERIC_FAILURE_MESSAGE);
});

test("returns GENERIC_FAILURE_MESSAGE when the console responds 201 with a body missing workspaceId/name/url", async () => {
  const transport = fakeTransport(() => ({ status: 201, json: async () => ({ workspaceId: "ws-1" }) }));
  const result = await runCreateWorkspace({ eveSessionId: "eve-session-1", name: "Acme", env: ENV, transport });
  assert.equal(result, GENERIC_FAILURE_MESSAGE);
});

test("the bearer token never rides out in a failure result", async () => {
  const transport = fakeTransport(() => ({ status: 500, json: async () => ({}) }));
  const result = await runCreateWorkspace({ eveSessionId: "eve-session-1", name: "Acme", env: ENV, transport });
  assert.doesNotMatch(result, /tok-secret-123/);
});
