import { buildContextPackRegenerationWorker } from "../agent/lib/context_pack_regeneration_worker.mjs";
import { assertContextPackRegenerationWorkerConfig } from "../agent/lib/context_pack_regeneration_console.mjs";

if ((process.env.JACE_CONTEXT_PACK_REGENERATION_WORKER ?? "").trim() !== "1") {
  process.exitCode = 0;
} else {
  assertContextPackRegenerationWorkerConfig(process.env);
  await buildContextPackRegenerationWorker(process.env).start();
}
