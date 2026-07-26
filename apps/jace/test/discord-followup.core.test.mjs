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
  DISCORD_MESSAGE_CONTENT_MAX_LENGTH,
  buildFollowupUrl,
  extractFollowupCredentials,
  resolveSessionAuthAttributes,
  isFollowupSuccess,
  extractDiscordErrorCode,
  chunkDiscordContent,
  deliverDiscordBubble,
  deliverDiscordReply,
} from "../agent/lib/discord-followup.core.mjs";
import { splitIntoChatMessages } from "../agent/lib/chat-split.core.mjs";

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
  const fn = async (message) => {
    calls.push({ message });
    if (responder) return responder(message);
  };
  fn.calls = calls;
  return fn;
}

function fakeStartTyping() {
  const calls = [];
  const fn = async () => {
    calls.push({});
  };
  fn.calls = calls;
  return fn;
}

/**
 * Monkey-patch `console.error` for the duration of `fn`, returning both its
 * own return value and every captured call's `arguments` array. node:test
 * has no built-in spy for bare globals like vitest's `vi.spyOn` (and this
 * repo already avoids `t.mock.module`'s `--experimental-test-module-mocks`
 * flag requirement elsewhere — see instrumentation.test.mjs's header
 * comment), so this does it the plain save/restore way instead.
 */
async function withCapturedConsoleError(fn) {
  const original = console.error;
  const calls = [];
  console.error = (...args) => {
    calls.push(args);
  };
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    console.error = original;
  }
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

// --- resolveSessionAuthAttributes (fix-1-brief.md finding 1 — CRITICAL) ---
//
// eve's REAL compiled runtime (apps/jace/.output/server/_libs/eve.mjs, not
// just its .d.ts stubs) refreshes ONLY `session.auth.current` on every
// subsequent turn of a resumed session; `session.auth.initiator` is seeded
// once, at session start, and never updated again. A Discord conversation
// reuses the SAME eve session across turns, so reading `initiator` (as an
// earlier version of this fix did) reads turn 1's — possibly stale, possibly
// expired — token forever. See this function's own doc comment in
// discord-followup.core.mjs for the exact eve.mjs lines this was verified
// against.

test("resolveSessionAuthAttributes prefers `current` over a differing `initiator` (the critical fix — eve refreshes ONLY current past turn 1)", () => {
  const attrs = resolveSessionAuthAttributes({
    current: { attributes: { applicationId: "app-1", interactionToken: "turn-2-fresh-token" } },
    initiator: { attributes: { applicationId: "app-1", interactionToken: "turn-1-stale-token" } },
  });

  assert.deepEqual(attrs, { applicationId: "app-1", interactionToken: "turn-2-fresh-token" });
});

test("resolveSessionAuthAttributes falls back to `initiator` when `current` is absent (turn 1 — eve seeds both from the SAME value, so this is a strict superset of always reading initiator)", () => {
  const attrs = resolveSessionAuthAttributes({
    initiator: { attributes: { applicationId: "app-1", interactionToken: "turn-1-token" } },
  });

  assert.deepEqual(attrs, { applicationId: "app-1", interactionToken: "turn-1-token" });
});

test("resolveSessionAuthAttributes falls back to `initiator` when `current` is explicitly null", () => {
  const attrs = resolveSessionAuthAttributes({
    current: null,
    initiator: { attributes: { interactionToken: "turn-1-token" } },
  });

  assert.deepEqual(attrs, { interactionToken: "turn-1-token" });
});

test("resolveSessionAuthAttributes falls back to `initiator` when `current` exists but carries no attributes", () => {
  const attrs = resolveSessionAuthAttributes({
    current: {},
    initiator: { attributes: { interactionToken: "turn-1-token" } },
  });

  assert.deepEqual(attrs, { interactionToken: "turn-1-token" });
});

test("resolveSessionAuthAttributes is defensive against a missing/null auth object entirely (never throws)", () => {
  assert.equal(resolveSessionAuthAttributes(undefined), undefined);
  assert.equal(resolveSessionAuthAttributes(null), undefined);
  assert.equal(resolveSessionAuthAttributes({}), undefined);
});

// --- extractDiscordErrorCode (fix-1-brief.md finding 4) --------------------

test("extractDiscordErrorCode reads Discord's numeric `code` field from a well-formed error body", () => {
  assert.equal(extractDiscordErrorCode({ message: "Unknown Webhook", code: 10015 }), 10015);
});

