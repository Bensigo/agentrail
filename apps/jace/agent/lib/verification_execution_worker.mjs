import { hostname } from "node:os";
import { Client } from "eve/client";

import { createVerificationExecutionConsole } from "./verification_execution_console.mjs";
import { verificationExecutionPrompt, VERIFICATION_EXECUTION_RESULT_SCHEMA } from "./verification_execution_prompt.mjs";
import { createVerificationExecutionWorker } from "./verification_execution_worker.core.mjs";
import { createVerificationBrowserExecuteFn } from "./verification_browser_executor.mjs";

export const DEFAULT_EVE_HOST = "http://127.0.0.1:2000";

export function buildVerificationExecutionWorkerId({ hostnameFn = hostname, pid = process.pid } = {}) {
  return `verification-worker-${hostnameFn()}-${pid}`;
}

export function createClaimFn({ workerId, executionConsole }) {
  return () => executionConsole.claim(workerId);
}

export function createCompleteFn({ executionConsole }) {
  return (input) => executionConsole.complete(input);
}

/** Execute one constrained criterion prompt in a fresh root-Jace session. */
export function createExecuteFn({ client }) {
  return async (item) => {
    const message = typeof item === "string" ? item : verificationExecutionPrompt(item);
    const session = client.session();
    const response = await session.send({
      message,
      outputSchema: VERIFICATION_EXECUTION_RESULT_SCHEMA,
    });
    const result = await response.result();
    if (result?.data === undefined) {
      throw new Error(`verification-execution worker: Eve returned status "${result?.status ?? "unknown"}" without structured evidence result`);
    }
    return result.data;
  };
}

/** Route UI claims to the deterministic browser executor; API retains its existing constrained Eve path. */
export function createRoutedExecuteFn({ client, browserExecute }) {
  const executeApi = createExecuteFn({ client });
  if (typeof browserExecute !== "function") throw new TypeError("browserExecute is required");
  return async (item) => {
    const modality = (item?.plan ?? item)?.modality;
    if (modality === "ui") return browserExecute(item);
    if (modality === "api") return executeApi(item);
    return { status: "not_testable", observedBehavior: null, artifactIds: [], reason: "Planned verification modality is missing or unsupported" };
  };
}

let started = false;

/** Start the exact-head criterion execution worker once for this Eve process. */
export async function startVerificationExecutionWorker(env = process.env) {
  if (started) return;
  started = true;
  try {
    const host = String(env.EVE_HOST || DEFAULT_EVE_HOST).trim();
    const workerId = buildVerificationExecutionWorkerId();
    const executionConsole = createVerificationExecutionConsole({ env });
    const client = new Client({ host, preserveCompletedSessions: true });
    const worker = createVerificationExecutionWorker({
      claim: createClaimFn({ workerId, executionConsole }),
      execute: createRoutedExecuteFn({ client, browserExecute: createVerificationBrowserExecuteFn({ env }) }),
      complete: createCompleteFn({ executionConsole }),
      log: (message, error) => console.error("[verification-execution-worker]", message, error ?? ""),
    });
    console.log(`[verification-execution-worker] starting (workerId=${workerId}, eveHost=${host}).`);
    worker.start();
  } catch (error) {
    console.error("[verification-execution-worker] failed to start:", error instanceof Error ? error.message : String(error));
  }
}
