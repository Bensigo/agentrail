// Unit tests for the Slack reply worker sender core (Task 4,
// docs/superpowers/specs/2026-07-29-slack-multi-workspace-design.md §4). No
// SDK, no live network: the single HTTP call is an injected `transport` seam
// — mirrors console_chat_reply.core.test.mjs's idiom exactly.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SLACK_REPLY_PATH,
  resolveConsoleConfig,
  buildSlackReplyUrl,
  resolveSlackReplyTeamId,
  postSlackReply,
} from "../agent/lib/slack_reply.core.mjs";

const ENV = {
  JACE_CONSOLE_BASE_URL: "https://console.example.com",
  JACE_CONSOLE_TOKEN: "tok-secret-123",
};

function fakeTransport(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  fn.calls = calls;
  return fn;
}

test("SLACK_REPLY_PATH is the runner slack-reply endpoint", () => {
  assert.equal(SLACK_REPLY_PATH, "/api/v1/runner/slack-reply");
});

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

test("buildSlackReplyUrl joins the base url and path", () => {
  assert.equal(buildSlackReplyUrl("https://console.example.com"), "https://console.example.com/api/v1/runner/slack-reply");
});

// --- resolveSlackReplyTeamId ------------------------------------------------

test("resolveSlackReplyTeamId reads teamId from auth.current.attributes", () => {
  const auth = { current: { attributes: { teamId: "TEAM_A" } } };
  assert.equal(resolveSlackReplyTeamId(auth), "TEAM_A");
});

test("resolveSlackReplyTeamId falls back to auth.initiator.attributes when current is absent", () => {
  const auth = { initiator: { attributes: { teamId: "TEAM_B" } } };
  assert.equal(resolveSlackReplyTeamId(auth), "TEAM_B");
});

// Mirrors discord-followup.core.mjs's resolveSessionAuthAttributes
// current-over-initiator preference and its rationale: `initiator` is set
// once at session start and never refreshed, so a resumed conversation's
// turn 2+ must prefer `current` or it can serve a STALE team id.
test("resolveSlackReplyTeamId prefers current over initiator when both are present", () => {
  const auth = {
    current: { attributes: { teamId: "TEAM_CURRENT" } },
    initiator: { attributes: { teamId: "TEAM_STALE_INITIATOR" } },
  };
  assert.equal(resolveSlackReplyTeamId(auth), "TEAM_CURRENT");
});

test("resolveSlackReplyTeamId returns '' (never undefined/null) for missing/malformed auth", () => {
  assert.equal(resolveSlackReplyTeamId(undefined), "");
  assert.equal(resolveSlackReplyTeamId(null), "");
  assert.equal(resolveSlackReplyTeamId({}), "");
  assert.equal(resolveSlackReplyTeamId({ current: { attributes: {} } }), "");
  assert.equal(resolveSlackReplyTeamId({ current: { attributes: { teamId: 123 } } }), "");
  assert.equal(resolveSlackReplyTeamId({ current: { attributes: null } }), "");
});

test("resolveSlackReplyTeamId trims whitespace", () => {
  assert.equal(resolveSlackReplyTeamId({ current: { attributes: { teamId: "  T1  " } } }), "T1");
});

// --- postSlackReply ----------------------------------------------------------

test("postSlackReply throws when console config is unset — never silently drops the reply", async () => {
  await assert.rejects(
    () =>
      postSlackReply({
        teamId: "T1",
        channelId: "C123",
        text: "hi",
        env: {},
        transport: fakeTransport(() => ({ status: 200 })),
      }),
    /missing JACE_CONSOLE_BASE_URL, JACE_CONSOLE_TOKEN/,
  );
});

// THE CRITICAL GUARD: a missing team id must never silently post — there is
// no default token this could ever safely fall back to.
test("postSlackReply throws when teamId is missing, before making any network call", async () => {
  const transport = fakeTransport(() => ({ status: 200 }));
  await assert.rejects(
    () =>
      postSlackReply({
        teamId: undefined,
        channelId: "C123",
        text: "hi",
        env: ENV,
        transport,
      }),
    /no Slack team id/,
  );
  assert.equal(transport.calls.length, 0);
});

test("postSlackReply throws when teamId is blank, before making any network call", async () => {
  const transport = fakeTransport(() => ({ status: 200 }));
  await assert.rejects(
    () =>
      postSlackReply({
        teamId: "   ",
        channelId: "C123",
        text: "hi",
        env: ENV,
        transport,
      }),
    /no Slack team id/,
  );
  assert.equal(transport.calls.length, 0);
});

test("postSlackReply throws when channelId is missing, before making any network call", async () => {
  const transport = fakeTransport(() => ({ status: 200 }));
  await assert.rejects(
    () =>
      postSlackReply({
        teamId: "T1",
        channelId: "",
        text: "hi",
        env: ENV,
        transport,
      }),
    /missing channelId/,
  );
  assert.equal(transport.calls.length, 0);
});

test("postSlackReply POSTs the expected body + bearer header on a happy path", async () => {
  const transport = fakeTransport(() => ({ status: 200 }));
  await postSlackReply({
    teamId: "T1",
    channelId: "C123",
    threadTs: "1700000000.000100",
    text: "hi there",
    env: ENV,
    transport,
  });

  assert.equal(transport.calls.length, 1);
  const { url, init } = transport.calls[0];
  assert.equal(url, "https://console.example.com/api/v1/runner/slack-reply");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer tok-secret-123");
  assert.deepEqual(JSON.parse(init.body), {
    teamId: "T1",
    channelId: "C123",
    text: "hi there",
    threadTs: "1700000000.000100",
  });
});

test("postSlackReply omits threadTs from the body entirely when not given (a DM), never as an empty string", async () => {
  const transport = fakeTransport(() => ({ status: 200 }));
  await postSlackReply({
    teamId: "T1",
    channelId: "D0PNCRP9N",
    text: "hi",
    env: ENV,
    transport,
  });

  const { init } = transport.calls[0];
  const body = JSON.parse(init.body);
  assert.deepEqual(body, { teamId: "T1", channelId: "D0PNCRP9N", text: "hi" });
  assert.equal(Object.hasOwn(body, "threadTs"), false);
});

test("postSlackReply throws on a non-2xx response", async () => {
  await assert.rejects(
    () =>
      postSlackReply({
        teamId: "T1",
        channelId: "C123",
        text: "hi",
        env: ENV,
        transport: fakeTransport(() => ({ status: 502 })),
      }),
    /console returned 502/,
  );
});

test("postSlackReply propagates a transport-level network error unwrapped", async () => {
  const boom = new Error("network down");
  await assert.rejects(
    () =>
      postSlackReply({
        teamId: "T1",
        channelId: "C123",
        text: "hi",
        env: ENV,
        transport: fakeTransport(() => {
          throw boom;
        }),
      }),
    /network down/,
  );
});
