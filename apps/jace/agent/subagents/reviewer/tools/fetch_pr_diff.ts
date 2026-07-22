// fetch_pr_diff — the reviewer subagent's ONE authored tool. Read-only.
//
// It GETs a pull request's metadata + diff from the AgentRail console — the
// title, author, base/head refs, body, and the changed files (capped at 50
// files / ~200KB of total patch text, with truncated + omittedPaths when
// capped). All orchestration lives in lib/fetch_pr_diff.core.mjs (pure,
// injected transport); this wrapper only binds the real transport and
// resolves the session id.
//
// Least privilege by construction:
//  - It writes NOTHING and sets NO `approval` — read-only tools do not gate
//    (approval gates are reserved for root's gated write tools).
//  - The network reach is exactly one endpoint via the global `fetch`. It
//    does NOT import node:child_process; the model cannot use it to reach an
//    arbitrary URL — the host/path come from configured env, never from
//    model input. The model-supplied `repo`/`prNumber` ride only as that
//    endpoint's own query params, never as (or altering) the destination.
//  - On unset config or an unreachable/failing console it returns a
//    DEGRADED result (never throws, never retries), so a fetch problem can
//    never crash the one-shot task or storm the endpoint.
//
// SESSION RESOLUTION (the one thing this tool does that its sibling
// fetch_run_evidence does not need to): this tool runs inside the `reviewer`
// DECLARED SUBAGENT, which eve gives its own CHILD session
// (node_modules/eve/docs/subagents.mdx: "Each delegated subagent spins up
// its own child session"). `ctx.session.id` here is that CHILD session's
// id — NOT the root conversation's eveSessionId the console's jace_sessions
// ledger anchors (sending it would 404 every call, same failure mode
// runner/failure-bundle's own doc-comment flags for a subagent tool).
// `ctx.session.parent.rootSessionId` (eve@0.19.0's SessionParent,
// node_modules/eve/dist/src/channel/types.d.ts) is set at dispatch to the
// TOP session's id — the SAME value root's own tools (e.g. create_repo.ts,
// post_pr_review.ts) read directly as `ctx.session.id`. So this tool sends
// `ctx.session.parent?.rootSessionId ?? ctx.session.id` (the fallback is
// defensive only — a subagent invocation should always have `parent`
// populated in practice).

import { defineTool } from "eve/tools";
import { z } from "zod";
import { fetchPrDiff } from "../lib/fetch_pr_diff.core.mjs";

// The REAL transport: one GET via the global fetch, narrowed to the
// { status, json } shape the core expects. Injected exactly as
// fetch_run_evidence/fetch_workspace_memory inject their real drivers, so
// the core stays hermetic in tests.
async function realTransport(
  url: string,
  init: { headers: Record<string, string> },
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const res = await fetch(url, { method: "GET", headers: init.headers });
  return { status: res.status, json: () => res.json() };
}

export default defineTool({
  description:
    "Read-only: fetch a pull request's metadata (title, author, base/head " +
    "refs, body) and its diff (changed files with path/status/additions/" +
    "deletions/patch) from the AgentRail console. Capped at 50 files and " +
    "~200KB of total patch text — check `truncated`/`omittedPaths` before " +
    "assuming you've seen the whole diff. Writes nothing and needs no " +
    "approval. Returns a degraded result (never throws) when the console " +
    "is unconfigured, unreachable, or the PR/repo isn't reachable from " +
    "this workspace; treat that as an honest gap, never a reason to guess " +
    "at the PR's contents.",
  inputSchema: z.object({
    repo: z.string().min(1).describe("owner/name of the reviewed repo, given to you in your task."),
    prNumber: z.number().int().positive().describe("The pull request number, given to you in your task."),
  }),
  async execute(input, ctx) {
    const eveSessionId = ctx?.session?.parent?.rootSessionId ?? ctx?.session?.id;
    return fetchPrDiff({
      env: process.env,
      eveSessionId,
      repo: input.repo,
      prNumber: input.prNumber,
      transport: realTransport,
    });
  },
});
