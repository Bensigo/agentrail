import { hostname } from "node:os";
import { createAcceptanceReviewWorker } from "./acceptance_review_worker.core.mjs";
import { createAcceptanceReviewConsole } from "./acceptance_review_console.mjs";
import { createAcceptanceReviewEvaluator } from "./acceptance_review_evaluator.core.mjs";
import { fetchAcceptanceReviewEvidence } from "./acceptance_review_evidence.mjs";
import { createAcceptanceReviewModelGenerate } from "./acceptance_review_model.mjs";
export function buildAcceptanceReviewWorkerId({ hostnameFn = hostname, pid = process.pid } = {}) { return `acceptance-review-worker-${hostnameFn()}-${pid}`; }
let started = false;
export async function startAcceptanceReviewWorker(env = process.env) {
  if (started) return; started = true;
  try { const workerId = buildAcceptanceReviewWorkerId(); const consoleClient = createAcceptanceReviewConsole({ env }); const review = createAcceptanceReviewEvaluator({ fetchEvidence: fetchAcceptanceReviewEvidence, generate: createAcceptanceReviewModelGenerate({ env }) }); const worker = createAcceptanceReviewWorker({ claim: () => consoleClient.claim(workerId), review, complete: consoleClient.complete, log: (m, e) => console.error("[acceptance-review-worker]", m, e ?? "") }); worker.start(); console.log(`[acceptance-review-worker] starting (workerId=${workerId}).`); } catch (error) { console.error("[acceptance-review-worker] failed to start:", error instanceof Error ? error.message : String(error)); }
}