test("extractDiscordErrorCode returns null for a missing/non-numeric code, or a non-object body — never throws", () => {
  assert.equal(extractDiscordErrorCode({ message: "no code field here" }), null);
  assert.equal(extractDiscordErrorCode({ code: "10015" }), null); // string, not number
  assert.equal(extractDiscordErrorCode(undefined), null);
  assert.equal(extractDiscordErrorCode(null), null);
  assert.equal(extractDiscordErrorCode("plain text body"), null);
  assert.equal(extractDiscordErrorCode(42), null);
});

// --- chunkDiscordContent (fix-1-brief.md finding 3) -------------------------

test("DISCORD_MESSAGE_CONTENT_MAX_LENGTH is Discord's 2000-char limit, the same one eve's own splitDiscordMessageContent uses", () => {
  assert.equal(DISCORD_MESSAGE_CONTENT_MAX_LENGTH, 2000);
});

test("chunkDiscordContent returns the content untouched, as a single-element array, when it's at or under 2000 chars", () => {
  assert.deepEqual(chunkDiscordContent("short reply"), ["short reply"]);
  const exactly2000 = "a".repeat(2000);
  assert.deepEqual(chunkDiscordContent(exactly2000), [exactly2000]);
});

test("chunkDiscordContent splits a >2000-char bubble into multiple <=2000-char chunks, in order, losing no characters", () => {
  const long = "a".repeat(2500);
  const chunks = chunkDiscordContent(long);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 2000);
  assert.equal(chunks.join(""), long);
});

test("chunkDiscordContent prefers breaking on the last newline at-or-before the 2000 limit", () => {
  const head = "a".repeat(1990);
  const tail = "b".repeat(50);
  const text = `${head}\n${tail}`; // the ONLY newline sits at index 1990, inside the limit

  assert.deepEqual(chunkDiscordContent(text), [head, tail]);
});

test("chunkDiscordContent falls back to the last space at-or-before the limit when there's no newline to break on", () => {
  const head = "a".repeat(1995);
  const tail = "b".repeat(50);
  const text = `${head} ${tail}`; // the ONLY space sits at index 1995, inside the limit

  assert.deepEqual(chunkDiscordContent(text), [head, tail]);
});

test("chunkDiscordContent hard-cuts at exactly 2000 when there's no newline or space anywhere to break on", () => {
  const text = "a".repeat(4500); // one unbroken run

  const chunks = chunkDiscordContent(text);

  assert.equal(chunks[0], "a".repeat(2000));
  assert.equal(chunks[1], "a".repeat(2000));
  assert.equal(chunks[2], "a".repeat(500));
  assert.equal(chunks.join(""), text);
});

