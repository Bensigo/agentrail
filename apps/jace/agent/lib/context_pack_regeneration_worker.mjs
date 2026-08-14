import { hostname } from "node:os";
import { claimContextPackRegeneration, executeContextPackRegeneration } from "./context_pack_regeneration_console.mjs";
import { createContextPackRegenerationWorker } from "./context_pack_regeneration_worker.core.mjs";

export function buildContextPackRegenerationWorker(env = process.env) {
  const workerId = `context-pack-regeneration-${hostname()}-${process.pid}`;
  return createContextPackRegenerationWorker({
    claim: () => claimContextPackRegeneration({ workerId, env }),
    execute: (claim) => executeContextPackRegeneration({ claim, env }),
  });
}
