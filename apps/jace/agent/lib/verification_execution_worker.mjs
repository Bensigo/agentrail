import { hostname } from "node:os";
import { Client } from "eve/client";

import { createVerificationExecutionConsole } from "./verification_execution_console.mjs";
import { VERIFICATION_EXECUTION_RESULT_SCHEMA } from "./verification_execution_prompt.mjs";
import { createVerificationExecutionWorker } from "./verification_execution_worker.core.mjs";

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
  return async (message) => {
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
      execute: createExecuteFn({ client }),
      complete: createCompleteFn({ executionConsole }),
      log: (message, error) => console.error("[verification-execution-worker]", message, error ?? ""),
    });
    console.log(`[verification-execution-worker] starting (workerId=${workerId}, eveHost=${host}).`);
    worker.start();
  } catch (error) {
    console.error("[verification-execution-worker] failed to start:", error instanceof Error ? error.message : String(error));
  }
}
