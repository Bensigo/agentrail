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

// Code-review regression tests: a raw substring scan for CAPABLE_SIGNAL_KEYWORDS
// previously made these chit-chat words permanently unreachable ("how" inside
// "howdy", "what" inside "whats", "pr" inside "appreciate"/"appreciated").
test("chit-chat words that contain a capable-signal SUBSTRING still classify as chit-chat (word-boundary fix)", () => {
  assert.equal(classifyIntent("howdy"), "chit-chat");
  assert.equal(classifyIntent("whats up"), "chit-chat");
  assert.equal(classifyIntent("appreciate it"), "chit-chat");
  assert.equal(classifyIntent("appreciated"), "chit-chat");
});

// A capable-signal keyword must still fire as a WHOLE word/phrase, not just
// stop matching entirely now that it's word-boundary-anchored.
test("capable-signal keywords still fire as whole words after the word-boundary fix", () => {
  assert.equal(classifyIntent("how do I deploy this"), "capable");
  assert.equal(classifyIntent("what is the status"), "capable");
  assert.equal(classifyIntent("can you open a pr"), "capable");
});

// Code-review regression tests: treating every chit-chat word as a
// free-floating token in one bag let "yes"/"ok"/"great" + "do" + "it" combine
// into what reads as a real confirmation/directive ("should I go ahead?" →
// "yes do it"), not small talk. "do" is removed from the word list entirely.
test("a directive-shaped confirmation ('<ack> do it') fails toward capable, not chit-chat", () => {
  assert.equal(classifyIntent("yes do it"), "capable");
  assert.equal(classifyIntent("ok do it"), "capable");
  assert.equal(classifyIntent("great, do it"), "capable");
});

// "it" stays in the word list — it's load-bearing for the legitimate "got it"
// ack, which was never part of the reported false-positive class.
test("'got it' (the legitimate ack 'it' supports) still classifies as chit-chat", () => {
  assert.equal(classifyIntent("got it"), "chit-chat");
  assert.equal(classifyIntent("got it, thanks"), "chit-chat");
});
