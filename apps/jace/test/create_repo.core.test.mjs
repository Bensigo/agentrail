// Unit tests for the create_repo core (issue #1265 PR ②). No SDK, no live
// network: the single HTTP call is an injected `transport` seam, so every
// branch — success and every failure — is exercised deterministically.
//
// Failure posture mirrors create_workspace: this tool is human-approved
// before it ever runs and the endpoint's 409 family
// (apps/console/app/api/v1/runner/repos/route.ts) is honest by design, so a
// 409's own `error` message is surfaced VERBATIM for Jace to relay — EXCEPT
// the name-taken case (AC3's retry path), where a short retry nudge is
// appended so Jace doesn't have to invent one. Every other non-2xx (400,
// 401, 404, 500, 502) collapses to ONE generic honest string, same posture
// as create_workspace / send_connect_link.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CREATE_REPO_PATH,
  GENERIC_FAILURE_MESSAGE,
  resolveConsoleConfig,
  buildCreateRepoUrl,
  runCreateRepo,
} from "../agent/lib/create_repo.core.mjs";

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

function successBody({
  fullName = "acme/widgets",
  url = "https://github.com/acme/widgets",
  isPrivate = true,
  webhookCreated = true,
  onboardQueued = false,
} = {}) {
  return {
    repo: { fullName, url, private: isPrivate },
    connected: true,
    webhookCreated,
    onboardQueued,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// resolveConsoleConfig / buildCreateRepoUrl
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

test("buildCreateRepoUrl joins the base url and the create-repo path, no query params", () => {
  assert.equal(
    buildCreateRepoUrl("https://c.example.com"),
    `https://c.example.com${CREATE_REPO_PATH}`
  );
  assert.equal(CREATE_REPO_PATH, "/api/v1/runner/repos");
});

// ---------------------------------------------------------------------------
// runCreateRepo — success
// ---------------------------------------------------------------------------

test("runCreateRepo posts { eveSessionId, name } with bearer + JSON headers, and returns { url, fullName, private, webhookCreated, onboardQueued } on 201", async () => {
  const transport = fakeTransport(() => ({
    status: 201,
    json: async () => successBody({ webhookCreated: true, onboardQueued: true }),
  }));

  const result = await runCreateRepo({
    eveSessionId: "eve-session-1",
    name: "widgets",
    env: ENV,
    transport,
  });

  assert.deepEqual(result, {
    url: "https://github.com/acme/widgets",
    fullName: "acme/widgets",
    private: true,
    webhookCreated: true,
    onboardQueued: true,
  });

  assert.equal(transport.calls.length, 1);
  const { url, init } = transport.calls[0];
  assert.equal(url, `https://console.example.com${CREATE_REPO_PATH}`);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer tok-secret-123");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(init.body), { eveSessionId: "eve-session-1", name: "widgets" });
});

test("runCreateRepo trims the name before sending it", async () => {
  const transport = fakeTransport(() => ({ status: 201, json: async () => successBody() }));

  await runCreateRepo({ eveSessionId: "eve-session-1", name: "  widgets  ", env: ENV, transport });

  assert.deepEqual(JSON.parse(transport.calls[0].init.body), {
    eveSessionId: "eve-session-1",
    name: "widgets",
  });
});

test("runCreateRepo omits `private` from the request body when not supplied — the console's own default wins", async () => {
  const transport = fakeTransport(() => ({ status: 201, json: async () => successBody() }));

  await runCreateRepo({ eveSessionId: "eve-session-1", name: "widgets", env: ENV, transport });

  const parsed = JSON.parse(transport.calls[0].init.body);
  assert.equal("private" in parsed, false);
});

test("runCreateRepo forwards an explicit `private: true` in the request body", async () => {
  const transport = fakeTransport(() => ({ status: 201, json: async () => successBody() }));

  await runCreateRepo({
    eveSessionId: "eve-session-1",
    name: "widgets",
    private: true,
    env: ENV,
    transport,
  });

  assert.deepEqual(JSON.parse(transport.calls[0].init.body), {
    eveSessionId: "eve-session-1",
    name: "widgets",
    private: true,
  });
});

test("runCreateRepo forwards an explicit `private: false` in the request body — false must not be dropped as falsy", async () => {
  const transport = fakeTransport(() => ({ status: 201, json: async () => successBody() }));

  await runCreateRepo({
    eveSessionId: "eve-session-1",
    name: "widgets",
    private: false,
    env: ENV,
    transport,
  });

  const parsed = JSON.parse(transport.calls[0].init.body);
  assert.equal("private" in parsed, true);
  assert.equal(parsed.private, false);
});

test("runCreateRepo success is honest when the webhook could not be created — returns webhookCreated: false rather than hiding it", async () => {
  const transport = fakeTransport(() => ({
    status: 201,
    json: async () => successBody({ webhookCreated: false, onboardQueued: false }),
  }));

  const result = await runCreateRepo({
    eveSessionId: "eve-session-1",
    name: "widgets",
    env: ENV,
    transport,
  });

  assert.equal(result.webhookCreated, false);
});

// ---------------------------------------------------------------------------
// runCreateRepo — the 409 family: name-taken gets a retry nudge appended;
// every other 409 surfaces its message VERBATIM
// ---------------------------------------------------------------------------

test("on 409 name-taken, appends a retry nudge to the route's own message (AC3 retry path)", async () => {
  const transport = fakeTransport(() => ({
    status: 409,
    json: async () => ({ error: "a repo named widgets already exists on your GitHub" }),
  }));

  const result = await runCreateRepo({
    eveSessionId: "eve-session-1",
    name: "widgets",
    env: ENV,
    transport,
  });

  assert.equal(
    result,
    "a repo named widgets already exists on your GitHub — pick another name and I'll try again"
  );
});

test("on 409 no-workspace, surfaces the console's own message verbatim — no retry nudge appended", async () => {
  const transport = fakeTransport(() => ({
    status: 409,
    json: async () => ({ error: "this conversation has no workspace yet — create one first" }),
  }));

  const result = await runCreateRepo({
    eveSessionId: "eve-session-1",
    name: "widgets",
    env: ENV,
    transport,
  });

  assert.equal(result, "this conversation has no workspace yet — create one first");
});

test("on 409, a message that merely contains 'already exists' but doesn't end with the route's exact name-taken tail does NOT get the retry nudge — verbatim only", async () => {
  const transport = fakeTransport(() => ({
    status: 409,
    json: async () => ({ error: "a repo named widgets already exists" }),
  }));

  const result = await runCreateRepo({
    eveSessionId: "eve-session-1",
    name: "widgets",
    env: ENV,
    transport,
  });

  assert.equal(result, "a repo named widgets already exists");
});

test("on 409 no-token, surfaces the console's own message verbatim — no retry nudge appended", async () => {
  const transport = fakeTransport(() => ({
    status: 409,
    json: async () => ({
      error: "no GitHub account with repo access is connected for this workspace yet",
    }),
  }));

  const result = await runCreateRepo({
    eveSessionId: "eve-session-1",
    name: "widgets",
    env: ENV,
    transport,
  });

  assert.equal(result, "no GitHub account with repo access is connected for this workspace yet");
});

test("on 409 stale-credentials, surfaces the console's own message verbatim — no retry nudge appended", async () => {
  const transport = fakeTransport(() => ({
    status: 409,
    json: async () => ({ error: "GitHub rejected the stored credentials" }),
  }));

  const result = await runCreateRepo({
    eveSessionId: "eve-session-1",
    name: "widgets",
    env: ENV,
    transport,
  });

  assert.equal(result, "GitHub rejected the stored credentials");
});

test("on 409 with a malformed/missing error body, falls back to the generic message rather than throwing", async () => {
  const transport = fakeTransport(() => ({ status: 409, json: async () => ({}) }));
  const result = await runCreateRepo({
    eveSessionId: "eve-session-1",
    name: "widgets",
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
  const result = await runCreateRepo({
    eveSessionId: "eve-session-1",
    name: "widgets",
    env: ENV,
    transport,
  });
  assert.equal(result, GENERIC_FAILURE_MESSAGE);
});

// ---------------------------------------------------------------------------
// runCreateRepo — every OTHER failure outcome collapses to ONE generic
// message (same posture as create_workspace / send_connect_link)
// ---------------------------------------------------------------------------

test("returns GENERIC_FAILURE_MESSAGE when the console config is unset — no wasted call", async () => {
  const transport = fakeTransport(() => ({ status: 201, json: async () => successBody() }));
  const result = await runCreateRepo({ eveSessionId: "eve-session-1", name: "widgets", env: {}, transport });
  assert.equal(result, GENERIC_FAILURE_MESSAGE);
  assert.equal(transport.calls.length, 0);
});

test("returns GENERIC_FAILURE_MESSAGE when eveSessionId is blank — no wasted call", async () => {
  const transport = fakeTransport(() => ({ status: 201, json: async () => successBody() }));
  const result = await runCreateRepo({ eveSessionId: "  ", name: "widgets", env: ENV, transport });
  assert.equal(result, GENERIC_FAILURE_MESSAGE);
  assert.equal(transport.calls.length, 0);
});

test("returns GENERIC_FAILURE_MESSAGE when name is blank — no wasted call", async () => {
  const transport = fakeTransport(() => ({ status: 201, json: async () => successBody() }));
  const result = await runCreateRepo({ eveSessionId: "eve-session-1", name: "   ", env: ENV, transport });
  assert.equal(result, GENERIC_FAILURE_MESSAGE);
  assert.equal(transport.calls.length, 0);
});

test("returns GENERIC_FAILURE_MESSAGE when the transport throws (network error) — one attempt, no retry, no leaked detail", async () => {
  const transport = fakeTransport(() => {
    throw new Error("ECONNREFUSED 10.0.0.1:443 — secret-looking internal detail");
  });
  const result = await runCreateRepo({ eveSessionId: "eve-session-1", name: "widgets", env: ENV, transport });
  assert.equal(result, GENERIC_FAILURE_MESSAGE);
  assert.equal(transport.calls.length, 1);
  assert.doesNotMatch(result, /ECONNREFUSED|10\.0\.0\.1/);
});

test("returns GENERIC_FAILURE_MESSAGE on 400, 401, 404, 500, and 502 — same generic message, status never leaked", async () => {
  for (const status of [400, 401, 404, 500, 502]) {
    const transport = fakeTransport(() => ({ status, json: async () => ({ error: "whatever" }) }));
    const result = await runCreateRepo({ eveSessionId: "eve-session-1", name: "widgets", env: ENV, transport });
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
  const result = await runCreateRepo({ eveSessionId: "eve-session-1", name: "widgets", env: ENV, transport });
  assert.equal(result, GENERIC_FAILURE_MESSAGE);
});

test("returns GENERIC_FAILURE_MESSAGE when the console responds 201 with a body missing repo.fullName/repo.url", async () => {
  const transport = fakeTransport(() => ({
    status: 201,
    json: async () => ({ repo: { private: true }, connected: true, webhookCreated: true, onboardQueued: false, warnings: [] }),
  }));
  const result = await runCreateRepo({ eveSessionId: "eve-session-1", name: "widgets", env: ENV, transport });
  assert.equal(result, GENERIC_FAILURE_MESSAGE);
});

test("returns GENERIC_FAILURE_MESSAGE when the console responds 201 with webhookCreated/onboardQueued missing or non-boolean", async () => {
  const transport = fakeTransport(() => ({
    status: 201,
    json: async () => ({
      repo: { fullName: "acme/widgets", url: "https://github.com/acme/widgets", private: true },
      connected: true,
      warnings: [],
    }),
  }));
  const result = await runCreateRepo({ eveSessionId: "eve-session-1", name: "widgets", env: ENV, transport });
  assert.equal(result, GENERIC_FAILURE_MESSAGE);
});

test("the bearer token never rides out in a failure result", async () => {
  const transport = fakeTransport(() => ({ status: 500, json: async () => ({}) }));
  const result = await runCreateRepo({ eveSessionId: "eve-session-1", name: "widgets", env: ENV, transport });
  assert.doesNotMatch(result, /tok-secret-123/);
});
