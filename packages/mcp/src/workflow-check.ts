import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { executeCheck } from "./check-execution.js";
import { workflowRequest } from "./workflow-client.js";

export const RELEASE_CHECK_NAME = "agentrail:release-verification";
const exec = promisify(execFile);
const commitPattern = /^[a-f0-9]{40}$/;

interface CheckInput {
  taskId: string;
  eventKey: string;
  expectedRevision: number;
  worktree?: string;
}

interface CheckTask {
  repository_url: string;
  branch: string;
  pr_url?: string;
  delivery?: {
    stage: string;
    reviewHead?: string;
    release?: { commitSha: string; targetUrl: string };
  };
}

function canonicalRepo(value: string) {
  return value
    .trim()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\/$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

function configuredCommand(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 64 ||
    !value.every(
      (arg) =>
        typeof arg === "string" &&
        arg.length > 0 &&
        arg.length <= 4096 &&
        !arg.includes("\u0000"),
    )
  )
    throw new Error(
      "Configure the check as an argv array in .agentrail/config.json",
    );
  return value;
}

function observedRelease(
  output: string,
  commitSha: string,
  targetUrl: string,
): string | undefined {
  try {
    const receipt = JSON.parse(output.trim().split(/\r?\n/).at(-1) ?? "");
    if (
      receipt.commitSha !== commitSha ||
      typeof receipt.url !== "string" ||
      receipt.url.length > 512 ||
      /\s/.test(receipt.url)
    )
      return;
    const url = new URL(receipt.url);
    if (
      url.href !== targetUrl ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return;
    if (
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      return receipt.url;
  } catch {
    // Verifiers report the version and URL on their final stdout line.
  }
}

async function confirmMergedPr(
  task: CheckTask,
  commitSha: string,
  env: NodeJS.ProcessEnv,
) {
  if (!task.pr_url || !task.delivery?.reviewHead)
    throw new Error(
      "Record the reviewed pull request before verifying a release",
    );
  let pr: {
    state?: string;
    headRefOid?: string;
    mergeCommit?: { oid?: string };
  };
  try {
    const { stdout } = await exec(
      "gh",
      ["pr", "view", task.pr_url, "--json", "state,headRefOid,mergeCommit"],
      {
        env: { ...env, GH_PROMPT_DISABLED: "1" },
        timeout: 20000,
        maxBuffer: 65536,
      },
    );
    pr = JSON.parse(stdout);
  } catch {
    throw new Error(
      "Could not read the PR from GitHub. Check GitHub CLI access and retry.",
    );
  }
  if (
    pr.state !== "MERGED" ||
    pr.headRefOid !== task.delivery.reviewHead ||
    pr.mergeCommit?.oid !== commitSha
  )
    throw new Error(
      "GitHub does not show this reviewed PR head merged at the prepared release commit",
    );
}

export async function runWorkflowCheck(
  { taskId, worktree, ...event }: CheckInput,
  name: string,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const path = `tasks/${taskId}`;
  const release = name === RELEASE_CHECK_NAME;
  if (release && !process.env.AGENTRAIL_WORKFLOW_RELEASE_API_KEY)
    throw new Error(
      "Use the operator verifier invocation for this release. The coding agent key can only report workflow progress.",
    );

  const current = await workflowRequest(path);
  const reservationInput = {
    ...event,
    phase: "testing",
    summary: `Configured check ${name}: execution reserved; result not recorded yet.`,
    checkReservation: { name },
  };
  const replay = async () => ({
    ...(await workflowRequest(path)),
    replayed: true,
    note: "Check was already reserved. Inspect history before scheduling another run.",
  });
  const prior = (
    current.events as {
      event_key: string;
      payload: { checkReservation?: { name: string } };
    }[]
  ).some(
    (entry) =>
      entry.event_key === event.eventKey &&
      entry.payload.checkReservation?.name === name,
  );
  if (prior) {
    const existing = await workflowRequest(path, reservationInput, release);
    if (existing.replayed) return replay();
  }
  const task = current.task as CheckTask;
  const root = resolve(process.env.AGENTRAIL_TARGET || process.cwd());
  const git = async (target: string, args: string[]) =>
    (
      await exec("git", ["-C", target, ...args], {
        env,
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout.trim();

  let target = root;
  if (worktree) {
    target = await realpath(resolve(root, worktree));
    const paths = (await git(root, ["worktree", "list", "--porcelain", "-z"]))
      .split("\u0000")
      .filter((field) => field.startsWith("worktree "))
      .map((field) => field.slice(9));
    const canonicalPaths = await Promise.all(
      paths.map((path) => realpath(path).catch(() => null)),
    );
    if (!canonicalPaths.includes(target))
      throw new Error("Choose a registered Git worktree for AGENTRAIL_TARGET");
  }

  const snapshot = async () => {
    const [remote, branch, commitSha, status] = await Promise.all([
      git(target, ["remote", "get-url", "origin"]),
      git(
        target,
        release
          ? ["rev-parse", "--abbrev-ref", "HEAD"]
          : ["symbolic-ref", "--short", "HEAD"],
      ),
      git(target, ["rev-parse", "HEAD"]),
      git(target, ["status", "--porcelain"]),
    ]);
    return {
      repository: canonicalRepo(remote),
      branch,
      commitSha,
      dirty: Boolean(status),
    };
  };
  const before = await snapshot();
  if (
    before.repository !== canonicalRepo(task.repository_url) ||
    (!release && before.branch !== task.branch)
  )
    throw new Error(
      "Configured checkout does not match this task's repository and branch",
    );
  if (!commitPattern.test(before.commitSha))
    throw new Error("Checkout has no canonical Git commit");

  if (release) {
    const prepared = task.delivery?.release?.commitSha;
    if (
      !prepared ||
      (task.delivery?.stage !== "releasing" &&
        task.delivery?.stage !== "verified")
    )
      throw new Error("Record the merged commit in a release checkpoint first");
    if (before.dirty || before.commitSha !== prepared)
      throw new Error("Select a clean worktree at the prepared release commit");
    await confirmMergedPr(task, prepared, env);
  }

  const config = JSON.parse(
    await readFile(resolve(target, ".agentrail/config.json"), "utf8"),
  );
  const command = configuredCommand(
    release
      ? config.workflow?.release?.verify
      : config.workflow?.checks?.[name],
  );
  const reservation = await workflowRequest(path, reservationInput, release);
  if (reservation.replayed) return replay();

  let exitCode = 1;
  let output = "";
  let stdout = "";
  let dirty = before.dirty;
  let failure = "";
  try {
    const matches = (after: Awaited<ReturnType<typeof snapshot>>) =>
      after.repository === before.repository &&
      after.branch === before.branch &&
      after.commitSha === before.commitSha;
    const reserved = await snapshot();
    if (!matches(reserved) || (release && reserved.dirty)) {
      dirty ||= reserved.dirty;
      failure = "Checkout changed before the check started.";
    } else {
      const execution = await executeCheck(
        command,
        target,
        release
          ? {
              ...env,
              AGENTRAIL_RELEASE_COMMIT: before.commitSha,
              AGENTRAIL_RELEASE_TARGET_URL: task.delivery?.release?.targetUrl,
            }
          : env,
        release ? 110000 : undefined,
      );
      ({ exitCode, output, stdout } = execution);
      const after = await snapshot();
      dirty ||= after.dirty;
      if (!matches(after) || (release && dirty)) {
        exitCode = 1;
        failure = "Checkout changed while the check was running.";
      }
    }
  } catch {
    exitCode = 1;
    dirty = true;
    failure = "Could not verify the checkout after reserving the check.";
  }
  const releaseUrl =
    release && exitCode === 0
      ? observedRelease(
          stdout,
          before.commitSha,
          task.delivery?.release?.targetUrl ?? "",
        )
      : undefined;
  if (release && exitCode === 0 && !releaseUrl) {
    exitCode = 1;
    failure = "Verifier did not report the expected live commit and URL.";
  }
  const receipt = {
    name,
    commitSha: before.commitSha,
    dirty,
    passed: exitCode === 0,
    exitCode,
    outputSha256: createHash("sha256").update(output).digest("hex"),
    ...(releaseUrl ? { releaseUrl } : {}),
  };
  const updated = await workflowRequest(
    path,
    {
      eventKey: `check:${createHash("sha256").update(event.eventKey).digest("hex")}:finish`,
      expectedRevision: (reservation.task as { revision: number }).revision,
      phase: exitCode === 0 ? "testing" : "blocked",
      summary: releaseUrl
        ? "The configured verifier observed the expected live release and passed its smoke checks."
        : failure ||
          `Configured check ${name}: exit ${exitCode}. Logs remain local.`,
      check: receipt,
    },
    release,
  );
  return { ...updated, check: receipt };
}
