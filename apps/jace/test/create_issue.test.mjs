import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildIssueBody,
  buildCreateArgv,
  parseCreateOutput,
  runCreateIssue,
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

test("runCreateIssue throws when neither repo nor JACE_TARGET_REPO is set", async () => {
  await assert.rejects(
    () =>
      runCreateIssue({
        execFileFn: async () => ({ stdout: "" }),
        env: {},
        title: "t",
        acceptanceCriteria: ["ac"],
      }),
    /no target repo/,
  );
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
