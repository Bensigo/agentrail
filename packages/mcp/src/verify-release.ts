import { agentrailChildEnvironment } from "./child-environment.js";
import { RELEASE_CHECK_NAME, runWorkflowCheck } from "./workflow-check.js";

const [taskId, revision, eventKey, worktree] = process.argv.slice(2);
const expectedRevision = Number(revision);
if (
  !/^[0-9a-f-]{36}$/i.test(taskId ?? "") ||
  !/^\d+$/.test(revision ?? "") ||
  !Number.isSafeInteger(expectedRevision) ||
  !eventKey ||
  eventKey.length > 128
) {
  console.error(
    "Usage: node packages/mcp/dist/verify-release.js TASK_ID REVISION EVENT_KEY [WORKTREE]",
  );
  process.exit(2);
}

try {
  const result = await runWorkflowCheck(
    { taskId, expectedRevision, eventKey, worktree },
    RELEASE_CHECK_NAME,
    agentrailChildEnvironment(),
  );
  const state = result.task as { delivery?: { stage?: string } } | undefined;
  console.log(JSON.stringify(result));
  if (state?.delivery?.stage !== "verified") process.exitCode = 1;
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Release verification failed",
  );
  process.exitCode = 1;
}
