import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildIssueBody,
  buildCreateArgv,
  parseCreateOutput,
  runCreateIssue,
  notConnectedGuidance,
  NOT_CONNECTED_MARKER,
} from "../agent/lib/create_issue.core.mjs";

test("buildIssueBody renders the house-format sections in order", () => {
  const body = buildIssueBody({
    parent: "Runner epic",
    requiredContext: "Keep the CLI as the sole write path.",
    whatToBuild: "A health endpoint on the runner.",
    acceptanceCriteria: [
      "GET /health returns 200",
      "body is {ok:true}",
    ],
    verification: "curl the endpoint and assert status 200.",
  });

  assert.match(body, /## Parent\nRunner epic/);
  assert.match(body, /## Required context\nKeep the CLI as the sole write path\./);
  assert.match(body, /## What to build\nA health endpoint on the runner\./);
  assert.match(body, /## Acceptance criteria\n/);
  assert.match(body, /## Verification evidence\ncurl the endpoint and assert status 200\./);
});

test("buildIssueBody numbers acceptance criteria as checkboxes", () => {
  const body = buildIssueBody({
    acceptanceCriteria: ["first", "second", "third"],
  });
  assert.match(body, /- \[ \] AC1: first/);
  assert.match(body, /- \[ \] AC2: second/);
  assert.match(body, /- \[ \] AC3: third/);
});

test("buildIssueBody throws on empty acceptanceCriteria", () => {
  assert.throws(
    () => buildIssueBody({ acceptanceCriteria: [] }),
    /acceptanceCriteria must be a non-empty array/,
  );
  assert.throws(
    () => buildIssueBody({}),
    /acceptanceCriteria must be a non-empty array/,
  );
});

test("buildCreateArgv produces the exact args array", () => {
  const argv = buildCreateArgv({
    repo: "Bensigo/agentrail",
    title: "My title",
    body: "MARKDOWN BODY",
  });
  assert.deepEqual(argv, [
    "issue",
    "create",
    "--connector",
    "github",
    "--repo",
    "Bensigo/agentrail",
    "--title",
    "My title",
    "--body",
    "MARKDOWN BODY",
  ]);
});

test("buildCreateArgv omits --repo when repo is not given", () => {
  const argv = buildCreateArgv({ title: "My title", body: "MARKDOWN BODY" });
  assert.deepEqual(argv, [
    "issue",
    "create",
    "--connector",
    "github",
    "--title",
    "My title",
    "--body",
    "MARKDOWN BODY",
  ]);
});

test("buildCreateArgv omits --repo when repo is an empty string", () => {
  const argv = buildCreateArgv({ repo: "", title: "t", body: "b" });
  assert.ok(!argv.includes("--repo"));
});

test("parseCreateOutput parses the real success line", () => {
  const stdout =
    "Created Bensigo/agentrail#1042 (label ready-for-agent): https://github.com/Bensigo/agentrail/issues/1042\n";
  const parsed = parseCreateOutput(stdout);
  assert.deepEqual(parsed, {
    repo: "Bensigo/agentrail",
    number: 1042,
    label: "ready-for-agent",
    url: "https://github.com/Bensigo/agentrail/issues/1042",
  });
});

test("parseCreateOutput finds the line among surrounding noise", () => {
  const stdout =
    "some warning\nCreated owner/repo#7 (label ready-for-agent): https://x/issues/7\ntrailing\n";
  const parsed = parseCreateOutput(stdout);
  assert.equal(parsed.repo, "owner/repo");
  assert.equal(parsed.number, 7);
  assert.equal(parsed.url, "https://x/issues/7");
});

test("parseCreateOutput throws on garbage and surfaces the raw stdout", () => {
  assert.throws(
    () => parseCreateOutput("nope, nothing here"),
    /could not parse the CLI success line[\s\S]*nope, nothing here/,
  );
});

test("runCreateIssue with a fake execFileFn returns the parsed ref and calls with the right bin+argv", async () => {
  const calls = [];
  const fakeExec = async (bin, argv, opts) => {
    calls.push({ bin, argv, opts });
    return {
      stdout:
        "Created Bensigo/agentrail#1042 (label ready-for-agent): https://github.com/Bensigo/agentrail/issues/1042\n",
      stderr: "",
    };
  };

  const ref = await runCreateIssue({
    execFileFn: fakeExec,
    env: { JACE_TARGET_REPO: "Bensigo/agentrail" },
    title: "Add a health endpoint",
    parent: "Runner epic",
    acceptanceCriteria: ["GET /health returns 200"],
    verification: "curl it",
  });

  assert.deepEqual(ref, {
    repo: "Bensigo/agentrail",
    number: 1042,
    label: "ready-for-agent",
    url: "https://github.com/Bensigo/agentrail/issues/1042",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, "agentrail");
  assert.equal(calls[0].argv[0], "issue");
  assert.equal(calls[0].argv[1], "create");
  assert.deepEqual(calls[0].argv.slice(0, 6), [
    "issue",
    "create",
    "--connector",
    "github",
    "--repo",
    "Bensigo/agentrail",
  ]);
  // title and body are the last four tokens
  assert.equal(calls[0].argv[6], "--title");
  assert.equal(calls[0].argv[7], "Add a health endpoint");
  assert.equal(calls[0].argv[8], "--body");
  assert.match(calls[0].argv[9], /- \[ \] AC1: GET \/health returns 200/);
});

test("runCreateIssue honors JACE_AGENTRAIL_BIN override", async () => {
  let seenBin = null;
  const fakeExec = async (bin) => {
    seenBin = bin;
    return {
      stdout: "Created a/b#1 (label ready-for-agent): https://x/issues/1\n",
      stderr: "",
    };
  };
  await runCreateIssue({
    execFileFn: fakeExec,
    env: { JACE_TARGET_REPO: "a/b", JACE_AGENTRAIL_BIN: "/opt/agentrail" },
    title: "t",
    acceptanceCriteria: ["ac"],
  });
  assert.equal(seenBin, "/opt/agentrail");
});

test("runCreateIssue prefers explicit repo over JACE_TARGET_REPO", async () => {
  let seenRepo = null;
  const fakeExec = async (bin, argv) => {
    seenRepo = argv[argv.indexOf("--repo") + 1];
    return {
      stdout: "Created x/y#2 (label ready-for-agent): https://x/issues/2\n",
      stderr: "",
    };
  };
  await runCreateIssue({
    execFileFn: fakeExec,
    env: { JACE_TARGET_REPO: "env/repo" },
    repo: "explicit/repo",
    title: "t",
    acceptanceCriteria: ["ac"],
  });
  assert.equal(seenRepo, "explicit/repo");
});

test("runCreateIssue omits --repo when neither repo nor JACE_TARGET_REPO is set (CLI resolves it)", async () => {
  // Connecting a repo on the console must be sufficient — no manual repo
  // config required from Jace's side. The CLI resolves the repo itself.
  let seenArgv = null;
  const fakeExec = async (bin, argv) => {
    seenArgv = argv;
    return {
      stdout: "Created a/b#1 (label ready-for-agent): https://x/issues/1\n",
    };
  };
  const ref = await runCreateIssue({
    execFileFn: fakeExec,
    env: {},
    title: "t",
    acceptanceCriteria: ["ac"],
  });
  assert.ok(!seenArgv.includes("--repo"));
  assert.equal(ref.repo, "a/b");
});

test("runCreateIssue surfaces a clear error when the CLI fails", async () => {
  const failing = async () => {
    const err = new Error("exit code 1");
    err.stderr = "gh: not authenticated";
    throw err;
  };
  await assert.rejects(
    () =>
      runCreateIssue({
        execFileFn: failing,
        env: { JACE_TARGET_REPO: "a/b" },
        title: "t",
        acceptanceCriteria: ["ac"],
      }),
    /issue create` failed[\s\S]*gh: not authenticated/,
  );
});

// ---------------------------------------------------------------------------
// "Connect a repo first" graceful guidance (no separately-supplied GitHub PAT,
// no manual JACE_TARGET_REPO) — the CLI signals via NOT_CONNECTED_MARKER when
// it can resolve NEITHER a repo NOR a token for the workspace.
// ---------------------------------------------------------------------------

test("notConnectedGuidance includes the console URL when configured", () => {
  const msg = notConnectedGuidance({ JACE_CONSOLE_BASE_URL: "https://app.agentrail.dev/" });
  assert.match(msg, /connect a repo/i);
  assert.match(msg, /https:\/\/app\.agentrail\.dev/);
  assert.ok(!msg.endsWith("/"), "trailing slash from the base URL is stripped");
});

test("notConnectedGuidance still reads fine with no console URL configured", () => {
  const msg = notConnectedGuidance({});
  assert.match(msg, /connect a repo/i);
});

test("runCreateIssue returns friendly guidance instead of throwing when the CLI reports not connected", async () => {
  const failing = async () => {
    const err = new Error("exit code 3");
    err.stderr =
      `${NOT_CONNECTED_MARKER}: no GitHub repo is connected for this workspace ` +
      "(and no --repo was given). Connect a repo on the AgentRail console.";
    throw err;
  };
  const result = await runCreateIssue({
    execFileFn: failing,
    env: { JACE_CONSOLE_BASE_URL: "https://app.agentrail.dev" },
    title: "t",
    acceptanceCriteria: ["ac"],
  });
  assert.deepEqual(result, {
    connected: false,
    message: notConnectedGuidance({ JACE_CONSOLE_BASE_URL: "https://app.agentrail.dev" }),
  });
});

test("runCreateIssue does not mistake an unrelated CLI failure for not-connected", async () => {
  const failing = async () => {
    const err = new Error("exit code 1");
    err.stderr = "gh: rate limited";
    throw err;
  };
  await assert.rejects(
    () =>
      runCreateIssue({
        execFileFn: failing,
        env: {},
        title: "t",
        acceptanceCriteria: ["ac"],
      }),
    /issue create` failed[\s\S]*rate limited/,
  );
});

// ---------------------------------------------------------------------------
// Prompt-injection hardening at the write seam (issue #1124).
//
// The researcher's brief reaches Jace as a MODEL-READ tool result with no
// Jace-authored code seam before the parent drafts. The create_issue write
// path is the first place Jace code touches the blended text again, so it is
// where untrusted content must be neutralized before it lands on GitHub.
// ---------------------------------------------------------------------------

test("buildIssueBody hardens untrusted content in every field", () => {
  const body = buildIssueBody({
    // bidi override (Trojan Source) in the parent
    parent: "Runner‮ epic",
    // zero-width char + a dangerous URL scheme in required context
    requiredContext: "See​ [x](javascript:steal()) for details.",
    // unicode-tag smuggling in what-to-build
    whatToBuild: "Build it\u{E0041}\u{E0042}.",
    // a mass-ping token riding in an acceptance criterion
    acceptanceCriteria: ["ping @everyone when done"],
    // another dangerous scheme in the verification evidence
    verification: "open file:///etc/passwd",
  });

  // hidden channels are gone
  assert.ok(!/[​‮]/u.test(body), "zero-width / bidi stripped");
  assert.ok(!/[\u{E0000}-\u{E007F}]/u.test(body), "unicode tags stripped");
  // dangerous schemes are defanged, http-family would have been left alone
  assert.ok(body.includes("javascript[:]"), "javascript scheme defanged");
  assert.ok(body.includes("file[:]"), "file scheme defanged");
  // mass ping is defanged, not left live
  assert.ok(body.includes("＠everyone"), "@everyone defanged to fullwidth");
  assert.ok(!/@everyone/.test(body), "no live @everyone remains");
});

test("runCreateIssue hardens the title before it reaches argv", async () => {
  let seenTitle = null;
  const fakeExec = async (bin, argv) => {
    seenTitle = argv[argv.indexOf("--title") + 1];
    return {
      stdout: "Created a/b#1 (label ready-for-agent): https://x/issues/1\n",
      stderr: "",
    };
  };
  await runCreateIssue({
    execFileFn: fakeExec,
    env: { JACE_TARGET_REPO: "a/b" },
    // title bypasses buildIssueBody, so it must be hardened in runCreateIssue
    title: "Fix​ bug, ping @everyone",
    acceptanceCriteria: ["ac"],
  });
  assert.ok(!/​/u.test(seenTitle), "zero-width stripped from title");
  assert.ok(seenTitle.includes("＠everyone"), "@everyone defanged in title");
  assert.ok(!/@everyone/.test(seenTitle), "no live @everyone in title");
});
