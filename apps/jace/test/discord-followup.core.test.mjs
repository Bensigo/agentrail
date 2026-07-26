// Unit tests for the discord followup-webhook delivery core (#1284 prod bug
// fix — private-channel replies vanish because the reply is posted as a
// separate bot-API channel message, which needs bot channel permissions the
// shared hosted bot may not have). No SDK, no live network: both the
// followup HTTP call and the bot-post fallback are injected seams, so every
// branch — success, non-2xx, a transport throw, and a missing credential —
// is exercised deterministically. Mirrors console_chat_reply.core.test.mjs's
// `fakeTransport` convention.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DISCORD_API_BASE,
  buildFollowupUrl,
  extractFollowupCredentials,
  isFollowupSuccess,
  deliverDiscordBubble,
} from "../agent/lib/discord-followup.core.mjs";

function fakeTransport(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  fn.calls = calls;
  return fn;
}

function fakeBotPost(responder) {
  const calls = [];
  const fn = async () => {
    calls.push({});
    if (responder) return responder();
  };
  fn.calls = calls;
  return fn;
}

// --- buildFollowupUrl --------------------------------------------------

test("DISCORD_API_BASE is Discord's v10 REST base", () => {
  assert.equal(DISCORD_API_BASE, "https://discord.com/api/v10");
});

test("buildFollowupUrl builds the documented interaction-followup webhook URL", () => {
  assert.equal(
    buildFollowupUrl({ applicationId: "app-123", interactionToken: "tok-abc" }),
    "https://discord.com/api/v10/webhooks/app-123/tok-abc",
  );
});

// --- extractFollowupCredentials -----------------------------------------

test("extractFollowupCredentials returns the pair when both fields are present and non-blank", () => {
  assert.deepEqual(
    extractFollowupCredentials({ applicationId: "app-1", interactionToken: "tok-1" }),
    { applicationId: "app-1", interactionToken: "tok-1" },
  );
});

test("extractFollowupCredentials returns null for a missing/non-object attributes value", () => {
  assert.equal(extractFollowupCredentials(undefined), null);
  assert.equal(extractFollowupCredentials(null), null);
  assert.equal(extractFollowupCredentials("nope"), null);
  assert.equal(extractFollowupCredentials(42), null);
});

test("extractFollowupCredentials returns null when only one of the two fields is present", () => {
  assert.equal(extractFollowupCredentials({ applicationId: "app-1" }), null);
  assert.equal(extractFollowupCredentials({ interactionToken: "tok-1" }), null);
});

test("extractFollowupCredentials returns null for blank-string values", () => {
  assert.equal(
    extractFollowupCredentials({ applicationId: "  ", interactionToken: "tok-1" }),
    null,
  );
  assert.equal(
    extractFollowupCredentials({ applicationId: "app-1", interactionToken: "" }),
    null,
  );
});

test("extractFollowupCredentials returns null for non-string field values", () => {
  assert.equal(
    extractFollowupCredentials({ applicationId: 123, interactionToken: "tok-1" }),
    null,
  );
});

test("extractFollowupCredentials ignores unrelated attributes keys (e.g. chatIdentityId/workspaceId)", () => {
  assert.deepEqual(
    extractFollowupCredentials({
      chatIdentityId: "chat-1",
      workspaceId: "ws-1",
      channel: "discord",
      conversationKey: "998877",
      applicationId: "app-1",
      interactionToken: "tok-1",
    }),
    { applicationId: "app-1", interactionToken: "tok-1" },
  );
});

// --- isFollowupSuccess ----------------------------------------------------

test("isFollowupSuccess is true for any 2xx status", () => {
  assert.equal(isFollowupSuccess(200), true);
  assert.equal(isFollowupSuccess(204), true);
  assert.equal(isFollowupSuccess(299), true);
});

test("isFollowupSuccess is false outside the 2xx range, and for non-numeric input", () => {
  assert.equal(isFollowupSuccess(199), false);
  assert.equal(isFollowupSuccess(300), false);
  assert.equal(isFollowupSuccess(404), false);
  assert.equal(isFollowupSuccess(401), false);
  assert.equal(isFollowupSuccess(undefined), false);
  assert.equal(isFollowupSuccess(null), false);
  assert.equal(isFollowupSuccess("200"), false);
});

// --- deliverDiscordBubble -------------------------------------------------

test("deliverDiscordBubble posts to the followup webhook when credentials are present and it succeeds", async () => {
  const postFollowup = fakeTransport(() => ({ status: 200 }));
  const postViaBot = fakeBotPost();

  const result = await deliverDiscordBubble({
    content: "hello from jace",
    attributes: { applicationId: "app-1", interactionToken: "tok-1" },
    postFollowup,
    postViaBot,
  });

  assert.deepEqual(result, { delivered: "followup" });
  assert.equal(postFollowup.calls.length, 1);
  assert.equal(postViaBot.calls.length, 0);

  const { url, init } = postFollowup.calls[0];
  assert.equal(url, "https://discord.com/api/v10/webhooks/app-1/tok-1");
  assert.equal(init.method, "POST");
  assert.deepEqual(JSON.parse(init.body), { content: "hello from jace" });
});

