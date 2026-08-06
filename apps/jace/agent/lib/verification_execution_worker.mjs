import { hostname } from "node:os";

import { createVerificationExecutionConsole } from "./verification_execution_console.mjs";
import { createVerificationExecutionWorker } from "./verification_execution_worker.core.mjs";
import { createVerificationBrowserExecuteFn } from "./verification_browser_executor.mjs";
import { createVerificationApiExecuteFn } from "./verification_api_executor.mjs";
import { createVerificationDataExecuteFn } from "./verification_data_executor.mjs";

export function buildVerificationExecutionWorkerId({ hostnameFn = hostname, pid = process.pid } = {}) {
  return `verification-worker-${hostnameFn()}-${pid}`;
}

export function createClaimFn({ workerId, executionConsole }) {
  return () => executionConsole.claim(workerId);
}

export function createCompleteFn({ executionConsole }) {
  return (input) => executionConsole.complete(input);
}

/** Route UI/API claims only to their deterministic exact-plan executors. */
export function createRoutedExecuteFn({ browserExecute, apiExecute, dataExecute = async () => ({ status: "not_testable", observedBehavior: null, artifactIds: [], reason: "Data executor is unavailable" }) }) {
  if (typeof browserExecute !== "function") throw new TypeError("browserExecute is required");
  if (typeof apiExecute !== "function") throw new TypeError("apiExecute is required");
  return async (item) => {
    const modality = (item?.plan ?? item)?.modality;
    if (modality === "ui") return browserExecute(item);
    if (modality === "api") return apiExecute(item);
    if (modality === "data") return dataExecute(item);
    return { status: "not_testable", observedBehavior: null, artifactIds: [], reason: "Planned verification modality is missing or unsupported" };
  };
}

let started = false;

/** Start the exact-head criterion execution worker once for this Eve process. */
export async function startVerificationExecutionWorker(env = process.env) {
  if (started) return;
  started = true;
  try {
    const workerId = buildVerificationExecutionWorkerId();
    const executionConsole = createVerificationExecutionConsole({ env });
    const worker = createVerificationExecutionWorker({
      claim: createClaimFn({ workerId, executionConsole }),
      execute: createRoutedExecuteFn({
        browserExecute: createVerificationBrowserExecuteFn({ env }),
        apiExecute: createVerificationApiExecuteFn({ env }),
        dataExecute: createVerificationDataExecuteFn({ env }),
      }),
      complete: createCompleteFn({ executionConsole }),
      log: (message, error) => console.error("[verification-execution-worker]", message, error ?? ""),
    });
    console.log(`[verification-execution-worker] starting (workerId=${workerId}).`);
    worker.start();
  } catch (error) {
    console.error("[verification-execution-worker] failed to start:", error instanceof Error ? error.message : String(error));
  }
}
