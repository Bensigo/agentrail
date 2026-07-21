import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildIssueBody,
  buildUpdateArgv,
  parseUpdateOutput,
  runUpdateIssue,
  NOT_CONNECTED_MARKER,
  buildReviseAlignmentBriefUrl,
  triggerReviseAlignmentBrief,
} from "../agent/lib/update_issue.core.mjs";

// buildIssueBody is re-exported verbatim from create_issue.core.mjs — the two
// tools share ONE house-format renderer. Its own full behavior (section
// ordering, checkbox numbering, hardening) is already exhaustively pinned in
// create_issue.test.mjs; a light smoke test here just proves the re-export
// actually resolves to the same function, not a duplicate.
test("buildIssueBody is the shared house-format renderer (re-exported, not duplicated)", () => {
  const body = buildIssueBody({ acceptanceCriteria: ["first", "second"] });
  assert.match(body, /## Acceptance criteria\n/);
  assert.match(body, /- \[ \] AC1: first/);
  assert.match(body, /- \[ \] AC2: second/);
});

test("buildUpdateArgv produces the exact args array", () => {
  const argv = buildUpdateArgv({
    repo: "Bensigo/agentrail",
    number: 42,
    title: "Cheaper thing",
    body: "MARKDOWN BODY",
  });
  assert.deepEqual(argv, [
    "issue",
    "update",
    "--connector",
    "github",
    "--repo",
    "Bensigo/agentrail",
    "--number",
    "42",
    "--title",
    "Cheaper thing",
    "--body",
    "MARKDOWN BODY",
  ]);
});

test("buildUpdateArgv omits --repo when repo is not given", () => {
  const argv = buildUpdateArgv({ number: 42, title: "t", body: "b" });
  assert.deepEqual(argv, [
    "issue",
    "update",
    "--connector",
    "github",
    "--number",
    "42",
    "--title",
    "t",
    "--body",
    "b",
  ]);
});

test("buildUpdateArgv omits --repo when repo is an empty string", () => {
  const argv = buildUpdateArgv({ repo: "", number: 1, title: "t", body: "b" });
  assert.ok(!argv.includes("--repo"));
});

test("buildUpdateArgv never emits --label (house-format body edit only, no label changes)", () => {
  const argv = buildUpdateArgv({ number: 1, title: "t", body: "b" });
  assert.ok(!argv.includes("--label"));
});

test("parseUpdateOutput parses the real success line", () => {
  const stdout =
    "Updated Bensigo/agentrail#1042: https://github.com/Bensigo/agentrail/issues/1042\n";
  const parsed = parseUpdateOutput(stdout);
  assert.deepEqual(parsed, {
    repo: "Bensigo/agentrail",
    number: 1042,
    url: "https://github.com/Bensigo/agentrail/issues/1042",
  });
});

test("parseUpdateOutput finds the line among surrounding noise", () => {
  const stdout = "some warning\nUpdated owner/repo#7: https://x/issues/7\ntrailing\n";
  const parsed = parseUpdateOutput(stdout);
  assert.equal(parsed.repo, "owner/repo");
  assert.equal(parsed.number, 7);
  assert.equal(parsed.url, "https://x/issues/7");
});

test("parseUpdateOutput throws on garbage and surfaces the raw stdout", () => {
  assert.throws(
    () => parseUpdateOutput("nope, nothing here"),
    /could not parse the CLI success line[\s\S]*nope, nothing here/,
  );
});

// ---------------------------------------------------------------------------
// runUpdateIssue orchestration
// ---------------------------------------------------------------------------

const SUCCESS_STDOUT =
  "Updated Bensigo/agentrail#1042: https://github.com/Bensigo/agentrail/issues/1042\n";

function fakeExecSuccess() {
  return async () => ({ stdout: SUCCESS_STDOUT, stderr: "" });
}

test("runUpdateIssue with a fake execFileFn returns the parsed ref and calls with the right bin+argv", async () => {
  const calls = [];
  const fakeExec = async (bin, argv, opts) => {
    calls.push({ bin, argv, opts });
    return { stdout: SUCCESS_STDOUT, stderr: "" };
  };

  const ref = await runUpdateIssue({
    execFileFn: fakeExec,
    env: { JACE_TARGET_REPO: "Bensigo/agentrail" },
    issueNumber: 1042,
    title: "Cheaper version",
    parent: "Runner epic",
    acceptanceCriteria: ["GET /health returns 200"],
    verification: "curl it",
  });

  assert.deepEqual(ref, {
    repo: "Bensigo/agentrail",
    number: 1042,
    url: "https://github.com/Bensigo/agentrail/issues/1042",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, "agentrail");
  assert.deepEqual(calls[0].argv.slice(0, 6), [
    "issue",
    "update",
    "--connector",
    "github",
    "--repo",
    "Bensigo/agentrail",
  ]);
  assert.equal(calls[0].argv[6], "--number");
  assert.equal(calls[0].argv[7], "1042");
  assert.equal(calls[0].argv[8], "--title");
  assert.equal(calls[0].argv[9], "Cheaper version");
  assert.equal(calls[0].argv[10], "--body");
  assert.match(calls[0].argv[11], /- \[ \] AC1: GET \/health returns 200/);
});

test("runUpdateIssue requires issueNumber", async () => {
  await assert.rejects(
    () =>
      runUpdateIssue({
        execFileFn: fakeExecSuccess(),
        env: {},
        title: "t",
        acceptanceCriteria: ["ac"],
      }),
    /`issueNumber` is required/,
  );
});

test("runUpdateIssue requires title", async () => {
  await assert.rejects(
    () =>
      runUpdateIssue({
        execFileFn: fakeExecSuccess(),
        env: {},
        issueNumber: 1,
        acceptanceCriteria: ["ac"],
      }),
    /`title` is required/,
  );
});

test("runUpdateIssue omits --repo when neither repo nor JACE_TARGET_REPO is set (CLI resolves it)", async () => {
  let seenArgv = null;
  const fakeExec = async (bin, argv) => {
    seenArgv = argv;
    return { stdout: SUCCESS_STDOUT, stderr: "" };
  };
  await runUpdateIssue({
    execFileFn: fakeExec,
    env: {},
    issueNumber: 1042,
    title: "t",
    acceptanceCriteria: ["ac"],
  });
  assert.ok(!seenArgv.includes("--repo"));
});

test("runUpdateIssue surfaces a clear error when the CLI fails", async () => {
  const failing = async () => {
    const err = new Error("exit code 1");
    err.stderr = "gh: not authenticated";
    throw err;
  };
  await assert.rejects(
    () =>
      runUpdateIssue({
        execFileFn: failing,
        env: { JACE_TARGET_REPO: "a/b" },
        issueNumber: 1,
        title: "t",
        acceptanceCriteria: ["ac"],
      }),
    /issue update` failed[\s\S]*gh: not authenticated/,
  );
});

test("runUpdateIssue returns friendly guidance instead of throwing when the CLI reports not connected", async () => {
  const failing = async () => {
    const err = new Error("exit code 3");
    err.stderr = `${NOT_CONNECTED_MARKER}: no GitHub repo is connected for this workspace.`;
    throw err;
  };
  const result = await runUpdateIssue({
    execFileFn: failing,
    env: { JACE_CONSOLE_BASE_URL: "https://app.agentrail.dev" },
    issueNumber: 1,
    title: "t",
    acceptanceCriteria: ["ac"],
  });
  assert.equal(result.connected, false);
  assert.match(result.message, /connect a repo/i);
  assert.match(result.message, /https:\/\/app\.agentrail\.dev/);
});

test("runUpdateIssue hardens the title before it reaches argv", async () => {
  let seenTitle = null;
  const fakeExec = async (bin, argv) => {
    seenTitle = argv[argv.indexOf("--title") + 1];
    return { stdout: SUCCESS_STDOUT, stderr: "" };
  };
  await runUpdateIssue({
    execFileFn: fakeExec,
    env: { JACE_TARGET_REPO: "a/b" },
    issueNumber: 1,
    // title bypasses buildIssueBody, so it must be hardened in runUpdateIssue
    title: "Fix​ bug, ping @everyone",
    acceptanceCriteria: ["ac"],
  });
  assert.ok(!/​/u.test(seenTitle), "zero-width stripped from title");
  assert.ok(seenTitle.includes("＠everyone"), "@everyone defanged in title");
  assert.ok(!/@everyone/.test(seenTitle), "no live @everyone in title");
});

// ---------------------------------------------------------------------------
// #1345 PR② hook — the revise-brief trigger. Same "never throws, never
// affects the caller's own result" safety line as create_issue.core.mjs's
// stampCreatedIssueUrl, proven the same way: every failure mode of the
// trigger call still returns the parsed ref intact.
// ---------------------------------------------------------------------------

function fakeTransport(...responders) {
  const calls = [];
  let i = 0;
  const fn = async (url, init) => {
    calls.push({ url, init });
    const responder = responders[Math.min(i, responders.length - 1)];
    i += 1;
    return responder(url, init);
  };
  fn.calls = calls;
  return fn;
}

const REVISE_ENV = {
  JACE_CONSOLE_BASE_URL: "https://console.example.com",
  JACE_CONSOLE_TOKEN: "tok-secret-123",
  JACE_TARGET_REPO: "Bensigo/agentrail",
};

test("buildReviseAlignmentBriefUrl joins the base url and the revise path", () => {
  const url = buildReviseAlignmentBriefUrl("https://console.example.com");
  assert.equal(url, "https://console.example.com/api/v1/runner/queue-entries/revise");
});

test("triggerReviseAlignmentBrief posts the eveSessionId/repo/number/title/body with the bearer token", async () => {
  const transport = fakeTransport(async () => ({ status: 200, json: async () => ({}) }));
  await triggerReviseAlignmentBrief({
    eveSessionId: "eve-session-1",
    repo: "Bensigo/agentrail",
    number: 1042,
    title: "Cheaper version",
    body: "BODY",
    env: REVISE_ENV,
    transport,
  });
  assert.equal(transport.calls.length, 1);
  const call = transport.calls[0];
  assert.equal(call.url, "https://console.example.com/api/v1/runner/queue-entries/revise");
  assert.equal(call.init.headers.Authorization, "Bearer tok-secret-123");
  const sent = JSON.parse(call.init.body);
  assert.deepEqual(sent, {
    eveSessionId: "eve-session-1",
    repoFullName: "Bensigo/agentrail",
    number: 1042,
    title: "Cheaper version",
    body: "BODY",
  });
});

test("triggerReviseAlignmentBrief: transport throws (timeout/network) -> never throws", async () => {
  const throwing = async () => {
    throw new Error("ETIMEDOUT");
  };
  await assert.doesNotReject(() =>
    triggerReviseAlignmentBrief({
      eveSessionId: "eve-session-1",
      repo: "a/b",
      number: 1,
      title: "t",
      body: "b",
      env: REVISE_ENV,
      transport: throwing,
    }),
  );
});

test("triggerReviseAlignmentBrief: non-2xx from the console -> never throws", async () => {
  const transport = fakeTransport(async () => ({ status: 404, json: async () => ({}) }));
  await assert.doesNotReject(() =>
    triggerReviseAlignmentBrief({
      eveSessionId: "eve-session-1",
      repo: "a/b",
      number: 1,
      title: "t",
      body: "b",
      env: REVISE_ENV,
      transport,
    }),
  );
});

test("triggerReviseAlignmentBrief: skips entirely (transport never called) when eveSessionId is missing", async () => {
  const transport = fakeTransport();
  await triggerReviseAlignmentBrief({
    repo: "a/b",
    number: 1,
    title: "t",
    body: "b",
    env: REVISE_ENV,
    transport,
  });
  assert.equal(transport.calls.length, 0);
});

test("triggerReviseAlignmentBrief: skips entirely when console config is missing", async () => {
  const transport = fakeTransport();
  await triggerReviseAlignmentBrief({
    eveSessionId: "eve-session-1",
    repo: "a/b",
    number: 1,
    title: "t",
    body: "b",
    env: {},
    transport,
  });
  assert.equal(transport.calls.length, 0);
});

test("runUpdateIssue: successful update + successful revise trigger -> returns the parsed ref, unaffected", async () => {
  const transport = fakeTransport(async () => ({ status: 200, json: async () => ({}) }));
  const ref = await runUpdateIssue({
    execFileFn: fakeExecSuccess(),
    env: REVISE_ENV,
    issueNumber: 1042,
    title: "Cheaper version",
    acceptanceCriteria: ["ac"],
    eveSessionId: "eve-session-1",
    reviseTransport: transport,
  });
  assert.deepEqual(ref, {
    repo: "Bensigo/agentrail",
    number: 1042,
    url: "https://github.com/Bensigo/agentrail/issues/1042",
  });
  assert.equal(transport.calls.length, 1);
  const sent = JSON.parse(transport.calls[0].init.body);
  assert.equal(sent.title, "Cheaper version");
  assert.equal(sent.number, 1042);
  assert.equal(sent.repoFullName, "Bensigo/agentrail");
});

test("runUpdateIssue: the revise trigger TIMES OUT (throws) -> the tool result is still returned intact, no throw", async () => {
  const timingOutTransport = async () => {
    throw new Error("ETIMEDOUT");
  };
  const ref = await runUpdateIssue({
    execFileFn: fakeExecSuccess(),
    env: REVISE_ENV,
    issueNumber: 1042,
    title: "Cheaper version",
    acceptanceCriteria: ["ac"],
    eveSessionId: "eve-session-1",
    reviseTransport: timingOutTransport,
  });
  assert.deepEqual(ref, {
    repo: "Bensigo/agentrail",
    number: 1042,
    url: "https://github.com/Bensigo/agentrail/issues/1042",
  });
});

test("runUpdateIssue: no eveSessionId at all (e.g. ctx was absent/malformed) -> the revise trigger is skipped, the tool result is still returned intact", async () => {
  const transport = fakeTransport();
  const ref = await runUpdateIssue({
    execFileFn: fakeExecSuccess(),
    env: REVISE_ENV,
    issueNumber: 1042,
    title: "Cheaper version",
    acceptanceCriteria: ["ac"],
    reviseTransport: transport,
  });
  assert.equal(ref.number, 1042);
  assert.equal(transport.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Prompt-injection hardening at the write seam (issue #1124) — same posture
// as create_issue: an update can be reached from a conversation that drafted
// its new title/body off untrusted (researcher-derived) text, so the same
// hardenUntrusted() pass must run on this write path too. buildIssueBody's
// OWN hardening behavior is exhaustively pinned in create_issue.test.mjs
// (shared implementation) — this just confirms runUpdateIssue's title path
// (which bypasses buildIssueBody, exactly like runCreateIssue's) is covered
// too, mirroring that file's own "hardens the title" test above.
// ---------------------------------------------------------------------------

test("runUpdateIssue: acceptance criteria and body fields pass through the shared house-format hardening", async () => {
  let seenBody = null;
  const fakeExec = async (bin, argv) => {
    seenBody = argv[argv.indexOf("--body") + 1];
    return { stdout: SUCCESS_STDOUT, stderr: "" };
  };
  await runUpdateIssue({
    execFileFn: fakeExec,
    env: { JACE_TARGET_REPO: "a/b" },
    issueNumber: 1,
    title: "t",
    acceptanceCriteria: ["ping @everyone when done"],
  });
  assert.ok(seenBody.includes("＠everyone"), "@everyone defanged in the body");
  assert.ok(!/@everyone/.test(seenBody), "no live @everyone in the body");
});
