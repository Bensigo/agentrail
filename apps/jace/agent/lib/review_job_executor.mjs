import { runReviewJobExecution } from "./review_job_execution_console.core.mjs";
import {
  createReviewJobExecutor,
  resolveJobHmacKeyring,
} from "./review_job_executor.core.mjs";

const CONSOLE_TIMEOUT_MS = 12_000;
async function consoleTransport(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONSOLE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { status: response.status, json: () => response.json() };
  } finally {
    clearTimeout(timer);
  }
}
export function createReviewJobExecuteFn({
  env = process.env,
  transport = consoleTransport,
  fetchPreview = fetch,
} = {}) {
  const keyring = resolveJobHmacKeyring(env);
  return (input) =>
    runReviewJobExecution({
      ...input,
      env,
      keyring,
      transport,
      execute: ({ context, completeExecution }) =>
        createReviewJobExecutor({ fetchPreview, completeExecution, keyring })(
          context,
        ),
    });
}
