import { runReviewApiExecution } from "./review_api_execution_console.core.mjs";
import { createReviewApiExecutor } from "./review_api_executor.core.mjs";

const CONSOLE_TIMEOUT_MS = 12_000;

async function consoleTransport(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONSOLE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { status: response.status, json: () => response.json() };
  } finally { clearTimeout(timer); }
}

/** Production composition: Console reservation + fixed same-origin GET + receipt. */
export function createReviewApiExecuteFn({ env = process.env, transport = consoleTransport, fetchPreview = fetch } = {}) {
  return (input) => runReviewApiExecution({
    ...input,
    env,
    transport,
    execute: ({ context, completeExecution }) => createReviewApiExecutor({ fetchPreview, completeExecution })(context),
  });
}
