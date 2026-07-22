// Unit tests for the console-chat worker sender core (#1288 PR②). No SDK, no
// live network: the single HTTP call is an injected `transport` seam, so
// every branch — success and every failure — is exercised deterministically.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_REPLY_PATH,
  resolveConsoleConfig,
  buildChatReplyUrl,
  postConsoleChatReply,
} from "../agent/lib/console_chat_reply.core.mjs";

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

test("CHAT_REPLY_PATH is the runner chat-reply endpoint", () => {
  assert.equal(CHAT_REPLY_PATH, "/api/v1/runner/chat-reply");
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

test("buildChatReplyUrl joins the base url and path", () => {
  assert.equal(buildChatReplyUrl("https://console.example.com"), "https://console.example.com/api/v1/runner/chat-reply");
});

test("postConsoleChatReply throws when console config is unset — never silently drops the reply", async () => {
  await assert.rejects(
    () =>
      postConsoleChatReply({
        workspaceId: "ws-1",
        conversationKey: "console:user-1:1",
        text: "hi",
        env: {},
        transport: fakeTransport(() => ({ status: 200 })),
      }),
    /missing JACE_CONSOLE_BASE_URL, JACE_CONSOLE_TOKEN/,
  );
});

test("postConsoleChatReply POSTs the expected body + bearer header on a happy path", async () => {
  const transport = fakeTransport(() => ({ status: 200 }));
  await postConsoleChatReply({
    workspaceId: "ws-1",
    conversationKey: "console:user-1:1",
    text: "hi there",
    env: ENV,
    transport,
  });

  assert.equal(transport.calls.length, 1);
  const { url, init } = transport.calls[0];
  assert.equal(url, "https://console.example.com/api/v1/runner/chat-reply");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer tok-secret-123");
  assert.deepEqual(JSON.parse(init.body), {
    workspaceId: "ws-1",
    conversationKey: "console:user-1:1",
    text: "hi there",
  });
});

test("postConsoleChatReply throws on a non-2xx response", async () => {
  await assert.rejects(
    () =>
      postConsoleChatReply({
        workspaceId: "ws-1",
        conversationKey: "console:user-1:1",
        text: "hi",
        env: ENV,
        transport: fakeTransport(() => ({ status: 502 })),
      }),
    /console returned 502/,
  );
});

test("postConsoleChatReply propagates a transport-level network error unwrapped", async () => {
  const boom = new Error("network down");
  await assert.rejects(
    () =>
      postConsoleChatReply({
        workspaceId: "ws-1",
        conversationKey: "console:user-1:1",
        text: "hi",
        env: ENV,
        transport: fakeTransport(() => {
          throw boom;
        }),
      }),
    /network down/,
  );
});
