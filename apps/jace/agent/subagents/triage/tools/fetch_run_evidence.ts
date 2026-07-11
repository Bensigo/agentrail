// fetch_run_evidence — the triage subagent's ONE authored tool. Read-only.
//
// It GETs the failure bundle (#1146) for a run_id from the AgentRail console —
// the run row, its failure_events (bounded/secret-scrubbed evidence excerpt),
// review-gate verdicts, and the run-event timeline — plus a deterministic summary
// of which evidence sections are present vs missing. All orchestration lives in
// lib/fetch_run_evidence.core.mjs (pure, injected transport); this wrapper only
// binds the real transport.
//
// Least privilege by construction:
//  - It writes NOTHING and sets NO `approval` — read-only tools do not gate
//    (approval: always() is reserved for root's single mutating create_issue).
//  - The network reach is exactly one endpoint via the global `fetch`. It does
//    NOT import node:child_process (the no-second-write-path scan is recursive
//    over agent/ and would flag a shell-out); the model cannot use it to reach an
//    arbitrary URL — the URL is built from configured env, not from model input.
//  - On unset config or an unreachable/failing console it returns a DEGRADED
//    result (never throws, never retries), so a fetch problem can never crash the
//    one-shot task or storm the endpoint (AC5).

import { defineTool } from "eve/tools";
import { z } from "zod";
import { fetchRunEvidence } from "../lib/fetch_run_evidence.core.mjs";

// The REAL transport: one GET via the global fetch, narrowed to the { status,
// json } shape the core expects. Injected exactly as standup/create_issue inject
// their real drivers, so the core stays hermetic in tests.
async function realTransport(
  url: string,
  init: { headers: Record<string, string> },
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const res = await fetch(url, { method: "GET", headers: init.headers });
  return { status: res.status, json: () => res.json() };
}

export default defineTool({
  description:
    "Read-only: fetch the failure bundle for a run_id from the AgentRail " +
    "console — the run row, its failure_events (bounded, secret-scrubbed " +
    "evidence excerpt), review-gate verdicts, and the run-event timeline — plus " +
    "a deterministic summary of which evidence sections are present vs missing. " +
    "Writes nothing and needs no approval. Returns a degraded result (never " +
    "throws) when the console is unconfigured, unreachable, or has no evidence " +
    "for the run; treat degraded/absent evidence as an honest gap, not a cause.",
  inputSchema: z.object({
    run_id: z
      .string()
      .min(1)
      .describe("The run id to diagnose (the durable run/claim id)."),
  }),
  async execute(input) {
    return fetchRunEvidence({
      env: process.env,
      runId: input.run_id,
      transport: realTransport,
    });
  },
});