test("deliverDiscordBubble sends NO Authorization header on the followup call — the token IS the credential", async () => {
  const postFollowup = fakeTransport(() => ({ status: 200 }));
  const postViaBot = fakeBotPost();

  await deliverDiscordBubble({
    content: "hi",
    attributes: { applicationId: "app-1", interactionToken: "tok-1" },
    postFollowup,
    postViaBot,
  });

  const { init } = postFollowup.calls[0];
  assert.deepEqual(init.headers, { "Content-Type": "application/json" });
  assert.equal("Authorization" in init.headers, false);
});

test("deliverDiscordBubble falls back to postViaBot on a non-2xx followup response (e.g. the 15-minute window expired)", async () => {
  const postFollowup = fakeTransport(() => ({ status: 404 }));
  const postViaBot = fakeBotPost();

  const result = await deliverDiscordBubble({
    content: "hi",
    attributes: { applicationId: "app-1", interactionToken: "tok-1" },
    postFollowup,
    postViaBot,
  });

  assert.deepEqual(result, { delivered: "bot" });
  assert.equal(postFollowup.calls.length, 1);
  assert.equal(postViaBot.calls.length, 1);
});

test("deliverDiscordBubble falls back to postViaBot when the followup transport throws (network failure)", async () => {
  const postFollowup = fakeTransport(() => {
    throw new Error("ECONNRESET");
  });
  const postViaBot = fakeBotPost();

  const result = await deliverDiscordBubble({
    content: "hi",
    attributes: { applicationId: "app-1", interactionToken: "tok-1" },
    postFollowup,
    postViaBot,
  });

  assert.deepEqual(result, { delivered: "bot" });
  assert.equal(postViaBot.calls.length, 1);
});

test("deliverDiscordBubble goes straight to postViaBot when no credential is available — postFollowup is never called", async () => {
  const postFollowup = fakeTransport(() => ({ status: 200 }));
  const postViaBot = fakeBotPost();

  const result = await deliverDiscordBubble({
    content: "hi",
    attributes: undefined,
    postFollowup,
    postViaBot,
  });

  assert.deepEqual(result, { delivered: "bot" });
  assert.equal(postFollowup.calls.length, 0);
  assert.equal(postViaBot.calls.length, 1);
});

test("deliverDiscordBubble goes straight to postViaBot for a partial credential (applicationId with no interactionToken)", async () => {
  const postFollowup = fakeTransport(() => ({ status: 200 }));
  const postViaBot = fakeBotPost();

  const result = await deliverDiscordBubble({
    content: "hi",
    attributes: { applicationId: "app-1" },
    postFollowup,
    postViaBot,
  });

  assert.deepEqual(result, { delivered: "bot" });
  assert.equal(postFollowup.calls.length, 0);
  assert.equal(postViaBot.calls.length, 1);
});

test("deliverDiscordBubble propagates a postViaBot failure unguarded (matches today's behavior with no token at all)", async () => {
  const postFollowup = fakeTransport(() => ({ status: 404 }));
  const boom = new Error("Missing Access");
  const postViaBot = fakeBotPost(() => {
    throw boom;
  });

  await assert.rejects(
    () =>
      deliverDiscordBubble({
        content: "hi",
        attributes: { applicationId: "app-1", interactionToken: "tok-1" },
        postFollowup,
        postViaBot,
      }),
    /Missing Access/,
  );
});

test("SECRET SAFETY: a propagated bot-post failure never embeds the interaction token in its message", async () => {
  const secretToken = "super-secret-interaction-token-do-not-leak";
  const postFollowup = fakeTransport(() => ({ status: 404 }));
  const postViaBot = fakeBotPost(() => {
    throw new Error("bot post failed: 50001 Missing Access");
  });

  await assert.rejects(
    () =>
      deliverDiscordBubble({
        content: "hi",
        attributes: { applicationId: "app-1", interactionToken: secretToken },
        postFollowup,
        postViaBot,
      }),
    (err) => {
      assert.ok(!String(err.message).includes(secretToken));
      return true;
    },
  );
});

test("SECRET SAFETY: a followup non-2xx failure that falls back successfully never surfaces the token anywhere in the result", async () => {
  const secretToken = "super-secret-interaction-token-do-not-leak";
  const postFollowup = fakeTransport(() => ({ status: 401 }));
  const postViaBot = fakeBotPost();

  const result = await deliverDiscordBubble({
    content: "hi",
    attributes: { applicationId: "app-1", interactionToken: secretToken },
    postFollowup,
    postViaBot,
  });

  assert.ok(!JSON.stringify(result).includes(secretToken));
});
