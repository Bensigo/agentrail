import { runReviewDataExecution } from "./review_data_execution_console.core.mjs";
import { createReviewDataExecutor, resolveDataHmacKeyring } from "./review_data_executor.core.mjs";

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
/** Production composition: Console reservation + bounded preview JSON readback + receipt. */
export function createReviewDataExecuteFn({
  env = process.env,
  transport = consoleTransport,
  fetchPreview = fetch,
} = {}) {
  const keyring = resolveDataHmacKeyring(env);
  return (input) =>
    runReviewDataExecution({
      ...input,
      env,
      keyring,
      transport,
      execute: ({ context, completeExecution }) =>
        createReviewDataExecutor({ fetchPreview, completeExecution, keyring })(context),
    });
}
