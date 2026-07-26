// fetch_work_status — the coordinator's READ-ONLY window onto the workspace's
// CURRENT work in flight: in-progress and recent runs (status, phase, cost, PR
// link) plus issue-queue entries (state, tier, park reason, blockers), scoped
// to this session's workspace and optionally narrowed to one issue/PR/run via
// `ref`. This is the tool behind "how's that going" — see instructions.md's
// "Answering 'how's that going'" rule for when to call it.
//
// Auth model matches fetch_backlog.ts / fetch_workspace_memory.ts:
// JACE_CONSOLE_TOKEN is a deployment-wide secret, so this wrapper reads
// `ctx.session.id` (Eve's own opaque session id for the calling conversation —
// never model-supplied), and the core sends it as `eveSessionId` for the
// console to resolve the real tenant through the jace_sessions ledger. This
// tool NEVER takes a workspaceId argument — the only input is the optional
// `ref` the model passes to narrow the query, never to pick a tenant. All
// orchestration lives in lib/fetch_work_status.core.mjs (pure, injected
// transport); this wrapper only binds the real transport.
//
// Least privilege by construction:
//  - It writes NOTHING and sets NO `approval` — read-only tools do not gate.
//    Nothing this tool returns can be turned into a write except through the
//    SEPARATE gated tools (create_issue, update_issue, backlog_* etc.), each
//    with its own human approval.
//  - The network reach is exactly one endpoint via the global `fetch`. It does
//    NOT import node:child_process; the host/path come from configured env,
//    never from model input.
//  - On unset config or an unreachable/failing console it returns a DEGRADED
//    result (never throws, never retries), so a fetch problem can never crash
//    the turn or storm the endpoint, and can never be mistaken for a fact
//    about the work itself (see the core's DEGRADED_NOTES — they describe the
//    retrieval gap, not the work).

import { defineTool } from "eve/tools";
import { z } from "zod";
import { fetchWorkStatus } from "../lib/fetch_work_status.core.mjs";

// The REAL transport: one GET via the global fetch, narrowed to the { status,
// json } shape the core expects. Injected exactly as fetch_backlog injects its
// real driver, so the core stays hermetic in tests.
async function realTransport(
  url: string,
  init: { headers: Record<string, string> },
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const res = await fetch(url, { method: "GET", headers: init.headers });
  return { status: res.status, json: () => res.json() };
}

export default defineTool({
  description:
    "Read-only: fetch the CURRENT state of work in this workspace — in-flight " +
    "and recent runs (status, phase, cost, PR link) and issue-queue entries " +
    "(state, tier, park reason, blockers). Call this for ANY question about " +
    "how work is going, not just ones using that phrase: 'how's that going', " +
    "'did it land', 'where are we on the review', 'is it done yet', 'what's " +
    "happening with #1468', 'any progress', or a bare 'and?' after something " +
    "you took on. Pass `ref` (an issue number, PR number, or run id) to ask " +
    "about one specific item; omit it for the whole live picture. Writes " +
    "nothing and needs no approval. Returns a degraded result (never throws) " +
    "when the console is unconfigured, unreachable, or this conversation has " +
    "no workspace yet — that is an honest gap in THIS fetch, never a reason " +
    "to guess at what the factory is actually doing.",
  inputSchema: z.object({
    ref: z
      .string()
      .optional()
      .describe(
        "Optional issue number, PR number, or run id to narrow to one item. " +
          "Omit for the whole workspace's current picture.",
      ),
  }),
  async execute(input, ctx) {
    return fetchWorkStatus({
      env: process.env,
      eveSessionId: ctx.session.id,
      ref: input.ref ?? "",
      transport: realTransport,
    });
  },
});
