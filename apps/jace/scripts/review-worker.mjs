// Arc B: the REVIEW-JOB WORKER ENTRYPOINT — the production deployment shape.
// The worker runs OUT-OF-PROCESS against the serving eve host (EVE_HOST, or
// the local default): the live smoke (2026-08-02) proved the in-process
// variant wedges (an eve Client inside the eve process never sees result()
// resolve) while this exact loop, run as its own process, completed a real
// review end-to-end in ~150s (Bensigo/agentrail#1557). This is also the
// spec's scale topology ("worker-service extraction is a topology change,
// not a redesign"). Reads apps/jace/.env.local when present, then starts
// the standard assembler loop unchanged.
//
// Usage: cd apps/jace && node scripts/review-worker.mjs
// (Railway: a dedicated service/process running exactly this command.)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const env = { ...process.env };
const envFile = path.join(appDir, ".env.local");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    if (!line.includes("=") || line.trim().startsWith("#")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i);
    if (env[k] === undefined) env[k] = line.slice(i + 1);
  }
}
env.JACE_REVIEW_WORKER = "1";

const { startReviewJobWorker } = await import(
  path.join(appDir, "agent/lib/review_job_worker.mjs")
);
await startReviewJobWorker(env);
console.log("[review-worker-entrypoint] loop started; Ctrl-C to stop.");
