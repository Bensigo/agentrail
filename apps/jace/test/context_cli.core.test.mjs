// AC3 + AC4 — the codebase Q&A skill cites `agentrail context` tool output, and
// invokes the subprocess execFile-style (args array), never as a shell string.
//
// AC3: answers are grounded in and cite the tool's returned paths/line-ranges —
//      extractCitations pulls structured citations out of the CLI's JSON, and
//      runContextLookup returns them alongside the raw stdout (so the answer can
//      quote the tool, not the model's memory).
//
// AC4: the subprocess is invoked execFile-style — buildContextArgv returns an
//      ARGS ARRAY with the user's input as ONE element, and runContextLookup
//      hands (bin, argv, opts) to an injected execFile-style function. A faithful
//      fake asserts it receives an argv array (never a joined command string) and
//      that shell metacharacters in the user's input stay inert as a single arg.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALLOWED_SUBCOMMANDS,
  buildContextArgv,
  extractCitations,
  runContextLookup,
} from "../agent/lib/context_cli.core.mjs";

// A faithful fake execFile-style fn: it MUST be called (bin, argvArray, opts).
// It records the call and asserts the argv is a real array, then returns canned
// JSON stdout shaped like the real `agentrail context` CLI.
function makeFakeExecFile(stdout) {
  const calls = [];
  const fn = async (bin, argv, opts) => {
    // If someone ever passed a shell string instead of an args array, this fails.
    assert.ok(Array.isArray(argv), "execFileFn must be called with an ARGS ARRAY, not a shell string");
    calls.push({ bin, argv, opts });
    return { stdout, stderr: "" };
  };
  return { fn, calls };
}

// ── AC4: args array, never a shell string ────────────────────────────────────

test("AC4: buildContextArgv returns an args array with user input as ONE element", () => {
  const argv = buildContextArgv("query", "where is the retry budget spent?");
  assert.deepEqual(argv, ["context", "query", "where is the retry budget spent?", "--json"]);
  // The whole thing is an array of primitives (no interpolated command string).
  assert.ok(Array.isArray(argv));
  assert.equal(argv.length, 4);
});

test("AC4: shell metacharacters in the term stay inert as a single argv element", () => {
  const nasty = "foo; rm -rf / && $(curl evil) `id`";
  const argv = buildContextArgv("query", nasty);
  // The dangerous input is exactly ONE array element, verbatim — not split, not
  // escaped into a command string.
  assert.equal(argv[2], nasty);
  assert.equal(argv.filter((a) => a === nasty).length, 1);
  // No element concatenates the term into a larger command string.
  assert.ok(!argv.some((a) => a !== nasty && a.includes(nasty)));
});

test("AC4: buildContextArgv rejects unknown subcommands and empty terms", () => {
  assert.throws(() => buildContextArgv("shell", "x"), /unsupported subcommand/);
  assert.throws(() => buildContextArgv("query", "   "), /non-empty term/);
  assert.deepEqual([...ALLOWED_SUBCOMMANDS], ["query", "def", "callers"]);
});

test("AC4: runContextLookup calls the injected execFile fn with (bin, argv array, opts)", async () => {
  const { fn, calls } = makeFakeExecFile(JSON.stringify({ results: [] }));
  await runContextLookup({ execFileFn: fn, sub: "query", term: "hello; rm -rf /", env: {} });

  assert.equal(calls.length, 1);
  assert.ok(Array.isArray(calls[0].argv));
  assert.deepEqual(calls[0].argv, ["context", "query", "hello; rm -rf /", "--json"]);
  // opts must NOT enable a shell.
  assert.notEqual(calls[0].opts?.shell, true);
});

test("AC4: runContextLookup requires an injected execFile-style function", async () => {
  await assert.rejects(
    () => runContextLookup({ sub: "query", term: "x" }),
    /execFileFn .* is required/,
  );
});

// ── AC3: answers cite tool output ────────────────────────────────────────────

test("AC3: extractCitations pulls path + line range + symbol from `query` JSON", () => {
  const parsed = {
    results: [
      { path: "agentrail/run/pricing.py", lineStart: 10, lineEnd: 20, symbol: "price", content: "def price(): ..." },
      { path: "agentrail/run/router.py", lineStart: 1, lineEnd: 3 },
    ],
  };
  const cites = extractCitations("query", parsed);
  assert.equal(cites.length, 2);
  assert.equal(cites[0].path, "agentrail/run/pricing.py");
  assert.equal(cites[0].lineStart, 10);
  assert.equal(cites[0].lineEnd, 20);
  assert.equal(cites[0].symbol, "price");
  assert.ok(cites[0].snippet.includes("def price"));
});

test("AC3: extractCitations handles the array shape returned by def/callers", () => {
  // `context def`/`callers` return a bare JSON array of hits.
  const parsed = [
    { path: "apps/jace/agent/lib/standup.core.mjs", lineStart: 116, lineEnd: 164, content: "export function buildStandup" },
  ];
  const cites = extractCitations("def", parsed);
  assert.equal(cites.length, 1);
  assert.equal(cites[0].path, "apps/jace/agent/lib/standup.core.mjs");
  assert.equal(cites[0].lineStart, 116);
});

test("AC3: runContextLookup returns citations AND raw stdout grounded in tool output", async () => {
  const stdout = JSON.stringify({
    results: [{ path: "agentrail/run/pricing.py", lineStart: 5, lineEnd: 9, symbol: "cost_usd" }],
  });
  const { fn } = makeFakeExecFile(stdout);
  const out = await runContextLookup({ execFileFn: fn, sub: "query", term: "where is cost computed?", env: {} });

  // The answer material comes from the tool: citations + the raw JSON it emitted.
  assert.equal(out.raw, stdout);
  assert.equal(out.citations.length, 1);
  assert.equal(out.citations[0].path, "agentrail/run/pricing.py");
  assert.equal(out.citations[0].symbol, "cost_usd");
  assert.deepEqual(out.argv, ["context", "query", "where is cost computed?", "--json"]);
});

test("AC3: runContextLookup fails loudly when the tool returns non-JSON (no memory fallback)", async () => {
  const { fn } = makeFakeExecFile("not json at all");
  await assert.rejects(
    () => runContextLookup({ execFileFn: fn, sub: "query", term: "x", env: {} }),
    /did not return JSON/,
  );
});