test("chunkDiscordContent always returns at least one element, even for empty input", () => {
  assert.deepEqual(chunkDiscordContent(""), [""]);
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
  assert.deepEqual(JSON.parse(init.body), {
    content: "hello from jace",
    allowed_mentions: { parse: [] },
  });
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

// --- mention suppression (fix-1-brief.md finding 2) -------------------------
//
// eve's own `channel.discord.post()` suppresses mentions on every message by
// default (`normalizeMessageBody`, verified in eve.mjs). The followup path
// POSTed a bare `{content}` with no such default, so Discord parsed mentions
// normally — a live abuse vector (a reply could ping @everyone/@here/roles/
// users, including text echoed back from a stranger's own message) and a
// regression against existing behavior.

test("deliverDiscordBubble suppresses mentions on the followup POST body — regression guard: a reply could otherwise ping @everyone/@here/roles/users", async () => {
  const postFollowup = fakeTransport(() => ({ status: 200 }));
  const postViaBot = fakeBotPost();

  await deliverDiscordBubble({
    content: "hey @everyone check this out <@&123456> <@999>",
    attributes: { applicationId: "app-1", interactionToken: "tok-1" },
    postFollowup,
    postViaBot,
  });

  const { init } = postFollowup.calls[0];
  const body = JSON.parse(init.body);
  assert.equal(body.content, "hey @everyone check this out <@&123456> <@999>");
  assert.deepEqual(body.allowed_mentions, { parse: [] });
});

// --- chunking at 2000 chars (fix-1-brief.md finding 3) ----------------------

test("deliverDiscordBubble POSTs one followup request per chunk, in order, for a >2000-char bubble, and never touches the bot fallback", async () => {
  const postFollowup = fakeTransport(() => ({ status: 200 }));
  const postViaBot = fakeBotPost();
  const longContent = "a".repeat(4500);

  const result = await deliverDiscordBubble({
    content: longContent,
    attributes: { applicationId: "app-1", interactionToken: "tok-1" },
    postFollowup,
    postViaBot,
  });

  assert.deepEqual(result, { delivered: "followup" });
  assert.equal(postViaBot.calls.length, 0);
  assert.equal(postFollowup.calls.length, 3); // 2000 + 2000 + 500, chunkDiscordContent's own algorithm

  const bodies = postFollowup.calls.map((c) => JSON.parse(c.init.body));
  assert.equal(bodies.map((b) => b.content).join(""), longContent); // in order, nothing lost, nothing reordered
  for (const body of bodies) {
    assert.deepEqual(body.allowed_mentions, { parse: [] }); // every chunk, not just the first
  }
  for (const call of postFollowup.calls) {
    assert.equal(call.url, "https://discord.com/api/v10/webhooks/app-1/tok-1");
  }
});

test("deliverDiscordBubble stops attempting further chunks and falls back to postViaBot for the WHOLE bubble when a LATER chunk (not the first) fails", async () => {
  let attempt = 0;
  const postFollowup = fakeTransport(() => {
    attempt++;
    return attempt === 1 ? { status: 200 } : { status: 404, body: { code: 10015 } };
  });
  const postViaBot = fakeBotPost();
  const longContent = "a".repeat(4500); // 3 chunks: 2000 + 2000 + 500

  const { result } = await withCapturedConsoleError(() =>
    deliverDiscordBubble({
      content: longContent,
      attributes: { applicationId: "app-1", interactionToken: "tok-1" },
      postFollowup,
      postViaBot,
    }),
  );

  assert.deepEqual(result, { delivered: "bot" });
  assert.equal(postFollowup.calls.length, 2); // chunk 1 (succeeded) + chunk 2 (failed) — chunk 3 never attempted
  assert.equal(postViaBot.calls.length, 1);
});

test("deliverDiscordBubble falls back to postViaBot on a non-2xx followup response (e.g. the 15-minute window expired)", async () => {
  const postFollowup = fakeTransport(() => ({ status: 404 }));
  const postViaBot = fakeBotPost();

  const { result } = await withCapturedConsoleError(() =>
    deliverDiscordBubble({
      content: "hi",
      attributes: { applicationId: "app-1", interactionToken: "tok-1" },
      postFollowup,
      postViaBot,
    }),
  );

  assert.deepEqual(result, { delivered: "bot" });
  assert.equal(postFollowup.calls.length, 1);
  assert.equal(postViaBot.calls.length, 1);
});

test("deliverDiscordBubble falls back to postViaBot when the followup transport throws (network failure)", async () => {
  const postFollowup = fakeTransport(() => {
    throw new Error("ECONNRESET");
  });
  const postViaBot = fakeBotPost();

  const { result } = await withCapturedConsoleError(() =>
    deliverDiscordBubble({
      content: "hi",
      attributes: { applicationId: "app-1", interactionToken: "tok-1" },
      postFollowup,
      postViaBot,
    }),
  );

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

  await withCapturedConsoleError(() =>
    assert.rejects(
      () =>
        deliverDiscordBubble({
          content: "hi",
          attributes: { applicationId: "app-1", interactionToken: "tok-1" },
          postFollowup,
          postViaBot,
        }),
      /Missing Access/,
    ),
  );
});

test("SECRET SAFETY: a propagated bot-post failure never embeds the interaction token in its message", async () => {
  const secretToken = "super-secret-interaction-token-do-not-leak";
  const postFollowup = fakeTransport(() => ({ status: 404 }));
  const postViaBot = fakeBotPost(() => {
    throw new Error("bot post failed: 50001 Missing Access");
  });

  await withCapturedConsoleError(() =>
    assert.rejects(
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
    ),
  );
});

test("SECRET SAFETY: a followup non-2xx failure that falls back successfully never surfaces the token anywhere in the result", async () => {
  const secretToken = "super-secret-interaction-token-do-not-leak";
  const postFollowup = fakeTransport(() => ({ status: 401 }));
  const postViaBot = fakeBotPost();

  const { result } = await withCapturedConsoleError(() =>
    deliverDiscordBubble({
      content: "hi",
      attributes: { applicationId: "app-1", interactionToken: secretToken },
      postFollowup,
      postViaBot,
    }),
  );

  assert.ok(!JSON.stringify(result).includes(secretToken));
});

// --- fallback logging (fix-1-brief.md finding 4) ----------------------------
//
// The original prod bug was invisible precisely because this fallback path
// used to be a bare `catch {}`. It now logs — but ONLY the numeric HTTP
// status and Discord's numeric error code, NEVER the token, NEVER the
// followup URL (which embeds the token), NEVER the response body's free-text
// `message`/`errors` (Discord's 400 "Invalid Form Body" responses can echo
// back submitted content).

test("logs the numeric status + Discord error code on a non-2xx followup response, before falling back", async () => {
  const postFollowup = fakeTransport(() => ({
    status: 404,
    body: { message: "Unknown Webhook", code: 10015 },
  }));
  const postViaBot = fakeBotPost();

  const { result, calls } = await withCapturedConsoleError(() =>
    deliverDiscordBubble({
      content: "hi",
      attributes: { applicationId: "app-1", interactionToken: "tok-1" },
      postFollowup,
      postViaBot,
    }),
  );

  assert.deepEqual(result, { delivered: "bot" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], { status: 404, discordErrorCode: 10015 });
});

test("logs status:null, discordErrorCode:null (never the thrown error's own message) when the followup transport itself throws", async () => {
  const postFollowup = fakeTransport(() => {
    throw new Error("ECONNRESET");
  });
  const postViaBot = fakeBotPost();

  const { calls } = await withCapturedConsoleError(() =>
    deliverDiscordBubble({
      content: "hi",
      attributes: { applicationId: "app-1", interactionToken: "tok-1" },
      postFollowup,
      postViaBot,
    }),
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], { status: null, discordErrorCode: null });
});

test("logs nothing when there is no credential at all — that's the ordinary, expected case, not a failure", async () => {
  const postFollowup = fakeTransport(() => ({ status: 200 }));
  const postViaBot = fakeBotPost();

  const { calls } = await withCapturedConsoleError(() =>
    deliverDiscordBubble({ content: "hi", attributes: undefined, postFollowup, postViaBot }),
  );

  assert.equal(calls.length, 0);
});

test("logs nothing on a successful followup delivery", async () => {
  const postFollowup = fakeTransport(() => ({ status: 200 }));
  const postViaBot = fakeBotPost();

  const { calls } = await withCapturedConsoleError(() =>
    deliverDiscordBubble({
      content: "hi",
      attributes: { applicationId: "app-1", interactionToken: "tok-1" },
      postFollowup,
      postViaBot,
    }),
  );

  assert.equal(calls.length, 0);
});

test("SECRET SAFETY: the fallback log never contains the token or the followup URL, on a non-2xx failure", async () => {
  const secretToken = "super-secret-interaction-token-do-not-leak-log-1";
  const postFollowup = fakeTransport(() => ({
    status: 401,
    body: { message: "401: Unauthorized", code: 0 },
  }));
  const postViaBot = fakeBotPost();

  const { calls } = await withCapturedConsoleError(() =>
    deliverDiscordBubble({
      content: "hi",
      attributes: { applicationId: "app-1", interactionToken: secretToken },
      postFollowup,
      postViaBot,
    }),
  );

  const serialized = JSON.stringify(calls);
  assert.ok(!serialized.includes(secretToken));
  assert.ok(!serialized.includes("discord.com/api/v10/webhooks"));
});

test("SECRET SAFETY: the fallback log never contains the token or the followup URL, when the transport throws", async () => {
  const secretToken = "super-secret-interaction-token-do-not-leak-log-2";
  const postFollowup = fakeTransport(() => {
    throw new Error("fetch failed");
  });
  const postViaBot = fakeBotPost();

  const { calls } = await withCapturedConsoleError(() =>
    deliverDiscordBubble({
      content: "hi",
      attributes: { applicationId: "app-1", interactionToken: secretToken },
      postFollowup,
      postViaBot,
    }),
  );

  const serialized = JSON.stringify(calls);
  assert.ok(!serialized.includes(secretToken));
  assert.ok(!serialized.includes("discord.com/api/v10/webhooks"));
});

// --- deliverDiscordReply (fix-1-brief.md minor: the bubble loop, moved out
// of the .ts wrapper so it's provably exercised at runtime instead of only
// regex-matched — see discord-channel.test.mjs's own note on this) ---------

test("deliverDiscordReply delivers a single-bubble reply with no typing pause at all", async () => {
  const postFollowup = fakeTransport(() => ({ status: 200 }));
  const postViaBot = fakeBotPost();
  const startTyping = fakeStartTyping();

  const result = await deliverDiscordReply({
    text: "one short reply",
    attributes: { applicationId: "app-1", interactionToken: "tok-1" },
    postFollowup,
    postViaBot,
    startTyping,
    splitMessage: (text) => [text],
  });

  assert.deepEqual(result, { delivered: ["followup"] });
  assert.equal(postFollowup.calls.length, 1);
  assert.equal(startTyping.calls.length, 0); // never pauses before the FIRST bubble
});

test("deliverDiscordReply shows typing BETWEEN bubbles (never before the first), delivering each bubble in order", async () => {
  const postFollowup = fakeTransport(() => ({ status: 200 }));
  const postViaBot = fakeBotPost();
  const startTyping = fakeStartTyping();

  const result = await deliverDiscordReply({
    text: "para one\n\npara two\n\npara three",
    attributes: { applicationId: "app-1", interactionToken: "tok-1" },
    postFollowup,
    postViaBot,
    startTyping,
    splitMessage: (text) => text.split("\n\n"),
  });

  assert.deepEqual(result, { delivered: ["followup", "followup", "followup"] });
  assert.equal(postFollowup.calls.length, 3);
  assert.equal(startTyping.calls.length, 2); // before bubble 2 and bubble 3 only
  assert.deepEqual(
    postFollowup.calls.map((c) => JSON.parse(c.init.body).content),
    ["para one", "para two", "para three"],
  );
});

test("deliverDiscordReply calls postViaBot with the SPECIFIC bubble's own text (not the whole reply) on a per-bubble fallback", async () => {
  const postFollowup = fakeTransport(() => ({ status: 404 })); // every followup attempt fails
  const botCalls = [];
  const postViaBot = async (message) => {
    botCalls.push(message);
  };
  const startTyping = fakeStartTyping();

  const { result } = await withCapturedConsoleError(() =>
    deliverDiscordReply({
      text: "para one\n\npara two",
      attributes: { applicationId: "app-1", interactionToken: "tok-1" },
      postFollowup,
      postViaBot,
      startTyping,
      splitMessage: (text) => text.split("\n\n"),
    }),
  );

  assert.deepEqual(result, { delivered: ["bot", "bot"] });
  assert.deepEqual(botCalls, ["para one", "para two"]);
});

test("deliverDiscordReply passes the SAME attributes through to every bubble's followup URL", async () => {
  const postFollowup = fakeTransport(() => ({ status: 200 }));
  const postViaBot = fakeBotPost();
  const startTyping = fakeStartTyping();

  await deliverDiscordReply({
    text: "one\n\ntwo",
    attributes: { applicationId: "app-1", interactionToken: "tok-1" },
    postFollowup,
    postViaBot,
    startTyping,
    splitMessage: (text) => text.split("\n\n"),
  });

  for (const call of postFollowup.calls) {
    assert.equal(call.url, "https://discord.com/api/v10/webhooks/app-1/tok-1");
  }
});

test("end to end with the REAL splitIntoChatMessages: a >2000-char single-paragraph reply is ONE bubble, chunked into multiple followup POSTs (finding 1 + finding 3 integration)", async () => {
  const postFollowup = fakeTransport(() => ({ status: 200 }));
  const postViaBot = fakeBotPost();
  const startTyping = fakeStartTyping();
  const longReply = "a".repeat(4500); // one paragraph — no blank-line breaks for splitIntoChatMessages to act on

  const result = await deliverDiscordReply({
    text: longReply,
    attributes: { applicationId: "app-1", interactionToken: "tok-1" },
    postFollowup,
    postViaBot,
    startTyping,
    splitMessage: splitIntoChatMessages,
  });

  assert.deepEqual(result, { delivered: ["followup"] }); // ONE bubble
  assert.equal(postFollowup.calls.length, 3); // chunked 2000 + 2000 + 500
  assert.equal(startTyping.calls.length, 0); // one bubble => no typing pause
  assert.equal(
    postFollowup.calls.map((c) => JSON.parse(c.init.body).content).join(""),
    longReply,
  );
});
