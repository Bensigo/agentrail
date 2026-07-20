// Unit tests for the pure chat-intent classifier (#1339 PR①).

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyIntent } from "../agent/lib/intent-classifier.core.mjs";

test("pure greetings classify as chit-chat", () => {
  assert.equal(classifyIntent("hi"), "chit-chat");
  assert.equal(classifyIntent("Hey!"), "chit-chat");
  assert.equal(classifyIntent("good morning"), "chit-chat");
  assert.equal(classifyIntent("hello there"), "chit-chat");
});

test("acks and sign-offs classify as chit-chat", () => {
  assert.equal(classifyIntent("thanks!"), "chit-chat");
  assert.equal(classifyIntent("thank you"), "chit-chat");
  assert.equal(classifyIntent("ok cool"), "chit-chat");
  assert.equal(classifyIntent("sounds good"), "chit-chat");
  assert.equal(classifyIntent("got it, thanks"), "chit-chat");
  assert.equal(classifyIntent("bye"), "chit-chat");
});

test("is case-insensitive and tolerant of punctuation/whitespace", () => {
  assert.equal(classifyIntent("  HEY there!!  "), "chit-chat");
});

test("empty or whitespace-only input fails toward capable (AC2)", () => {
  assert.equal(classifyIntent(""), "capable");
  assert.equal(classifyIntent("   "), "capable");
  assert.equal(classifyIntent(undefined), "capable");
  assert.equal(classifyIntent(null), "capable");
});

test("a real question fails toward capable, even if short", () => {
  assert.equal(classifyIntent("why did it fail?"), "capable");
  assert.equal(classifyIntent("how do I deploy this"), "capable");
});

test("any mention of codebase/issue/repo work fails toward capable", () => {
  assert.equal(classifyIntent("can you file an issue"), "capable");
  assert.equal(classifyIntent("check the repo"), "capable");
  assert.equal(classifyIntent("there's a bug"), "capable");
});

test("a greeting word embedded in a substantive message fails toward capable (AC2)", () => {
  // "hi" is a chit-chat word, but the whole message is not small talk.
  assert.equal(
    classifyIntent("hi, can you look into why the deploy failed?"),
    "capable",
  );
});

test("a long message fails toward capable even with only chit-chat-shaped words", () => {
  const long = Array(10).fill("thanks so much").join(" ");
  assert.ok(long.length > 40);
  assert.equal(classifyIntent(long), "capable");
});

test("an unrecognized word (not in the chit-chat list) fails toward capable", () => {
  assert.equal(classifyIntent("congratulations"), "capable");
  assert.equal(classifyIntent("Bensigo"), "capable");
});
